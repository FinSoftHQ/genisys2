import { spawn, ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FastifyReply } from "fastify";
import { parseProtocol, type Protocol, parseAgentPromptFile } from "@repo/shared";
import { attachJsonlReader } from "../squads/jsonl.js";
import { SquadLogger, loggingEnabled } from "../squads/logger.js";

export type RoomStatus =
	| "initialized"
	| "running"
	| "suspended"
	| "error"
	| "completed";

const EVENT_BUFFER_CAP = 2500;

type StoredEventBase = { id: number; from: string; at: string };

export type StoredEvent =
	| (StoredEventBase & { type: "thinking"; thinking: string })
	| (StoredEventBase & { type: "message"; text: string })
	| (StoredEventBase & { type: "tool_start"; toolName: string; args: unknown })
	| (StoredEventBase & { type: "tool_end"; toolName: string; result: string; isError: boolean })
	| (StoredEventBase & { type: "retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string })
	| (StoredEventBase & { type: "retry_end"; success: boolean; attempt: number; finalError?: string })
	| (StoredEventBase & { type: "agent_start" })
	| (StoredEventBase & { type: "agent_end" })
	| (StoredEventBase & { type: "room_error"; reason: string });

// Distributive Omit so pushEvent accepts each union member without the id field.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type StoredEventInput = DistributiveOmit<StoredEvent, "id">;

interface AgentState {
	proc: ChildProcess;
	name: string;
	role: string;
	isStreaming: boolean;
	pendingUiRequest: boolean;
	status: "idle" | "streaming" | "error";
	logger: SquadLogger;
	// Event coalescing buffers (mirrors SquadLogger internals)
	_textBuf: string;
	_thinkingBuf: string;
	_msgTs: number;
}

export type RoutingStrategy = "broadcast" | "mention" | "custom";

interface Room {
	id: string;
	status: RoomStatus;
	agents: Map<string, AgentState>;
	sseClients: Set<FastifyReply>;
	createdAt: number;
	lastActivityAt: number;
	protocolBody: string;
	routes?: Record<string, string[]>;
	routingStrategy: RoutingStrategy;
	failedAgent?: string;
	failedReason?: string;
	expireTimeout?: ReturnType<typeof setTimeout>;
	events: StoredEvent[];
	eventSeq: number;
	promptDir: string;
}

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

function pushEvent(room: Room, event: StoredEventInput): void {
	room.eventSeq += 1;
	const record = { id: room.eventSeq, ...event } as StoredEvent;
	room.events.push(record);
	if (room.events.length > EVENT_BUFFER_CAP) {
		room.events.shift();
	}
}

function updateActivity(room: Room): void {
	room.lastActivityAt = Date.now();
	resetExpiry(room);
}

function broadcast(room: Room, payload: object): void {
	const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const client of room.sseClients) {
		try {
			client.raw.write(data);
		} catch {
			// ignore
		}
	}
}

function sendToAgent(agent: AgentState, cmd: object): void {
	agent.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
}

function determineRecipients(room: Room, fromAgent: string, text: string): string[] {
	if (room.routingStrategy === "broadcast") {
		return [...room.agents.keys()].filter((name) => name !== fromAgent);
	}
	if (room.routingStrategy === "mention") {
		const mentionRegex = /@attn:(\w+)/g;
		const mentioned: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = mentionRegex.exec(text)) !== null) {
			const name = match[1];
			if (room.agents.has(name) && !mentioned.includes(name)) {
				mentioned.push(name);
			}
		}
		return mentioned.length > 0
			? mentioned
			: [...room.agents.keys()].filter((name) => name !== fromAgent);
	}
	// custom / front-matter routes
	if (room.routes && room.routes[fromAgent]) {
		return room.routes[fromAgent].filter((name) => room.agents.has(name) && name !== fromAgent);
	}
	return [...room.agents.keys()].filter((name) => name !== fromAgent);
}

function routeMessageToAgents(room: Room, fromAgent: string, text: string): void {
	const recipients = determineRecipients(room, fromAgent, text);
	const formattedMessage = `[${fromAgent}]: ${text}`;
	for (const recipientName of recipients) {
		const agent = room.agents.get(recipientName);
		if (!agent) continue;
		sendToAgent(agent, {
			type: agent.isStreaming ? "follow_up" : "prompt",
			message: formattedMessage,
		});
	}
}

export function createRoomFromMarkdown(markdown: string): { roomId: string } {
	const dir = mkdtempSync(join(tmpdir(), "piroom-"));
	const filePath = join(dir, "protocol.md");
	writeFileSync(filePath, markdown, "utf-8");
	try {
		const protocol = parseProtocol(filePath);
		return createRoom(protocol);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failure
		}
	}
}

export function buildPiArgs(
	agentName: string,
	role: string,
	tailorShop: string | undefined,
	bodyPromptPath: string,
	roomPromptDir: string,
): string[] {
	const args = ["--mode", "rpc", "--no-session"];

	// 1. Protocol body as system prompt
	args.push("--append-system-prompt", bodyPromptPath);

	if (tailorShop) {
		// 2. Agent-specific prompt file: name first, then role fallback
		const namePath = join(tailorShop, "agents", `${agentName}.md`);
		const rolePath = join(tailorShop, "agents", `${role}.md`);

		let resolvedPath: string | undefined;
		let resolvedContent: string | undefined;

		if (existsSync(namePath)) {
			resolvedPath = namePath;
			resolvedContent = readFileSync(namePath, "utf-8");
		} else if (existsSync(rolePath)) {
			resolvedPath = rolePath;
			resolvedContent = readFileSync(rolePath, "utf-8");
		}

		if (resolvedPath && resolvedContent) {
			const parsed = parseAgentPromptFile(resolvedContent);
			if (parsed.model) {
				args.push("--model", parsed.model);
			}
			if (resolvedContent.startsWith("---") && parsed.body) {
				// Write stripped body to a temp file so pi doesn't ingest raw YAML
				const promptFile = join(roomPromptDir, `${agentName}.prompt`);
				writeFileSync(promptFile, parsed.body, "utf-8");
				args.push("--append-system-prompt", promptFile);
			} else {
				// No front matter (or empty body) — pass original file path directly
				args.push("--append-system-prompt", resolvedPath);
			}
		} else {
			console.warn("[agent-rooms] tailor_shop agent prompt not found:", namePath);
		}

		// 3. Optional shared working protocol
		const workingPath = join(tailorShop, "working_protocol.md");
		if (existsSync(workingPath)) {
			args.push("--append-system-prompt", workingPath);
		}
	}

	return args;
}

export function createRoom(protocol: Protocol): { roomId: string } {
	const id = generateId();
	const promptDir = mkdtempSync(join(tmpdir(), `piroom-${id}-`));
	const bodyPromptPath = join(promptDir, "body.prompt");
	writeFileSync(bodyPromptPath, protocol.body, "utf-8");

	const room: Room = {
		id,
		status: "initialized",
		agents: new Map(),
		sseClients: new Set(),
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		protocolBody: protocol.body,
		routes: protocol.routes,
		routingStrategy: protocol.routes ? "custom" : "broadcast",
		events: [],
		eventSeq: 0,
		promptDir,
	};

	for (const [name, role] of Object.entries(protocol.team)) {
		const args = buildPiArgs(name, role, protocol.tailorShop, bodyPromptPath, promptDir);
		const proc = spawn("pi", args, {
			stdio: ["pipe", "pipe", "inherit"],
		});

		const logger = new SquadLogger(name);
		const agent: AgentState = {
			proc,
			name,
			role,
			isStreaming: false,
			pendingUiRequest: false,
			status: "idle",
			logger,
			_textBuf: "",
			_thinkingBuf: "",
			_msgTs: 0,
		};

		proc.on("exit", (code) => {
			if (room.status === "completed") return;
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

			// ── Event storage (coalesced, mirrors SquadLogger output) ────────────
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
					room.status = "running";
					break;
				case "agent_end":
					agent.isStreaming = false;
					agent.status = "idle";
					break;
				case "response":
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
			if (type === "message_end" && messageText) {
				routeMessageToAgents(room, name, messageText);
			}
		});

		room.agents.set(name, agent);
	}

	// Dispatch instructions after all agents are spawned
	if (protocol.instructions) {
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

export function getRoomEvents(room: Room, since?: number): StoredEvent[] {
	if (since === undefined) return room.events;
	return room.events.filter((e) => e.id > since);
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

export function sendInstructions(
	room: Room,
	targetAgent: string,
	followUp: string[],
): { queuedItems: number } {
	const agent = room.agents.get(targetAgent);
	if (!agent) {
		throw new Error(`Agent ${targetAgent} not found in room`);
	}

	for (const message of followUp) {
		sendToAgent(agent, {
			type: agent.isStreaming ? "follow_up" : "prompt",
			message,
		});
	}

	updateActivity(room);
	return { queuedItems: followUp.length };
}

export function destroyRoom(id: string, reason = "manual"): void {
	const room = rooms.get(id);
	if (!room) return;

	if (room.expireTimeout) clearTimeout(room.expireTimeout);

	for (const agent of room.agents.values()) {
		try {
			sendToAgent(agent, { type: "abort" });
			agent.proc.stdin!.end();
			agent.proc.kill("SIGTERM");
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
	room.status = "completed";
	destroyRoom(id, "completed");
}
