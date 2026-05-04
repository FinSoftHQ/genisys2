import { spawn, ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FastifyReply } from "fastify";
import { parseProtocol, type Protocol } from "@repo/shared";
import { attachJsonlReader } from "./jsonl.js";
import { SquadLogger, loggingEnabled } from "./logger.js";

export type SquadStatus =
	| "initialized"
	| "running"
	| "suspended"
	| "error"
	| "completed";

function killAgentProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	try {
		if (proc.pid !== undefined && process.platform !== "win32") {
			process.kill(-proc.pid, signal);
			return;
		}
	} catch {
		// process may have already exited
	}
	try {
		proc.kill(signal);
	} catch {
		// ignore
	}
}

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
	| (StoredEventBase & { type: "squad_error"; reason: string });

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

interface Squad {
	id: string;
	status: SquadStatus;
	agents: Map<string, AgentState>;
	sseClients: Set<FastifyReply>;
	createdAt: number;
	lastActivityAt: number;
	protocolBody: string;
	failedAgent?: string;
	failedReason?: string;
	expireTimeout?: ReturnType<typeof setTimeout>;
	events: StoredEvent[];
	eventSeq: number;
}

const squads = new Map<string, Squad>();
const EXPIRY_MS = 1000 * 60 * 60 * 2; // 2 hours

function generateId(): string {
	return `sq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function resetExpiry(squad: Squad): void {
	if (squad.expireTimeout) clearTimeout(squad.expireTimeout);
	squad.expireTimeout = setTimeout(() => {
		destroySquad(squad.id, "expired");
	}, EXPIRY_MS);
}

function pushEvent(squad: Squad, event: StoredEventInput): void {
	squad.eventSeq += 1;
	const record = { id: squad.eventSeq, ...event } as StoredEvent;
	squad.events.push(record);
	if (squad.events.length > EVENT_BUFFER_CAP) {
		squad.events.shift();
	}
}

function updateActivity(squad: Squad): void {
	squad.lastActivityAt = Date.now();
	resetExpiry(squad);
}

function broadcast(squad: Squad, payload: object): void {
	const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const client of squad.sseClients) {
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

export function createSquadFromMarkdown(markdown: string): { squadId: string } {
	const dir = mkdtempSync(join(tmpdir(), "piteam-"));
	const filePath = join(dir, "protocol.md");
	writeFileSync(filePath, markdown, "utf-8");
	try {
		const protocol = parseProtocol(filePath);
		return createSquad(protocol);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failure
		}
	}
}

export function createSquad(protocol: Protocol): { squadId: string } {
	const id = generateId();
	const squad: Squad = {
		id,
		status: "initialized",
		agents: new Map(),
		sseClients: new Set(),
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		protocolBody: protocol.body,
		events: [],
		eventSeq: 0,
	};

	for (const [name, role] of Object.entries(protocol.team)) {
		// When the API runs under pnpm / tsx, local node_modules/.bin shadows
		// the global `pi` binary with an older local version. Remove local
		// node_modules/.bin entries from PATH so the global `pi` is resolved.
		const originalPath = process.env.PATH ?? "";
		const filteredPath = originalPath
			.split(":")
			.filter((segment) => !segment.endsWith("node_modules/.bin"))
			.join(":");

		const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, PATH: filteredPath },
			detached: true,
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
			if (squad.status === "completed") return;
			if (code !== 0 && code !== null) {
				agent.status = "error";
				squad.status = "error";
				squad.failedAgent = name;
				squad.failedReason = `Process exited with code ${String(code)}`;
				const reason = squad.failedReason;
				pushEvent(squad, { type: "squad_error", from: name, at: new Date().toISOString(), reason });
				broadcast(squad, { type: "squad_error", from: name, reason });
			}
		});

		proc.on("error", (err) => {
			agent.status = "error";
			squad.status = "error";
			squad.failedAgent = name;
			squad.failedReason = err.message;
			pushEvent(squad, { type: "squad_error", from: name, at: new Date().toISOString(), reason: err.message });
			broadcast(squad, { type: "squad_error", from: name, reason: err.message });
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
								pushEvent(squad, { type: "thinking", from: name, at: new Date(agent._msgTs).toISOString(), thinking: agent._thinkingBuf });
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
							pushEvent(squad, { type: "thinking", from: name, at: new Date(agent._msgTs).toISOString(), thinking: agent._thinkingBuf });
							agent._thinkingBuf = "";
						}
						if (agent._textBuf) {
							pushEvent(squad, { type: "message", from: name, at: new Date(agent._msgTs).toISOString(), text: agent._textBuf });
							agent._textBuf = "";
						}
					}
					break;
				}
				case "tool_execution_start":
					pushEvent(squad, { type: "tool_start", from: name, at: now, toolName: String(event.toolName), args: event.args });
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
					pushEvent(squad, { type: "tool_end", from: name, at: now, toolName: String(event.toolName), result: resultText, isError: Boolean(event.isError) });
					break;
				}
				case "auto_retry_start":
					pushEvent(squad, { type: "retry_start", from: name, at: now, attempt: Number(event.attempt), maxAttempts: Number(event.maxAttempts), delayMs: Number(event.delayMs), errorMessage: String(event.errorMessage) });
					break;
				case "auto_retry_end":
					pushEvent(squad, { type: "retry_end", from: name, at: now, success: Boolean(event.success), attempt: Number(event.attempt), ...(event.finalError ? { finalError: String(event.finalError) } : {}) });
					break;
				case "agent_start":
					pushEvent(squad, { type: "agent_start", from: name, at: now });
					break;
				case "agent_end":
					pushEvent(squad, { type: "agent_end", from: name, at: now });
					break;
				default: break;
			}

			// ── Agent status bookkeeping ──────────────────────────────────────────
			switch (type) {
				case "agent_start":
					agent.isStreaming = true;
					agent.status = "streaming";
					squad.status = "running";
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

			updateActivity(squad);
			broadcast(squad, { from: name, ...event });
		});

		squad.agents.set(name, agent);

		// Inject protocol body as first prompt
		sendToAgent(agent, { type: "prompt", message: protocol.body });
	}

	resetExpiry(squad);
	squads.set(id, squad);
	return { squadId: id };
}

export function listSquads(
	status?: string,
	limit = 50,
	offset = 0,
): object[] {
	let values = Array.from(squads.values());
	if (status !== undefined) {
		values = values.filter((squad) => squad.status === status);
	}
	const clampedLimit = Math.max(1, Math.min(200, limit));
	const clampedOffset = Math.max(0, offset);
	return values.slice(clampedOffset, clampedOffset + clampedLimit).map(getSquadStatus);
}

export function getSquad(id: string): Squad | undefined {
	return squads.get(id);
}

export function getSquadStatus(squad: Squad): object {
	const agentStatuses: Record<string, { status: string }> = {};
	for (const [name, agent] of squad.agents) {
		agentStatuses[name] = { status: agent.status };
	}
	const lastEvent = squad.events.length > 0 ? squad.events[squad.events.length - 1] : undefined;
	return {
		squadId: squad.id,
		status: squad.status,
		...(squad.failedAgent
			? { failedAgent: squad.failedAgent, reason: squad.failedReason }
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

export function getSquadEvents(squad: Squad, since?: number): StoredEvent[] {
	if (since === undefined) return squad.events;
	return squad.events.filter((e) => e.id > since);
}

export function addSseClient(squad: Squad, reply: FastifyReply): void {
	squad.sseClients.add(reply);
	reply.raw.on("close", () => {
		squad.sseClients.delete(reply);
	});
}

export function removeSseClient(squad: Squad, reply: FastifyReply): void {
	squad.sseClients.delete(reply);
}

export function resumeSquad(squad: Squad, action: string): void {
	if (action !== "retry_error") return;

	const target = squad.failedAgent
		? squad.agents.get(squad.failedAgent)
		: undefined;

	if (target) {
		sendToAgent(target, { type: "abort_retry" });
		sendToAgent(target, {
			type: "follow_up",
			message: "Please try generating that file again.",
		});
	} else {
		for (const agent of squad.agents.values()) {
			sendToAgent(agent, { type: "abort_retry" });
			sendToAgent(agent, {
				type: "follow_up",
				message: "Please try generating that file again.",
			});
		}
	}

	squad.status = "running";
	updateActivity(squad);
}

export function sendInstructions(
	squad: Squad,
	targetAgent: string,
	followUp: string[],
): { queuedItems: number } {
	const agent = squad.agents.get(targetAgent);
	if (!agent) {
		throw new Error(`Agent ${targetAgent} not found in squad`);
	}

	for (const message of followUp) {
		sendToAgent(agent, {
			type: agent.isStreaming ? "follow_up" : "prompt",
			message,
		});
	}

	updateActivity(squad);
	return { queuedItems: followUp.length };
}

export function destroySquad(id: string, reason = "manual"): void {
	const squad = squads.get(id);
	if (!squad) return;

	if (squad.expireTimeout) clearTimeout(squad.expireTimeout);

	for (const agent of squad.agents.values()) {
		try {
			sendToAgent(agent, { type: "abort" });
			agent.proc.stdin!.end();
			killAgentProcess(agent.proc);
		} catch {
			// ignore
		}
	}

	for (const client of squad.sseClients) {
		try {
			client.raw.write(
				`event: message\ndata: ${JSON.stringify({ type: "squad_closed", reason })}\n\n`,
			);
			client.raw.end();
		} catch {
			// ignore
		}
	}

	squad.sseClients.clear();
	squad.agents.clear();
	squads.delete(id);
}

export function completeSquad(id: string): void {
	const squad = squads.get(id);
	if (!squad) return;
	squad.status = "completed";
	destroySquad(id, "completed");
}
