import process from "process";

export class Formatter {
	private isTTY = process.stdout.isTTY;
	private textBuffer = "";
	private thinkingBuffer = "";
	private currentTimestamp = Date.now();
	private agentName = process.env.PIFMT_AGENT_NAME ?? "Pi";

	private gray(text: string): string {
		return this.isTTY ? `\x1b[90m${text}\x1b[0m` : text;
	}

	private red(text: string): string {
		return this.isTTY ? `\x1b[91m${text}\x1b[0m` : text;
	}

	private cyan(text: string): string {
		return this.isTTY ? `\x1b[36m${text}\x1b[0m` : text;
	}

	private formatTimestamp(ms: number): string {
		return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	onAgentStart(): void {
		// no-op
	}

	onAgentEnd(): void {
		process.stdout.write("\n");
	}

	onTurnStart(): void {
		// no-op
	}

	onTurnEnd(): void {
		// no-op
	}

	onMessageStart(message: { role?: string; timestamp?: number }): void {
		if (message.role === "assistant") {
			this.textBuffer = "";
			this.thinkingBuffer = "";
			this.currentTimestamp = message.timestamp ?? Date.now();
		}
	}

	onMessageUpdate(event: {
		assistantMessageEvent?: {
			type: string;
			delta?: string;
		};
	}): void {
		const ame = event.assistantMessageEvent;
		if (!ame) return;

		switch (ame.type) {
			case "text_delta":
				this.textBuffer += ame.delta ?? "";
				break;
			case "thinking_start":
				this.thinkingBuffer = "";
				break;
			case "thinking_delta":
				this.thinkingBuffer += ame.delta ?? "";
				break;
			case "thinking_end":
				this.printThinking();
				break;
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				// rely on tool_execution_* events for display
				break;
			default:
				break;
		}
	}

	private printThinking(): void {
		if (!this.thinkingBuffer) return;
		const ts = this.formatTimestamp(this.currentTimestamp);
		process.stdout.write(`\n@${ts}Z [${this.agentName}] (thinking):\n`);
		process.stdout.write(this.gray(this.thinkingBuffer) + "\n");
		this.thinkingBuffer = "";
	}

	onMessageEnd(message: {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
	}): void {
		if (message.role === "assistant") {
			if (this.thinkingBuffer) {
				this.printThinking();
			}
			const hadText = this.textBuffer.length > 0;
			if (hadText) {
				const ts = this.formatTimestamp(this.currentTimestamp);
				process.stdout.write(`\n@${ts}Z [${this.agentName}]:\n`);
				process.stdout.write(this.textBuffer + "\n");
				this.textBuffer = "";
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				process.stdout.write(
					this.red(`[Error: ${message.errorMessage || message.stopReason}]\n`),
				);
			}
		}
	}

	onToolExecutionStart(toolName: string, args: unknown): void {
		const argsStr =
			typeof args === "object" && args !== null
				? JSON.stringify(args)
				: String(args);
		process.stdout.write(`\n[${this.cyan(toolName)}] ${argsStr}\n`);
	}

	onToolExecutionEnd(
		toolName: string,
		result: unknown,
		isError: boolean,
	): void {
		let output = "";
		if (
			result &&
			typeof result === "object" &&
			"content" in result &&
			Array.isArray((result as { content?: unknown }).content)
		) {
			for (const block of (result as { content: Array<{ type?: string; text?: string }> }).content) {
				if (block.type === "text" && block.text) {
					output += block.text;
				}
			}
		} else if (typeof result === "string") {
			output = result;
		} else if (result !== undefined && result !== null) {
			output = JSON.stringify(result, null, 2);
		}

		if (output) {
			const lines = output.split("\n");
			for (const line of lines) {
				process.stdout.write(`> ${line}\n`);
			}
		}

		if (isError) {
			process.stdout.write(this.red(`[${toolName} error]\n`));
		}
	}

	onAutoRetryStart(
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	): void {
		process.stdout.write(
			this.gray(
				`\n[Retry ${attempt}/${maxAttempts} in ${delayMs}ms: ${errorMessage}]\n`,
			),
		);
	}

	onAutoRetryEnd(success: boolean, attempt: number, finalError?: string): void {
		if (!success) {
			process.stdout.write(
				this.red(`\n[Retry failed after ${attempt} attempts: ${finalError || "unknown error"}]\n`),
			);
		}
	}
}
