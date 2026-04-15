import type * as readline from "readline";

export async function handleExtensionUiRequest(
	event: {
		id: string;
		method: string;
		title?: string;
		message?: string;
		options?: string[];
		notifyType?: string;
	},
	send: (cmd: object) => void,
	rl: readline.Interface,
): Promise<void> {
	const { id, method, title, message, options, notifyType } = event;

	const ask = (question: string): Promise<string> =>
		new Promise((resolve) => {
			rl.question(question, (answer) => resolve(answer));
		});

	switch (method) {
		case "select": {
			const opts = options ?? [];
			console.log(`\n[Extension] ${title ?? message ?? "Select an option:"}`);
			opts.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
			const answer = await ask("Choice (number): ");
			const idx = parseInt(answer.trim(), 10) - 1;
			const value = opts[idx] ?? opts[0] ?? "";
			send({ type: "extension_ui_response", id, value });
			break;
		}
		case "confirm": {
			const answer = await ask(
				`\n[Extension] ${title ?? message ?? "Confirm?"} (y/n): `,
			);
			send({
				type: "extension_ui_response",
				id,
				confirmed: answer.trim().toLowerCase().startsWith("y"),
			});
			break;
		}
		case "input": {
			const answer = await ask(
				`\n[Extension] ${title ?? message ?? "Input:"} `,
			);
			send({ type: "extension_ui_response", id, value: answer });
			break;
		}
		case "editor": {
			console.log(
				`\n[Extension] ${title ?? message ?? "Enter multi-line text (end with empty line):"}`,
			);
			const lines: string[] = [];
			while (true) {
				const line = await ask("");
				if (line === "") break;
				lines.push(line);
			}
			send({ type: "extension_ui_response", id, value: lines.join("\n") });
			break;
		}
		case "notify": {
			console.log(
				`\n[Extension notify${notifyType ? ` ${notifyType}` : ""}] ${title ?? message ?? ""}`,
			);
			// fire-and-forget: no response
			break;
		}
		case "setStatus":
		case "setWidget":
		case "setTitle":
		case "set_editor_text":
			// fire-and-forget: no response
			break;
		default: {
			// Unknown dialog type: cancel it
			send({ type: "extension_ui_response", id, cancelled: true });
			break;
		}
	}

	// Resume the normal prompt
	rl.prompt();
}
