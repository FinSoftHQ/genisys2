import { createHmac } from "crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, isAbsolute } from "path";
import type { FastifyReply } from "fastify";
import { parseProtocol, type Protocol } from "@repo/shared";
import { attachJsonlReader } from "./internal/jsonl.js";
import { RoomLogger, loggingEnabled } from "./internal/room-logger.js";
import {
	type Room,
	type AgentState,
	type RoomCreateOptions,
	type RoomCloseReason,
} from "./types.js";
import { pushEvent, broadcast } from "./event-store.js";
import { routeMessageToAgents, shouldCheckCompletionAfterTaskMarker } from "./router.js";
import {
	killAgentProcess,
	sendToAgent,
	buildPiArgs,
	spawnAgentProcess,
	terminateSingleShotAgent,
	waitForAllAgentsReady,
} from "./spawn.js";

// Re-export types and event-store for backward compatibility during transition
export type {
	Room,
	RoomStatus,
	RoomCreateOptions,
	StoredEvent,
	StoredEventInput,
	AgentState,
	RoutingStrategy,
	RoomCloseReason,
	ExecutionMode,
	ReturnedEvent,
} from "./types.js";
export { pushEvent, broadcast, getRoomEvents } from "./event-store.js";
export {
	determineRecipients,
	resolveMessageTargets,
	shouldCheckCompletionAfterTaskMarker,
	routeMessageToAgents,
} from "./router.js";
export type { RouterDeps } from "./router.js";

const TASK_COMPLETION_MARKER = "[@TASK: VIPER-RTB]";
const idleCompletionGraceMsRaw = Number(process.env.AGENT_ROOM_IDLE_COMPLETION_MS ?? 60_000);
const IDLE_COMPLETION_GRACE_MS = Number.isFinite(idleCompletionGraceMsRaw)
	? Math.max(1000, idleCompletionGraceMsRaw)
	: 60_000;

const rooms = new Map<string, Room>();
const EXPIRY_MS = 1000 * 60 * 60 * 2; // 2 hours

function generateId(): string {
	return `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function resetExpiry(room: Room): void {
	if (room.expireTimeout) clearTimeout(room.expireTimeout);
	room.expireTimeout = setTimeout(() => {
		destroyRoom(room.id, "expired");
	}, EXPIRY_MS);
}

function updateActivity(room: Room): void {
	room.lastActivityAt = Date.now();
	resetExpiry(room);
}

function computeCallbackSignature(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

async function notifyRoomClosedCallback(
	room: Room,
	reason: RoomCloseReason,
	at: string,
): Promise<void> {
	if (!room.callbackUrl) return;

	const payload = JSON.stringify({
		type: "room_closed",
		roomId: room.id,
		reason,
		at,
	});
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (room.callbackSecret) {
		headers["x-signature"] = computeCallbackSignature(payload, room.callbackSecret);
	}

	try {
		const response = await fetch(room.callbackUrl, {
			method: "POST",
			headers,
			body: payload,
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			console.warn(
				`[agent-rooms] callback failed for room ${room.id}: ${response.status} ${response.statusText}`,
			);
			return;
		}
		console.info(`[agent-rooms] callback delivered for room ${room.id} (${reason})`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[agent-rooms] callback failed for room ${room.id}: ${message}`);
	}
}

function allActiveAgentsCompleted(room: Room): boolean {
	const activeAgents = Array.from(room.agents.values()).filter((a) => a.hasParticipated);
	return activeAgents.length > 0 && activeAgents.every((a) => a.taskCompleted);
}

function areAllAgentsIdle(room: Room): boolean {
	return room.agents.size > 0 && Array.from(room.agents.values()).every((a) => a.status === "idle");
}

function clearIdleCompletionTimeout(room: Room): void {
	if (!room.idleCompletionTimeout) return;
	clearTimeout(room.idleCompletionTimeout);
	room.idleCompletionTimeout = undefined;
}

function scheduleIdleCompletionTimeout(room: Room): void {
	if (room.status !== "running") return;
	if (!areAllAgentsIdle(room)) {
		clearIdleCompletionTimeout(room);
		return;
	}
	if (room.idleCompletionTimeout) return;

	room.idleCompletionTimeout = setTimeout(() => {
		room.idleCompletionTimeout = undefined;
		const current = rooms.get(room.id);
		if (!current) return;
		if (current.status !== "running") return;
		if (!areAllAgentsIdle(current)) return;
		completeRoom(current.id);
	}, IDLE_COMPLETION_GRACE_MS);
}

function handleTaskCompletionMarker(room: Room, fromAgent: string, text: string): void {
	const agent = room.agents.get(fromAgent);
	if (!agent) return;

	agent.taskCompleted = true;
	agent.hasParticipated = true;

	if (!shouldCheckCompletionAfterTaskMarker(room, fromAgent, text)) {
		return;
	}

	if (allActiveAgentsCompleted(room)) {
		completeRoom(room.id);
	}
}

export async function createRoomFromMarkdown(
	markdown: string,
	options?: RoomCreateOptions,
): Promise<{ roomId: string }> {
	const dir = mkdtempSync(join(tmpdir(), "piroom-"));
	const filePath = join(dir, "protocol.md");
	writeFileSync(filePath, markdown, "utf-8");
	try {
		let protocol = parseProtocol(filePath, { requireTeam: false });

		// Merge defaults from tailor_shop/working_protocol.md when present
		if (protocol.tailorShop) {
			const resolvedTailorShop = isAbsolute(protocol.tailorShop)
				? protocol.tailorShop
				: resolve(process.cwd(), protocol.tailorShop);
			const workingPath = join(resolvedTailorShop, "working_protocol.md");
			if (existsSync(workingPath)) {
				const defaults = parseProtocol(workingPath, { requireTeam: false });
				if (Object.keys(protocol.team).length === 0 && Object.keys(defaults.team).length > 0) {
					protocol = { ...protocol, team: defaults.team };
				}
				if (!protocol.routes && defaults.routes) {
					protocol = { ...protocol, routes: defaults.routes };
				}
				if (!protocol.facilitator && defaults.facilitator) {
					protocol = { ...protocol, facilitator: defaults.facilitator };
				}
				if (!protocol.instructions && defaults.instructions) {
					protocol = { ...protocol, instructions: defaults.instructions };
				} else if (protocol.instructions && defaults.instructions) {
					protocol = { ...protocol, instructions: { ...defaults.instructions, ...protocol.instructions } };
				}
				if (!protocol.workingDir && defaults.workingDir) {
					protocol = { ...protocol, workingDir: defaults.workingDir };
				}
			}
		}

		if (Object.keys(protocol.team).length === 0) {
			throw new Error("No team members found in front matter or working_protocol.md defaults");
		}

		return await createRoom(protocol, options);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failure
		}
	}
}

function setupAgentAfterSpawn(room: Room, agent: AgentState): void {
	attachAgentEventHandlers(room, agent);
	sendToAgent(agent, { type: "get_state" });
	if (agent._readyTimeout) clearTimeout(agent._readyTimeout);
	agent._readyTimeout = setTimeout(() => {
		agent._readyReject?.(new Error(`Agent ${agent.name} did not become ready in time`));
	}, 30000);
}

function attachAgentEventHandlers(room: Room, agent: AgentState): void {
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

async function spawnAndSendToSingleShot(
	room: Room,
	agentName: string,
	message: string,
): Promise<void> {
	const agent = room.agents.get(agentName);
	if (!agent || agent.executionMode !== "single-shot" || agent.proc !== null) return;

	agent.taskCompleted = false;
	agent.ready = false;
	agent._readyTimeout = undefined;

	spawnAgentProcess(room, agent);
	setupAgentAfterSpawn(room, agent);

	await new Promise<void>((resolve, reject) => {
		agent._readyResolve = resolve;
		agent._readyReject = reject;
	});

	sendToAgent(agent, { type: "prompt", message });
}

export async function createRoom(
	protocol: Protocol,
	options?: RoomCreateOptions,
): Promise<{ roomId: string }> {
	const id = generateId();
	const promptDir = mkdtempSync(join(tmpdir(), `piroom-${id}-`));
	const bodyPromptPath = join(promptDir, "body.prompt");
	writeFileSync(bodyPromptPath, protocol.body, "utf-8");

	// Resolve working_dir relative to server CWD if not absolute
	const workingDir = protocol.workingDir
		? (isAbsolute(protocol.workingDir) ? protocol.workingDir : resolve(process.cwd(), protocol.workingDir))
		: undefined;

	const room: Room = {
		id,
		status: "initialized",
		agents: new Map(),
		sseClients: new Set(),
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		protocolBody: protocol.body,
		routes: protocol.routes,
		facilitator: protocol.facilitator,
		routingStrategy: protocol.routes ? "explicit" : "broadcast",
		events: [],
		eventSeq: 0,
		promptDir,
		workingDir,
		idleCompletionTimeout: undefined,
		callbackUrl: options?.callbackUrl,
		callbackSecret: options?.callbackSecret,
	};

	for (const [name, role] of Object.entries(protocol.team)) {
		const { args, executionMode } = buildPiArgs(
			name,
			role,
			protocol.tailorShop,
			bodyPromptPath,
			promptDir,
			workingDir,
		);

		const agent: AgentState = {
			proc: null,
			executionMode,
			piArgs: args,
			name,
			role,
			isStreaming: false,
			pendingUiRequest: false,
			status: "idle",
			logger: new RoomLogger(name),
			_textBuf: "",
			_thinkingBuf: "",
			_msgTs: 0,
			ready: executionMode === "single-shot",
			taskCompleted: false,
			hasParticipated: false,
		};

		room.agents.set(name, agent);

		if (executionMode === "session") {
			spawnAgentProcess(room, agent);
			setupAgentAfterSpawn(room, agent);
		}
	}

	// Wait for all session agents to be ready before dispatching instructions
	await waitForAllAgentsReady(room);

	if (protocol.instructions) {
		clearIdleCompletionTimeout(room);
		for (const [agentName, message] of Object.entries(protocol.instructions)) {
			const agent = room.agents.get(agentName);
			if (agent) {
				sendToAgent(agent, { type: "prompt", message });
			} else {
				console.warn("[agent-rooms] instruction target not found:", agentName);
			}
		}
	}

	resetExpiry(room);
	rooms.set(id, room);
	return { roomId: id };
}

export function listRooms(
	status?: string,
	limit = 50,
	offset = 0,
): object[] {
	let values = Array.from(rooms.values());
	if (status !== undefined) {
		values = values.filter((room) => room.status === status);
	}
	const clampedLimit = Math.max(1, Math.min(200, limit));
	const clampedOffset = Math.max(0, offset);
	return values.slice(clampedOffset, clampedOffset + clampedLimit).map(getRoomStatus);
}

export function getRoom(id: string): Room | undefined {
	return rooms.get(id);
}

export function getRoomStatus(room: Room): object {
	const agentStatuses: Record<string, { status: string }> = {};
	for (const [name, agent] of room.agents) {
		agentStatuses[name] = { status: agent.status };
	}
	const lastEvent = room.events.length > 0 ? room.events[room.events.length - 1] : undefined;
	return {
		roomId: room.id,
		status: room.status,
		...(room.failedAgent
			? { failedAgent: room.failedAgent, reason: room.failedReason }
			: {}),
		agents: agentStatuses,
		...(lastEvent
			? {
					lastEventId: lastEvent.id,
					lastEventAt: lastEvent.at,
					lastEventType: lastEvent.type,
					lastEventFrom: lastEvent.from,
				}
			: {}),
	};
}

export function addSseClient(room: Room, reply: FastifyReply): void {
	room.sseClients.add(reply);
	reply.raw.on("close", () => {
		room.sseClients.delete(reply);
	});
}

export function removeSseClient(room: Room, reply: FastifyReply): void {
	room.sseClients.delete(reply);
}

export async function sendInstructions(
	room: Room,
	targetAgent: string,
	followUp: string[],
): Promise<{ queuedItems: number }> {
	if (room.status === "completed") {
		throw new Error("Room is completed");
	}

	await waitForAllAgentsReady(room);

	const agent = room.agents.get(targetAgent);
	if (!agent) {
		throw new Error(`Agent ${targetAgent} not found in room`);
	}

	clearIdleCompletionTimeout(room);
	for (const message of followUp) {
		sendToAgent(agent, {
			type: agent.isStreaming ? "follow_up" : "prompt",
			message,
		});
	}

	updateActivity(room);
	return { queuedItems: followUp.length };
}

export function destroyRoom(id: string, reason: Exclude<RoomCloseReason, "completed"> = "manual"): void {
	const room = rooms.get(id);
	if (!room) return;

	// Already soft-closed — just hard-delete from the registry
	if (room.status === "completed" || room.status === "error") {
		rooms.delete(id);
		return;
	}

	if (room.expireTimeout) clearTimeout(room.expireTimeout);
	clearIdleCompletionTimeout(room);

	const closedAt = new Date().toISOString();
	void notifyRoomClosedCallback(room, reason, closedAt);

	for (const agent of room.agents.values()) {
		if (!agent.proc) continue;
		try {
			sendToAgent(agent, { type: "abort" });
			agent.proc.stdin!.end();
			killAgentProcess(agent.proc);
		} catch {
			// ignore
		}
	}

	for (const client of room.sseClients) {
		try {
			client.raw.write(
				`event: message\ndata: ${JSON.stringify({ type: "room_closed", reason })}\n\n`,
			);
			client.raw.end();
		} catch {
			// ignore
		}
	}

	console.info(`[agent-rooms] room closed: ${room.id} (${reason})`);
	room.sseClients.clear();
	room.agents.clear();
	rooms.delete(id);

	try {
		rmSync(room.promptDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup failure
	}
}

// Re-export spawn symbols for backward compatibility during transition
export {
	killAgentProcess,
	sendToAgent,
	buildPiArgs,
	spawnAgentProcess,
	terminateSingleShotAgent,
	waitForAllAgentsReady,
} from "./spawn.js";
export { clearIdleCompletionTimeout, spawnAndSendToSingleShot };

export function completeRoom(id: string): void {
	const room = rooms.get(id);
	if (!room) return;
	if (room.status === "completed" || room.status === "error") return;
	clearIdleCompletionTimeout(room);

	const closedAt = new Date().toISOString();
	pushEvent(room, {
		type: "room_closed",
		from: "system",
		at: closedAt,
		reason: "completed",
	});
	void notifyRoomClosedCallback(room, "completed", closedAt);

	for (const agent of room.agents.values()) {
		if (!agent.proc) continue;
		try {
			sendToAgent(agent, { type: "abort" });
			agent.proc.stdin!.end();
			killAgentProcess(agent.proc);
		} catch {
			// ignore
		}
	}

	for (const client of room.sseClients) {
		try {
			client.raw.write(
				`event: message\ndata: ${JSON.stringify({ type: "room_closed", reason: "completed" })}\n\n`,
			);
			client.raw.end();
		} catch {
			// ignore
		}
	}

	console.info(`[agent-rooms] room completed: ${room.id}`);
	room.sseClients.clear();
	room.agents.clear();
	room.status = "completed";

	try {
		rmSync(room.promptDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup failure
	}
}
