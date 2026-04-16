import process from "process";

export class SquadLogger {
	private isTTY = process.stdout.isTTY;
	private textBuffer = "";
	private thinkingBuffer = "";
	private currentTimestamp = Date.now();

	constructor(private agentName: string) {}

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
			default:
				break;
		}
	}

	private printThinking(): void {
		if (!this.thinkingBuffer) return;
		const ts = this.formatTimestamp(this.currentTimestamp);
		console.log(`@${ts}Z [${this.agentName}] (thinking):`);
		console.log(this.gray(this.thinkingBuffer));
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
				console.log(`@${ts}Z [${this.agentName}]:`);
				console.log(this.textBuffer);
				this.textBuffer = "";
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				console.log(
					this.red(`[Error: ${message.errorMessage || message.stopReason}]`),
				);
			}
		}
	}

	onToolExecutionStart(toolName: string, args: unknown): void {
		const argsStr =
			typeof args === "object" && args !== null
				? JSON.stringify(args)
				: String(args);
		console.log(`\n[${this.cyan(toolName)}] ${argsStr}`);
	}

	onToolExecutionEnd(toolName: string, result: unknown, isError: boolean): void {
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
			for (const line of output.split("\n")) {
				console.log(`> ${line}`);
			}
		}

		if (isError) {
			console.log(this.red(`[${toolName} error]`));
		}
	}

	onAutoRetryStart(
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	): void {
		console.log(
			this.gray(
				`[Retry ${attempt}/${maxAttempts} in ${delayMs}ms: ${errorMessage}]`,
			),
		);
	}

	onAutoRetryEnd(success: boolean, attempt: number, finalError?: string): void {
		if (!success) {
			console.log(
				this.red(`[Retry failed after ${attempt} attempts: ${finalError || "unknown error"}]`),
			);
		}
	}
}

export const loggingEnabled = process.env.LOG_SQUAD_EVENTS !== "false";
