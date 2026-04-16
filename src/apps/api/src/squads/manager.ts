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

interface AgentState {
	proc: ChildProcess;
	name: string;
	role: string;
	isStreaming: boolean;
	pendingUiRequest: boolean;
	status: "idle" | "streaming" | "error";
	logger: SquadLogger;
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
	};

	for (const [name, role] of Object.entries(protocol.team)) {
		const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
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
		};

		proc.on("exit", (code) => {
			if (squad.status === "completed") return;
			if (code !== 0 && code !== null) {
				agent.status = "error";
				squad.status = "error";
				squad.failedAgent = name;
				squad.failedReason = `Process exited with code ${String(code)}`;
				broadcast(squad, {
					type: "squad_error",
					from: name,
					reason: squad.failedReason,
				});
			}
		});

		proc.on("error", (err) => {
			agent.status = "error";
			squad.status = "error";
			squad.failedAgent = name;
			squad.failedReason = err.message;
			broadcast(squad, {
				type: "squad_error",
				from: name,
				reason: err.message,
			});
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

export function getSquad(id: string): Squad | undefined {
	return squads.get(id);
}

export function getSquadStatus(squad: Squad): object {
	const agentStatuses: Record<string, { status: string }> = {};
	for (const [name, agent] of squad.agents) {
		agentStatuses[name] = { status: agent.status };
	}
	return {
		squadId: squad.id,
		status: squad.status,
		...(squad.failedAgent
			? { failedAgent: squad.failedAgent, reason: squad.failedReason }
			: {}),
		agents: agentStatuses,
	};
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
			agent.proc.kill("SIGTERM");
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
