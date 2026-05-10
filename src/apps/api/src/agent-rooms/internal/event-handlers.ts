import { attachJsonlReader } from "./jsonl.js";
import { loggingEnabled } from "./room-logger.js";
import type { Room, AgentState } from "../types.js";
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
			const reason = room.failedReason;
			pushEvent(room, { type: "room_error", from: name, at: new Date().toISOString(), reason });
			broadcast(room, { type: "room_error", from: name, reason });
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
		pushEvent(room, { type: "room_error", from: name, at: new Date().toISOString(), reason: err.message });
		broadcast(room, { type: "room_error", from: name, reason: err.message });
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
							pushEvent(room, { type: "thinking", from: name, at: new Date(agent._msgTs).toISOString(), thinking: agent._thinkingBuf });
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
						pushEvent(room, { type: "thinking", from: name, at: new Date(agent._msgTs).toISOString(), thinking: agent._thinkingBuf });
						agent._thinkingBuf = "";
					}
					if (agent._textBuf) {
						pushEvent(room, { type: "message", from: name, at: new Date(agent._msgTs).toISOString(), text: agent._textBuf });
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
				pushEvent(room, { type: "tool_start", from: name, at: now, toolName: String(event.toolName), args: event.args });
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
				pushEvent(room, { type: "tool_end", from: name, at: now, toolName: String(event.toolName), result: resultText, isError: Boolean(event.isError) });
				break;
			}
			case "auto_retry_start":
				pushEvent(room, { type: "retry_start", from: name, at: now, attempt: Number(event.attempt), maxAttempts: Number(event.maxAttempts), delayMs: Number(event.delayMs), errorMessage: String(event.errorMessage) });
				break;
			case "auto_retry_end":
				pushEvent(room, { type: "retry_end", from: name, at: now, success: Boolean(event.success), attempt: Number(event.attempt), ...(event.finalError ? { finalError: String(event.finalError) } : {}) });
				break;
			case "agent_start":
				pushEvent(room, { type: "agent_start", from: name, at: now });
				break;
			case "agent_end":
				pushEvent(room, { type: "agent_end", from: name, at: now });
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
				clearIdleCompletionTimeout(room);
				break;
			case "agent_end":
				agent.isStreaming = false;
				agent.status = "idle";
				scheduleIdleCompletionTimeout(room);
				break;
			case "response":
				if (event.command === "get_state" && event.success && !agent.ready) {
					agent.ready = true;
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
		broadcast(room, { from: name, ...event });

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
