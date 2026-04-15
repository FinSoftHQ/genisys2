import process from "process";

export class Formatter {
	private isTTY = process.stdout.isTTY;
	private textBuffer = "";

	private gray(text: string): string {
		return this.isTTY ? `\x1b[90m${text}\x1b[0m` : text;
	}

	private red(text: string): string {
		return this.isTTY ? `\x1b[91m${text}\x1b[0m` : text;
	}

	private cyan(text: string): string {
		return this.isTTY ? `\x1b[36m${text}\x1b[0m` : text;
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

	onMessageStart(message: { role?: string }): void {
		if (message.role === "assistant") {
			this.textBuffer = "";
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
				process.stdout.write(this.gray("\n(thinking: "));
				break;
			case "thinking_delta":
				process.stdout.write(this.gray(ame.delta ?? ""));
				break;
			case "thinking_end":
				process.stdout.write(this.gray(")\n"));
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

	onMessageEnd(message: {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
	}): void {
		if (message.role === "assistant") {
			const hadText = this.textBuffer.length > 0;
			if (hadText) {
				process.stdout.write(this.textBuffer);
				this.textBuffer = "";
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				process.stdout.write(
					this.red(`\n[Error: ${message.errorMessage || message.stopReason}]\n`),
				);
			} else if (hadText) {
				process.stdout.write("\n");
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
