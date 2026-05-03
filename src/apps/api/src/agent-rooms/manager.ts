import { spawn, ChildProcess } from "child_process";
import { createHmac } from "crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, isAbsolute } from "path";
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
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_FIELD_LENGTH = 4000;
const TASK_COMPLETION_MARKER = "[@TASK: VIPER-RTB]";
const idleCompletionGraceMsRaw = Number(process.env.AGENT_ROOM_IDLE_COMPLETION_MS ?? 60_000);
const IDLE_COMPLETION_GRACE_MS = Number.isFinite(idleCompletionGraceMsRaw)
	? Math.max(1000, idleCompletionGraceMsRaw)
	: 60_000;

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
	| (StoredEventBase & { type: "room_error"; reason: string })
	| (StoredEventBase & { type: "room_closed"; reason: "completed" });

// Distributive Omit so pushEvent accepts each union member without the id field.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type StoredEventInput = DistributiveOmit<StoredEvent, "id">;

type ExecutionMode = "session" | "single-shot";
type RoomCloseReason = "completed" | "manual" | "expired";

export interface RoomCreateOptions {
	callbackUrl?: string;
	callbackSecret?: string;
}

interface AgentState {
	proc: ChildProcess | null;
	executionMode: ExecutionMode;
	piArgs: string[];
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
	ready: boolean;
	taskCompleted: boolean;
	hasParticipated: boolean;
	_readyResolve?: () => void;
	_readyReject?: (err: Error) => void;
	_readyTimeout?: ReturnType<typeof setTimeout>;
}

export type RoutingStrategy = "broadcast" | "explicit";

export interface Room {
	id: string;
	status: RoomStatus;
	agents: Map<string, AgentState>;
	sseClients: Set<FastifyReply>;
	createdAt: number;
	lastActivityAt: number;
	protocolBody: string;
	routes?: Record<string, string[]>;
	facilitator?: string;
	routingStrategy: RoutingStrategy;
	failedAgent?: string;
	failedReason?: string;
	expireTimeout?: ReturnType<typeof setTimeout>;
	events: StoredEvent[];
	eventSeq: number;
	promptDir: string;
	workingDir?: string;
	idleCompletionTimeout?: ReturnType<typeof setTimeout>;
	callbackUrl?: string;
	callbackSecret?: string;
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
	if (!agent.proc) {
		console.warn(
			`[agent-rooms] sendToAgent: agent "${agent.name}" has no active process — message dropped.`,
		);
		return;
	}
	agent.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
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

export function determineRecipients(room: Room, fromAgent: string, text: string): string[] {
	if (room.routingStrategy === "broadcast") {
		return [...room.agents.keys()].filter((name) => name !== fromAgent);
	}

	// Explicit mode: combine dynamic @attn: mentions with static routes
	const pool = new Set<string>();

	// Dynamic targeting (inline mentions)
	const mentionRegex = /@attn:([\w-]+)/g;
	let match: RegExpExecArray | null;
	while ((match = mentionRegex.exec(text)) !== null) {
		const identifier = match[1];
		// Name match
		if (room.agents.has(identifier)) {
			pool.add(identifier);
		}
		// Role match — route to all agents with this role
		for (const [name, agent] of room.agents) {
			if (agent.role === identifier) {
				pool.add(name);
			}
		}
	}

	// Static targeting (configured routes)
	if (room.routes && room.routes[fromAgent]) {
		for (const name of room.routes[fromAgent]) {
			if (room.agents.has(name)) {
				pool.add(name);
			}
		}
	}

	// Self-exclusion
	pool.delete(fromAgent);

	return Array.from(pool);
}

export function resolveMessageTargets(room: Room, fromAgent: string, text: string): string[] {
	const recipients = determineRecipients(room, fromAgent, text);
	if (recipients.length > 0) {
		return recipients;
	}

	if (!room.facilitator) {
		return [];
	}
	if (room.facilitator === fromAgent) {
		return [];
	}
	if (!room.agents.has(room.facilitator)) {
		return [];
	}
	return [room.facilitator];
}

export function shouldCheckCompletionAfterTaskMarker(room: Room, fromAgent: string, text: string): boolean {
	const targets = resolveMessageTargets(room, fromAgent, text);
	if (targets.length === 0) {
		return true;
	}
	return targets.every((targetName) => room.agents.get(targetName)?.taskCompleted === true);
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

export function routeMessageToAgents(room: Room, fromAgent: string, text: string): void {
	const recipients = determineRecipients(room, fromAgent, text);

	if (recipients.length > 0) {
		clearIdleCompletionTimeout(room);
		const formattedMessage = `[${fromAgent}]: ${text}`;
		for (const recipientName of recipients) {
			const agent = room.agents.get(recipientName);
			if (!agent) continue;

			if (agent.executionMode === "single-shot" && agent.proc === null) {
				spawnAndSendToSingleShot(room, recipientName, formattedMessage).catch((err: unknown) => {
					const reason = err instanceof Error ? err.message : String(err);
					pushEvent(room, {
						type: "room_error",
						from: recipientName,
						at: new Date().toISOString(),
						reason,
					});
					broadcast(room, { type: "room_error", from: recipientName, reason });
				});
				continue;
			}

			sendToAgent(agent, {
				type: agent.isStreaming ? "follow_up" : "prompt",
				message: formattedMessage,
			});
		}
		return;
	}

	// Phase 3: Fallback Protocol
	if (!room.facilitator) {
		console.warn(
			`[SYSTEM WARNING] Dropped message from ${fromAgent}: no recipients and no facilitator configured.`,
		);
		return;
	}

	if (room.facilitator === fromAgent) {
		console.error(
			`[CRITICAL ERROR] Facilitator ${fromAgent} sent a message with no recipients. This creates an infinite loop. Configure routes for the facilitator agent.`,
		);
		return;
	}

	const facilitatorAgent = room.agents.get(room.facilitator);
	if (!facilitatorAgent) {
		console.warn(
			`[SYSTEM WARNING] Facilitator ${room.facilitator} not found in room. Dropping message from ${fromAgent}.`,
		);
		return;
	}

	clearIdleCompletionTimeout(room);
	const wrappedMessage = `[SYSTEM_ROUTING_FAILURE]\n**Original Sender:** ${fromAgent}\n**Status:** This message reached no one because no attention tags were used and no static routes exist.\n**Content:**\n> ---\n${text}`;
	sendToAgent(facilitatorAgent, {
		type: facilitatorAgent.isStreaming ? "follow_up" : "prompt",
		message: wrappedMessage,
	});
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

export function buildPiArgs(
	agentName: string,
	role: string,
	tailorShop: string | undefined,
	bodyPromptPath: string,
	roomPromptDir: string,
	workingDir?: string,
): { args: string[]; executionMode: ExecutionMode } {
	const args = ["--mode", "rpc", "--no-session"];
	let executionMode: ExecutionMode = "session";

	// 1. Agent identity notification as first system prompt
	const identityPromptPath = join(roomPromptDir, `${agentName}.identity.prompt`);
	writeFileSync(
		identityPromptPath,
		`[SYSTEM IDENTITY NOTIFICATION] You are ${agentName}, the ${role}.\n\n`,
		"utf-8",
	);
	args.push("--append-system-prompt", identityPromptPath);

	// 2. Protocol body as system prompt
	args.push("--append-system-prompt", bodyPromptPath);

	if (tailorShop) {
		// Resolve tailorShop to absolute so pi can find it regardless of cwd
		const resolvedTailorShop = isAbsolute(tailorShop)
			? tailorShop
			: resolve(workingDir ?? process.cwd(), tailorShop);

		// 3. Agent-specific prompt file: name first, then role fallback
		const namePath = join(resolvedTailorShop, "agents", `${agentName}.md`);
		const rolePath = join(resolvedTailorShop, "agents", `${role}.md`);

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

			const VALID_EXECUTION_MODES = ["session", "single-shot"] as const;
			if ((VALID_EXECUTION_MODES as readonly string[]).includes(parsed.execution)) {
				executionMode = parsed.execution as ExecutionMode;
			} else {
				console.warn(
					`[agent-rooms] Unknown execution value "${parsed.execution}" for agent "${agentName}". Expected "session" or "single-shot". Defaulting to "session".`,
				);
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

		// 4. Optional shared working protocol
		const workingPath = join(resolvedTailorShop, "working_protocol.md");
		if (existsSync(workingPath)) {
			const workingContent = readFileSync(workingPath, "utf-8");
			const parsedWorking = parseAgentPromptFile(workingContent);
			if (workingContent.startsWith("---") && parsedWorking.body) {
				// Write stripped body to a temp file so pi doesn't ingest raw YAML
				const promptFile = join(roomPromptDir, "working_protocol.prompt");
				writeFileSync(promptFile, parsedWorking.body, "utf-8");
				args.push("--append-system-prompt", promptFile);
			} else {
				// No front matter (or empty body) — pass original file path directly
				args.push("--append-system-prompt", workingPath);
			}
		}
	}

	return { args, executionMode };
}

function spawnAgentProcess(room: Room, agent: AgentState): void {
	const proc = spawn("pi", agent.piArgs, {
		stdio: ["pipe", "pipe", "inherit"],
		env: process.env,
		...(room.workingDir ? { cwd: room.workingDir } : {}),
	});
	agent.proc = proc;
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
			routeMessageToAgents(room, name, messageText);
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

	await new Promise<void>((resolve, reject) => {
		agent._readyResolve = resolve;
		agent._readyReject = reject;
	});

	sendToAgent(agent, { type: "prompt", message });
}

function terminateSingleShotAgent(agent: AgentState): void {
	if (!agent.proc) return;
	// Capture and null agent.proc BEFORE calling kill().
	// The exit handler uses `agent.proc !== proc` to detect deliberate termination.
	// Setting agent.proc = null first ensures the check works whether the exit event
	// fires synchronously (in tests) or asynchronously (in production with a real proc).
	const procToKill = agent.proc;
	agent.proc = null;
	agent.isStreaming = false;
	agent.status = "idle";
	agent.ready = false;
	try {
		procToKill.stdin!.write(`${JSON.stringify({ type: "abort" })}\n`);
		procToKill.stdin!.end();
		procToKill.kill("SIGTERM");
	} catch {
		// ignore — process may have already exited
	}
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
			logger: new SquadLogger(name),
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

export async function waitForAllAgentsReady(room: Room): Promise<void> {
	await Promise.all(
		Array.from(room.agents.values())
			.filter((agent) => agent.proc !== null)
			.map((agent) => {
				if (agent.ready) return Promise.resolve();
				return new Promise<void>((resolve, reject) => {
					agent._readyResolve = resolve;
					agent._readyReject = reject;
				});
			}),
	);
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

export type ReturnedEvent = StoredEvent & { _fieldTruncated?: boolean };

export function getRoomEvents(
	room: Room,
	since?: number,
	limit?: number,
): { events: ReturnedEvent[]; hasMore: boolean } {
	let events = room.events;
	if (since !== undefined) {
		events = events.filter((e) => e.id > since);
	}
	const effectiveLimit = limit ?? DEFAULT_EVENT_LIMIT;
	const clampedLimit = Math.max(1, effectiveLimit);
	const hasMore = events.length > clampedLimit;
	const limitedEvents = events.slice(0, clampedLimit);
	return { events: truncateEvents(limitedEvents), hasMore };
}

function truncateEvents(events: StoredEvent[]): ReturnedEvent[] {
	return events.map((event) => {
		let truncated = false;
		const copy = { ...event } as ReturnedEvent;
		switch (copy.type) {
			case "thinking":
				if (copy.thinking.length > MAX_EVENT_FIELD_LENGTH) {
					copy.thinking = copy.thinking.slice(0, MAX_EVENT_FIELD_LENGTH) + "... [truncated]";
					truncated = true;
				}
				break;
			case "message":
				if (copy.text.length > MAX_EVENT_FIELD_LENGTH) {
					copy.text = copy.text.slice(0, MAX_EVENT_FIELD_LENGTH) + "... [truncated]";
					truncated = true;
				}
				break;
			case "tool_end":
				if (copy.result.length > MAX_EVENT_FIELD_LENGTH) {
					copy.result = copy.result.slice(0, MAX_EVENT_FIELD_LENGTH) + "... [truncated]";
					truncated = true;
				}
				break;
		}
		if (truncated) {
			copy._fieldTruncated = true;
		}
		return copy;
	});
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
			agent.proc.kill("SIGTERM");
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
