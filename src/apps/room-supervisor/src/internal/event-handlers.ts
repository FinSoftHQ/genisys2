import { attachJsonlReader } from "./jsonl.js";
import { loggingEnabled, upsertAgent, upsertRoom } from "@repo/agent-rooms-core";
import type { Room, AgentState } from "@repo/agent-rooms-core";
import { pushEvent, broadcast } from "../event-store.js";
import { routeMessageToAgents } from "../router.js";
import { sendToAgent, terminateSingleShotAgent } from "../spawn.js";
import {
	TASK_COMPLETION_MARKER,
	clearIdleCompletionTimeout,
	scheduleIdleCompletionTimeout,
	scheduleRoomEviction,
	handleTaskCompletionMarker,
	updateActivity,
} from "../lifecycle.js";

function safeUpsertRoom(row: import("@repo/agent-rooms-core").RoomIndexRow): void {
	try {
		upsertRoom(row);
	} catch {
		// ignore transient db lifecycle races during shutdown/tests
	}
}

function safeUpsertAgent(row: import("@repo/agent-rooms-core").AgentIndexRow): void {
	try {
		upsertAgent(row);
	} catch {
		// ignore transient db lifecycle races during shutdown/tests
	}
}

export function attachAgentEventHandlers(
	room: Room,
	agent: AgentState,
	spawnAndSendToSingleShot: (room: Room, agentName: string, message: string) => Promise<void>,
): void {
	if (!agent.proc) return;
	const proc = agent.proc;
	const name = agent.name;

	proc.on("exit", (code) => {
		// agent.proc !== proc means terminateSingleShotAgent already set agent.proc = null
		// (or a re-spawn replaced it) before calling kill(). The old process exiting is
		// expected — do NOT treat it as an error regardless of exit code.
		// NOTE: pi's RPC SIGTERM handler calls process.exit(143), so code is 143 (not null).
		// Checking code === null would always miss and fall through to the error branch.
		if (agent.executionMode === "single-shot" && agent.proc !== proc) {
			return;
		}

		if (room.status === "completed") return;
		if (!agent.ready) {
			if (agent._readyTimeout) clearTimeout(agent._readyTimeout);
			agent._readyReject?.(new Error(`Agent ${name} process exited before ready`));
		}
		if (code !== 0 && code !== null) {
			agent.status = "error";
			room.status = "error";
			room.failedAgent = name;
			room.failedReason = `Process exited with code ${String(code)}`;
			safeUpsertAgent({
				room_id: room.id,
				name,
				role: agent.role,
				execution_mode: agent.executionMode,
				status: "error",
				ready: agent.ready ? 1 : 0,
				task_completed: agent.taskCompleted ? 1 : 0,
				has_participated: agent.hasParticipated ? 1 : 0,
			});
			safeUpsertRoom({
				id: room.id,
				status: "error",
				tag: room.tag ?? null,
				created_at: room.createdAt,
				updated_at: Date.now(),
				last_activity_at: room.lastActivityAt,
				protocol_body: room.protocolBody,
				facilitator: room.facilitator ?? null,
				routing_strategy: room.routingStrategy,
				failed_agent: name,
				failed_reason: room.failedReason,
				callback_url: room.callbackUrl ?? null,
				callback_secret: room.callbackSecret ?? null,
				completed_at: null,
			});
			const reason = room.failedReason;
			const stored = pushEvent(room, { type: "room_error", from: name, at: new Date().toISOString(), reason });
			broadcast(room, "storedevent", stored);
			broadcast(room, "raw", { type: "room_error", from: name, reason });
			scheduleRoomEviction(room);
		}
	});

	proc.on("error", (err) => {
		if (!agent.ready) {
			if (agent._readyTimeout) clearTimeout(agent._readyTimeout);
			agent._readyReject?.(new Error(`Agent ${name} process failed to start: ${err.message}`));
		}
		agent.status = "error";
		room.status = "error";
		room.failedAgent = name;
		room.failedReason = err.message;
		safeUpsertAgent({
			room_id: room.id,
			name,
			role: agent.role,
			execution_mode: agent.executionMode,
			status: "error",
			ready: agent.ready ? 1 : 0,
			task_completed: agent.taskCompleted ? 1 : 0,
			has_participated: agent.hasParticipated ? 1 : 0,
		});
		safeUpsertRoom({
			id: room.id,
			status: "error",
			tag: room.tag ?? null,
			created_at: room.createdAt,
			updated_at: Date.now(),
			last_activity_at: room.lastActivityAt,
			protocol_body: room.protocolBody,
			facilitator: room.facilitator ?? null,
			routing_strategy: room.routingStrategy,
			failed_agent: name,
			failed_reason: err.message,
			callback_url: room.callbackUrl ?? null,
			callback_secret: room.callbackSecret ?? null,
			completed_at: null,
		});
		const stored = pushEvent(room, { type: "room_error", from: name, at: new Date().toISOString(), reason: err.message });
		broadcast(room, "storedevent", stored);
		broadcast(room, "raw", { type: "room_error", from: name, reason: err.message });
		scheduleRoomEviction(room);
	});

	attachJsonlReader(proc.stdout!, (line) => {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		const type = event.type as string;

		if (loggingEnabled) {
			switch (type) {
				case "message_start":
					agent.logger.onMessageStart(
						event.message as { role?: string; timestamp?: number },
					);
					break;
				case "message_update":
					agent.logger.onMessageUpdate(
						event as {
							assistantMessageEvent?: {
								type: string;
								delta?: string;
							};
						},
					);
					break;
				case "message_end":
					agent.logger.onMessageEnd(
						event.message as {
							role?: string;
							stopReason?: string;
							errorMessage?: string;
						},
					);
					break;
				case "tool_execution_start":
					agent.logger.onToolExecutionStart(
						String(event.toolName),
						event.args,
					);
					break;
				case "tool_execution_end":
					agent.logger.onToolExecutionEnd(
						String(event.toolName),
						event.result,
						Boolean(event.isError),
					);
					break;
				case "auto_retry_start":
					agent.logger.onAutoRetryStart(
						Number(event.attempt),
						Number(event.maxAttempts),
						Number(event.delayMs),
						String(event.errorMessage),
					);
					break;
				case "auto_retry_end":
					agent.logger.onAutoRetryEnd(
						Boolean(event.success),
						Number(event.attempt),
						event.finalError
							? String(event.finalError)
							: undefined,
					);
					break;
				default:
					break;
			}
		}

		// ── Event storage (coalesced, mirrors RoomLogger output) ─────────────
		const now = new Date().toISOString();
		const appendStoredEvent = (eventToStore: import("@repo/agent-rooms-core").StoredEventInput): void => {
			const stored = pushEvent(room, eventToStore);
			broadcast(room, "storedevent", stored);
		};
		let messageText = "";
		switch (type) {
			case "message_start": {
				const msg = event.message as { role?: string; timestamp?: number } | undefined;
				if (msg?.role === "assistant") {
					agent._textBuf = "";
					agent._thinkingBuf = "";
					agent._msgTs = msg.timestamp ?? Date.now();
				}
				break;
			}
			case "message_update": {
				const ame = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
				if (!ame) break;
				switch (ame.type) {
					case "text_delta": agent._textBuf += ame.delta ?? ""; break;
					case "thinking_start": agent._thinkingBuf = ""; break;
					case "thinking_delta": agent._thinkingBuf += ame.delta ?? ""; break;
					case "thinking_end":
						if (agent._thinkingBuf) {
							appendStoredEvent({ type: "thinking", from: name, at: new Date(agent._msgTs).toISOString(), thinking: agent._thinkingBuf });
							agent._thinkingBuf = "";
						}
						break;
					default: break;
				}
				break;
			}
			case "message_end": {
				const msg = event.message as { role?: string } | undefined;
				if (msg?.role === "assistant") {
					if (agent._thinkingBuf) {
						appendStoredEvent({ type: "thinking", from: name, at: new Date(agent._msgTs).toISOString(), thinking: agent._thinkingBuf });
						agent._thinkingBuf = "";
					}
					if (agent._textBuf) {
						appendStoredEvent({ type: "message", from: name, at: new Date(agent._msgTs).toISOString(), text: agent._textBuf });
						messageText = agent._textBuf;
						agent._textBuf = "";
					}
					if (messageText.includes(TASK_COMPLETION_MARKER)) {
						handleTaskCompletionMarker(room, name, messageText);
						if (agent.executionMode === "single-shot" && agent.proc) {
							terminateSingleShotAgent(agent);
						}
					}
				}
				break;
			}
			case "tool_execution_start":
				appendStoredEvent({ type: "tool_start", from: name, at: now, toolName: String(event.toolName), args: event.args });
				break;
			case "tool_execution_end": {
				const res = event.result;
				let resultText = "";
				if (res && typeof res === "object" && "content" in res && Array.isArray((res as { content?: unknown }).content)) {
					for (const block of (res as { content: Array<{ type?: string; text?: string }> }).content) {
						if (block.type === "text" && block.text) resultText += block.text;
					}
				} else if (typeof res === "string") {
					resultText = res;
				} else if (res !== undefined && res !== null) {
					resultText = JSON.stringify(res);
				}
				appendStoredEvent({ type: "tool_end", from: name, at: now, toolName: String(event.toolName), result: resultText, isError: Boolean(event.isError) });
				break;
			}
			case "auto_retry_start":
				appendStoredEvent({ type: "retry_start", from: name, at: now, attempt: Number(event.attempt), maxAttempts: Number(event.maxAttempts), delayMs: Number(event.delayMs), errorMessage: String(event.errorMessage) });
				break;
			case "auto_retry_end":
				appendStoredEvent({ type: "retry_end", from: name, at: now, success: Boolean(event.success), attempt: Number(event.attempt), ...(event.finalError ? { finalError: String(event.finalError) } : {}) });
				break;
			case "agent_start":
				appendStoredEvent({ type: "agent_start", from: name, at: now });
				break;
			case "agent_end":
				appendStoredEvent({ type: "agent_end", from: name, at: now });
				break;
			default: break;
		}

		// ── Agent status bookkeeping ──────────────────────────────────────────
		switch (type) {
			case "agent_start":
				agent.isStreaming = true;
				agent.status = "streaming";
				agent.hasParticipated = true;
				room.status = "running";
				safeUpsertAgent({
					room_id: room.id,
					name,
					role: agent.role,
					execution_mode: agent.executionMode,
					status: "streaming",
					ready: agent.ready ? 1 : 0,
					task_completed: agent.taskCompleted ? 1 : 0,
					has_participated: 1,
				});
				safeUpsertRoom({
					id: room.id,
					status: "running",
					tag: room.tag ?? null,
					created_at: room.createdAt,
					updated_at: Date.now(),
					last_activity_at: room.lastActivityAt,
					protocol_body: room.protocolBody,
					facilitator: room.facilitator ?? null,
					routing_strategy: room.routingStrategy,
					failed_agent: null,
					failed_reason: null,
					callback_url: room.callbackUrl ?? null,
					callback_secret: room.callbackSecret ?? null,
					completed_at: null,
				});
				clearIdleCompletionTimeout(room);
				break;
			case "agent_end":
				agent.isStreaming = false;
				agent.status = "idle";
				safeUpsertAgent({
					room_id: room.id,
					name,
					role: agent.role,
					execution_mode: agent.executionMode,
					status: "idle",
					ready: agent.ready ? 1 : 0,
					task_completed: agent.taskCompleted ? 1 : 0,
					has_participated: agent.hasParticipated ? 1 : 0,
				});
				scheduleIdleCompletionTimeout(room);
				break;
			case "response":
				if (event.command === "get_state" && event.success && !agent.ready) {
					agent.ready = true;
					safeUpsertAgent({
						room_id: room.id,
						name,
						role: agent.role,
						execution_mode: agent.executionMode,
						status: agent.status,
						ready: 1,
						task_completed: agent.taskCompleted ? 1 : 0,
						has_participated: agent.hasParticipated ? 1 : 0,
					});
					if (agent._readyTimeout) clearTimeout(agent._readyTimeout);
					agent._readyResolve?.();
				}
				if (!event.success) {
					// non-fatal command error
				}
				break;
			default:
				break;
		}

		updateActivity(room);
		broadcast(room, "raw", { from: name, ...event });

		// ── Inter-agent routing ───────────────────────────────────────────────
		if (type === "message_end" && messageText && room.status !== "completed" && room.status !== "error") {
			routeMessageToAgents(room, name, messageText, {
				sendToAgent,
				clearIdleCompletionTimeout,
				spawnAndSendToSingleShot,
			});
		}
	});
}
