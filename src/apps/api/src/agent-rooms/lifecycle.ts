import { createHmac } from "crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, isAbsolute } from "path";
import type { FastifyReply } from "fastify";
import { parseProtocol, type Protocol } from "@repo/shared";
import { RoomLogger } from "./internal/room-logger.js";
import type { Room, AgentState, RoomCreateOptions, RoomCloseReason } from "./types.js";
import { pushEvent } from "./event-store.js";
import { shouldCheckCompletionAfterTaskMarker } from "./router.js";
import {
	buildPiArgs,
	spawnAgentProcess,
	sendToAgent,
	waitForAllAgentsReady,
	killAgentProcess,
} from "./spawn.js";

export const TASK_COMPLETION_MARKER = "[@TASK: VIPER-RTB]";
const idleCompletionGraceMsRaw = Number(process.env.AGENT_ROOM_IDLE_COMPLETION_MS ?? 60_000);
const IDLE_COMPLETION_GRACE_MS = Number.isFinite(idleCompletionGraceMsRaw)
	? Math.max(1000, idleCompletionGraceMsRaw)
	: 60_000;

export const rooms = new Map<string, Room>();
const EXPIRY_MS = 1000 * 60 * 60 * 2; // 2 hours

function generateId(): string {
	return `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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

export function destroyRoom(
	id: string,
	reason: Exclude<RoomCloseReason, "completed"> = "manual",
): void {
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
