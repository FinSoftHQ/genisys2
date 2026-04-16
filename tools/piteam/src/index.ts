#!/usr/bin/env node
import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import process from "process";
import { attachJsonlReader } from "./jsonl.js";
import { Formatter } from "./formatter.js";
import { handleExtensionUiRequest } from "./ui.js";
import { parseProtocol } from "./parser.js";

const filePath = process.argv[2] ?? "working_protocol.md";
const protocol = parseProtocol(filePath);

interface Agent {
	proc: ChildProcess;
	formatter: Formatter;
	name: string;
	role: string;
	isStreaming: boolean;
	pendingUiRequest: boolean;
}

const agents = new Map<string, Agent>();

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: "> ",
});

function send(agent: Agent, cmd: object): void {
	agent.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
}

function shutdown(): void {
	for (const agent of agents.values()) {
		send(agent, { type: "abort" });
		agent.proc.stdin!.end();
	}
	setTimeout(() => process.exit(0), 200);
}

rl.prompt();

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) {
		rl.prompt();
		return;
	}

	if (trimmed.startsWith("@squad:")) {
		const rest = trimmed.slice("@squad:".length);
		const spaceIndex = rest.indexOf(" ");
		if (spaceIndex === -1) {
			console.error("[piteam] Message required after @squad:<name>");
			rl.prompt();
			return;
		}
		const name = rest.slice(0, spaceIndex);
		const message = rest.slice(spaceIndex + 1).trim();
		const agent = agents.get(name);
		if (!agent) {
			console.error(
				`[piteam] Unknown agent: ${name}. Available: ${[...agents.keys()].join(", ")}`,
			);
			rl.prompt();
			return;
		}
		send(agent, {
			type: agent.isStreaming ? "follow_up" : "prompt",
			message,
		});
	} else {
		for (const agent of agents.values()) {
			send(agent, {
				type: agent.isStreaming ? "follow_up" : "prompt",
				message: trimmed,
			});
		}
	}
	rl.prompt();
});

rl.on("close", shutdown);
process.on("SIGINT", shutdown);

for (const [name, role] of Object.entries(protocol.team)) {
	const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
		stdio: ["pipe", "pipe", "inherit"],
	});

	const formatter = new Formatter(name);
	const agent: Agent = {
		proc,
		formatter,
		name,
		role,
		isStreaming: false,
		pendingUiRequest: false,
	};

	agents.set(name, agent);

	attachJsonlReader(proc.stdout!, async (line) => {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			console.error(
				`[piteam:${name}] Failed to parse JSONL line:`,
				line.slice(0, 200),
			);
			return;
		}

		const type = event.type;

		switch (type) {
			case "agent_start": {
				agent.isStreaming = true;
				agent.formatter.onAgentStart();
				break;
			}
			case "agent_end": {
				agent.isStreaming = false;
				agent.formatter.onAgentEnd();
				break;
			}
			case "turn_start": {
				agent.formatter.onTurnStart();
				break;
			}
			case "turn_end": {
				agent.formatter.onTurnEnd();
				break;
			}
			case "message_start": {
				agent.formatter.onMessageStart(
					event.message as { role?: string; timestamp?: number },
				);
				break;
			}
			case "message_update": {
				agent.formatter.onMessageUpdate(
					event as {
						assistantMessageEvent?: {
							type: string;
							delta?: string;
						};
					},
				);
				break;
			}
			case "message_end": {
				agent.formatter.onMessageEnd(
					event.message as {
						role?: string;
						stopReason?: string;
						errorMessage?: string;
					},
				);
				break;
			}
			case "tool_execution_start": {
				agent.formatter.onToolExecutionStart(
					String(event.toolName),
					event.args,
				);
				break;
			}
			case "tool_execution_update": {
				// ignored in pretty-print mode
				break;
			}
			case "tool_execution_end": {
				agent.formatter.onToolExecutionEnd(
					String(event.toolName),
					event.result,
					Boolean(event.isError),
				);
				break;
			}
			case "auto_retry_start": {
				agent.formatter.onAutoRetryStart(
					Number(event.attempt),
					Number(event.maxAttempts),
					Number(event.delayMs),
					String(event.errorMessage),
				);
				break;
			}
			case "auto_retry_end": {
				agent.formatter.onAutoRetryEnd(
					Boolean(event.success),
					Number(event.attempt),
					event.finalError ? String(event.finalError) : undefined,
				);
				break;
			}
			case "extension_ui_request": {
				if (agent.pendingUiRequest) break;
				agent.pendingUiRequest = true;
				try {
					await handleExtensionUiRequest(
						event as {
							id: string;
							method: string;
							title?: string;
							message?: string;
							options?: string[];
							notifyType?: string;
						},
						(cmd) => send(agent, cmd),
						rl,
					);
				} finally {
					agent.pendingUiRequest = false;
				}
				break;
			}
			case "response": {
				if (!event.success) {
					console.error(`[piteam:${name}] Command error: ${event.error}`);
				}
				break;
			}
			case "queue_update":
			case "compaction_start":
			case "compaction_end":
			case "extension_error": {
				// intentionally ignored in pretty-print mode
				break;
			}
			default: {
				// unknown event type — ignore
				break;
			}
		}
	});

	// Inject working protocol as first prompt
	send(agent, { type: "prompt", message: protocol.body });
}
