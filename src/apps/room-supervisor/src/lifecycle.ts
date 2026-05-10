import { createHmac } from "crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, isAbsolute } from "path";
import { Socket } from "net";
import { parseProtocol, type Protocol } from "@repo/shared";
import type { Room, AgentState, RoomCreateOptions, RoomCloseReason, ExecutionMode, RoomStatus, RoutingStrategy } from "@repo/agent-rooms-core";
import {
	RoomLogger,
	RingBuffer,
	RoomLog,
	upsertRoom,
	getRoomIndex,
	getRoomAgentsIndex,
	listRoomsIndex,
	getRoomPromptsDir,
	getRoomProtocolPath,
	type RoomIndexRow,
} from "@repo/agent-rooms-core";
import {
	buildPiArgs,
	spawnAgentProcess,
	sendToAgent,
	waitForAllAgentsReady,
	killAgentProcess,
} from "./spawn.js";
import { pushEvent } from "./event-store.js";
import { shouldCheckCompletionAfterTaskMarker } from "./router.js";
import { writeMessage } from "@repo/agent-rooms-core";

export const TASK_COMPLETION_MARKER = "[@TASK: VIPER-RTB]";
const idleCompletionGraceMsRaw = Number(process.env.AGENT_ROOM_IDLE_COMPLETION_MS ?? 60_000);
const IDLE_COMPLETION_GRACE_MS = Number.isFinite(idleCompletionGraceMsRaw)
	? Math.max(1000, idleCompletionGraceMsRaw)
	: 60_000;

const COMPLETED_TTL_MS = Number(process.env.AGENT_ROOM_COMPLETED_TTL_MS ?? 300_000);

export const rooms = new Map<string, Room>();
const EXPIRY_MS = 1000 * 60 * 60 * 2; // 2 hours

function generateId(): string {
	return `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function generateMsgId(): string {
	return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

export function resetExpiry(room: Room): void {
	if (room.expireTimeout) clearTimeout(room.expireTimeout);
	room.expireTimeout = setTimeout(() => {
		destroyRoom(room.id, "expired");
	}, EXPIRY_MS);
}

export function updateActivity(room: Room): void {
	room.lastActivityAt = Date.now();
	resetExpiry(room);
}

function computeCallbackSignature(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function notifyRoomClosedCallback(
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

	// Phase C6: retry with exponential backoff
	const delays = [1000, 4000, 16000];
	for (let attempt = 0; attempt < delays.length; attempt++) {
		try {
			const response = await fetch(room.callbackUrl, {
				method: "POST",
				headers,
				body: payload,
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				console.info(`[agent-rooms] callback delivered for room ${room.id} (${reason})`);
				return;
			}
			console.warn(
				`[agent-rooms] callback attempt ${attempt + 1} failed for room ${room.id}: ${response.status} ${response.statusText}`,
			);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[agent-rooms] callback attempt ${attempt + 1} failed for room ${room.id}: ${message}`);
		}
		if (attempt < delays.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
		}
	}

	// Log final failure to event log
	pushEvent(room, {
		type: "room_error",
		from: "system",
		at: new Date().toISOString(),
		reason: `callback_failed: ${room.callbackUrl}`,
	});
	console.error(`[agent-rooms] callback permanently failed for room ${room.id} after ${delays.length} attempts`);
}

export function allActiveAgentsCompleted(room: Room): boolean {
	const activeAgents = Array.from(room.agents.values()).filter((a) => a.hasParticipated);
	return activeAgents.length > 0 && activeAgents.every((a) => a.taskCompleted);
}

export function areAllAgentsIdle(room: Room): boolean {
	return room.agents.size > 0 && Array.from(room.agents.values()).every((a) => a.status === "idle");
}

export function clearIdleCompletionTimeout(room: Room): void {
	if (!room.idleCompletionTimeout) return;
	clearTimeout(room.idleCompletionTimeout);
	room.idleCompletionTimeout = undefined;
}

export function scheduleIdleCompletionTimeout(room: Room): void {
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

export function handleTaskCompletionMarker(room: Room, fromAgent: string, text: string): void {
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

export interface CreateRoomDeps {
	setupAgentAfterSpawn(room: Room, agent: AgentState): void;
}

export async function createRoom(
	protocol: Protocol,
	deps: CreateRoomDeps,
	options?: RoomCreateOptions,
): Promise<{ roomId: string }> {
	const id = generateId();
	const promptDir = getRoomPromptsDir(id);
	mkdirSync(promptDir, { recursive: true });
	const bodyPromptPath = join(promptDir, "body.prompt");
	writeFileSync(bodyPromptPath, protocol.body, "utf-8");
	writeFileSync(getRoomProtocolPath(id), protocol.body, "utf-8");

	// Resolve working_dir relative to server CWD if not absolute
	const workingDir = protocol.workingDir
		? (isAbsolute(protocol.workingDir) ? protocol.workingDir : resolve(process.cwd(), protocol.workingDir))
		: undefined;

	const now = Date.now();
	const roomLog = new RoomLog(id);

	const room: Room = {
		id,
		status: "initialized",
		agents: new Map(),
		sseClients: new Set(),
		createdAt: now,
		lastActivityAt: now,
		protocolBody: protocol.body,
		routes: protocol.routes,
		facilitator: protocol.facilitator,
		routingStrategy: protocol.routes ? "explicit" : "broadcast",
		events: new RingBuffer(200),
		eventSeq: 0,
		promptDir,
		workingDir,
		idleCompletionTimeout: undefined,
		facilitatorConsecutiveOrphanFailures: 0,
		callbackUrl: options?.callbackUrl,
		callbackSecret: options?.callbackSecret,
		tag: options?.tag,
		roomLog,
	};

	upsertRoom({
		id,
		status: "initialized",
		tag: options?.tag ?? null,
		created_at: now,
		updated_at: now,
		last_activity_at: now,
		protocol_body: protocol.body,
		facilitator: protocol.facilitator ?? null,
		routing_strategy: protocol.routes ? "explicit" : "broadcast",
		failed_agent: null,
		failed_reason: null,
		callback_url: options?.callbackUrl ?? null,
		callback_secret: options?.callbackSecret ?? null,
		completed_at: null,
	});

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
			deps.setupAgentAfterSpawn(room, agent);
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

export async function createRoomFromMarkdown(
	markdown: string,
	deps: CreateRoomDeps,
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

		return await createRoom(protocol, deps, options);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failure
		}
	}
}

export function listRooms(
	status?: string,
	limit = 50,
	offset = 0,
	tag?: string,
): object[] {
	const clampedLimit = Math.max(1, Math.min(200, limit));
	const clampedOffset = Math.max(0, offset);

	// Read from persistent index DB; overlay hot in-memory rooms for live data
	const rows = listRoomsIndex(status, tag, clampedLimit, clampedOffset);
	return rows.map((row) => {
		const live = rooms.get(row.id);
		if (live) return getRoomStatus(live);
		return getRoomStatusFromIndex(row);
	});
}

function getRoomStatusFromIndex(row: RoomIndexRow): object {
	return {
		roomId: row.id,
		status: row.status,
		...(row.failed_agent ? { failedAgent: row.failed_agent, reason: row.failed_reason } : {}),
		agents: {}, // agents not loaded for cold rooms
		lastEventId: undefined,
		lastEventAt: undefined,
		lastEventType: undefined,
		lastEventFrom: undefined,
	};
}

export function getRoom(id: string): Room | undefined {
	const live = rooms.get(id);
	if (live) return live;

	// Fall back to index for completed/error rooms (reconstruct minimal Room)
	const row = getRoomIndex(id);
	if (!row || (row.status !== "completed" && row.status !== "error")) return undefined;

	const agentRows = getRoomAgentsIndex(id);
	const agents = new Map<string, AgentState>();
	for (const ar of agentRows) {
		agents.set(ar.name, {
			proc: null,
			executionMode: ar.execution_mode as ExecutionMode,
			piArgs: [],
			name: ar.name,
			role: ar.role,
			isStreaming: false,
			pendingUiRequest: false,
			status: ar.status as AgentState["status"],
			logger: new RoomLogger(ar.name),
			_textBuf: "",
			_thinkingBuf: "",
			_msgTs: 0,
			ready: Boolean(ar.ready),
			taskCompleted: Boolean(ar.task_completed),
			hasParticipated: Boolean(ar.has_participated),
		});
	}

	const room: Room = {
		id,
		status: row.status as RoomStatus,
		agents,
		sseClients: new Set(),
		createdAt: row.created_at,
		lastActivityAt: row.last_activity_at,
		protocolBody: row.protocol_body ?? "",
		facilitator: row.facilitator ?? undefined,
		routingStrategy: (row.routing_strategy as RoutingStrategy) ?? "broadcast",
		failedAgent: row.failed_agent ?? undefined,
		failedReason: row.failed_reason ?? undefined,
		events: new RingBuffer(200),
		eventSeq: 0,
		promptDir: getRoomPromptsDir(id),
		callbackUrl: row.callback_url ?? undefined,
		callbackSecret: row.callback_secret ?? undefined,
		tag: row.tag ?? undefined,
		roomLog: new RoomLog(id),
	};
	return room;
}

export function getRoomStatus(room: Room): object {
	const agentStatuses: Record<string, { status: string }> = {};
	for (const [name, agent] of room.agents) {
		agentStatuses[name] = { status: agent.status };
	}
	const lastEvent = room.events.newest;
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

export function scheduleRoomEviction(room: Room): void {
	if (room.completedTtlTimer) clearTimeout(room.completedTtlTimer);
	room.completedTtlTimer = setTimeout(() => {
		const current = rooms.get(room.id);
		if (current && (current.status === "completed" || current.status === "error")) {
			rooms.delete(room.id);
			console.info(`[agent-rooms] room evicted from RAM after TTL: ${room.id}`);
		}
	}, COMPLETED_TTL_MS);
}

export function destroyRoom(
	id: string,
	reason: Exclude<RoomCloseReason, "completed"> = "manual",
): void {
	const room = rooms.get(id);
	if (!room) return;

	// Already soft-closed — just hard-delete from the registry
	if (room.status === "completed" || room.status === "error") {
		if (room.completedTtlTimer) clearTimeout(room.completedTtlTimer);
		rooms.delete(id);
		return;
	}

	if (room.expireTimeout) clearTimeout(room.expireTimeout);
	clearIdleCompletionTimeout(room);
	if (room.completedTtlTimer) clearTimeout(room.completedTtlTimer);

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

	// Broadcast room_closed to IPC subscribers
	for (const client of room.sseClients) {
		try {
			writeMessage(client as Socket, {
				id: generateMsgId(),
				type: "event",
				payload: { type: "room_closed", reason },
			});
		} catch {
			// ignore
		}
	}

	console.info(`[agent-rooms] room closed: ${room.id} (${reason})`);
	room.sseClients.clear();
	room.agents.clear();
	room.status = "error";
	room.failedReason = reason;

	// Persist final state
	room.roomLog.flush();
	upsertRoom({
		id: room.id,
		status: "error",
		tag: room.tag ?? null,
		created_at: room.createdAt,
		updated_at: Date.now(),
		last_activity_at: room.lastActivityAt,
		protocol_body: room.protocolBody,
		facilitator: room.facilitator ?? null,
		routing_strategy: room.routingStrategy,
		failed_agent: null,
		failed_reason: reason,
		callback_url: room.callbackUrl ?? null,
		callback_secret: room.callbackSecret ?? null,
		completed_at: null,
	});

	rooms.delete(id);
}

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

	// Broadcast room_closed to IPC subscribers
	for (const client of room.sseClients) {
		try {
			writeMessage(client as Socket, {
				id: generateMsgId(),
				type: "event",
				payload: { type: "room_closed", reason: "completed" },
			});
		} catch {
			// ignore
		}
	}

	console.info(`[agent-rooms] room completed: ${room.id}`);
	room.sseClients.clear();
	room.agents.clear();
	room.status = "completed";
	scheduleRoomEviction(room);

	// Persist final state
	room.roomLog.flush();
	upsertRoom({
		id: room.id,
		status: "completed",
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
		completed_at: Date.now(),
	});
}

export function shutdownAllRooms(): void {
	for (const room of rooms.values()) {
		if (room.expireTimeout) clearTimeout(room.expireTimeout);
		clearIdleCompletionTimeout(room);
		if (room.completedTtlTimer) clearTimeout(room.completedTtlTimer);

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
				(client as Socket).end();
			} catch {
				// ignore
			}
		}

		room.sseClients.clear();
		room.agents.clear();
		room.roomLog.flush();
	}
	rooms.clear();
}
