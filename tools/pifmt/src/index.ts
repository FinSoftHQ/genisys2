#!/usr/bin/env node
import { spawn } from "child_process";
import * as readline from "readline";
import process from "process";
import { attachJsonlReader } from "./jsonl.js";
import { Formatter } from "./formatter.js";
import { handleExtensionUiRequest } from "./ui.js";

const pi = spawn("pi", ["--mode", "rpc", "--no-session"], {
	stdio: ["pipe", "pipe", "inherit"],
});

let isStreaming = false;
let pendingUiRequest = false;

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: "> ",
});

const formatter = new Formatter();

function send(cmd: object): void {
	pi.stdin.write(`${JSON.stringify(cmd)}\n`);
}

rl.prompt();

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) {
		rl.prompt();
		return;
	}
	if (isStreaming) {
		send({ type: "follow_up", message: trimmed });
	} else {
		send({ type: "prompt", message: trimmed });
	}
	rl.prompt();
});

rl.on("close", () => {
	shutdown();
});

process.on("SIGINT", () => {
	shutdown();
});

function shutdown(): void {
	send({ type: "abort" });
	pi.stdin.end();
	setTimeout(() => process.exit(0), 200);
}

attachJsonlReader(pi.stdout, async (line) => {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line);
	} catch {
		console.error("[pifmt] Failed to parse JSONL line:", line.slice(0, 200));
		return;
	}

	const type = event.type;

	switch (type) {
		case "agent_start": {
			isStreaming = true;
			formatter.onAgentStart();
			break;
		}
		case "agent_end": {
			isStreaming = false;
			formatter.onAgentEnd();
			break;
		}
		case "turn_start": {
			formatter.onTurnStart();
			break;
		}
		case "turn_end": {
			formatter.onTurnEnd();
			break;
		}
		case "message_start": {
			formatter.onMessageStart(
				event.message as { role?: string; timestamp?: number },
			);
			break;
		}
		case "message_update": {
			formatter.onMessageUpdate(
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
			formatter.onMessageEnd(
				event.message as {
					role?: string;
					stopReason?: string;
					errorMessage?: string;
				},
			);
			break;
		}
		case "tool_execution_start": {
			formatter.onToolExecutionStart(
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
			formatter.onToolExecutionEnd(
				String(event.toolName),
				event.result,
				Boolean(event.isError),
			);
			break;
		}
		case "auto_retry_start": {
			formatter.onAutoRetryStart(
				Number(event.attempt),
				Number(event.maxAttempts),
				Number(event.delayMs),
				String(event.errorMessage),
			);
			break;
		}
		case "auto_retry_end": {
			formatter.onAutoRetryEnd(
				Boolean(event.success),
				Number(event.attempt),
				event.finalError ? String(event.finalError) : undefined,
			);
			break;
		}
		case "extension_ui_request": {
			if (pendingUiRequest) break;
			pendingUiRequest = true;
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
					send,
					rl,
				);
			} finally {
				pendingUiRequest = false;
			}
			break;
		}
		case "response": {
			if (!event.success) {
				console.error(`[Command error: ${event.error}]`);
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
