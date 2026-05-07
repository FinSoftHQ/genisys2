import fs from "fs";

export interface Protocol {
	team: Record<string, string>;
	body: string;
	repo?: string;
	teamName?: string;
	routes?: Record<string, string[]>;
	facilitator?: string;
	tailorShop?: string;
	workingDir?: string;
	instructions?: Record<string, string>;
}

function dedentLines(lines: string[]): string {
	// Find minimum indentation across non-empty lines
	let minIndent = Infinity;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const match = line.match(/^[ \t]+/);
		if (match) {
			minIndent = Math.min(minIndent, match[0].length);
		} else {
			minIndent = 0;
			break;
		}
	}
	if (minIndent === Infinity || minIndent === 0) {
		return lines.join("\n");
	}
	return lines.map((line) => line.slice(minIndent)).join("\n");
}

export function parseProtocolFromString(content: string, options?: { requireTeam?: boolean }): Protocol {
	if (!content.startsWith("---")) {
		throw new Error("Expected front matter starting with ---");
	}

	const endIdx = content.indexOf("\n---", 3);
	if (endIdx === -1) {
		throw new Error("Expected closing --- for front matter");
	}

	const frontMatter = content.slice(3, endIdx).trim();
	const body = content.slice(endIdx + 4).trimStart();

	const team: Record<string, string> = {};
	const routes: Record<string, string[]> = {};
	let facilitator: string | undefined;
	let tailorShop: string | undefined;
	let workingDir: string | undefined;
	let repo: string | undefined;
	let teamName: string | undefined;
	const instructions: Record<string, string> = {};
	const lines = frontMatter.split("\n");
	let inTeam = false;
	let inRoutes = false;
	let inInstructions = false;
	let currentRouteAgent: string | null = null;
	let instructionsMultiLineKey: string | null = null;
	let instructionsMultiLineLines: string[] = [];
	let teamMultiLineKey: string | null = null;
	let teamMultiLineLines: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");

		if (line.startsWith("team_name:")) {
			inTeam = false;
			inRoutes = false;
			inInstructions = false;
			currentRouteAgent = null;
			teamName = line.slice("team_name:".length).trim();
			continue;
		}
		if (line.startsWith("team:")) {
			inTeam = true;
			inRoutes = false;
			inInstructions = false;
			currentRouteAgent = null;
			continue;
		}
		if (line.startsWith("routes:")) {
			inRoutes = true;
			inTeam = false;
			inInstructions = false;
			currentRouteAgent = null;
			continue;
		}
		if (line.startsWith("tailor_shop:")) {
			inTeam = false;
			inRoutes = false;
			inInstructions = false;
			currentRouteAgent = null;
			tailorShop = line.slice("tailor_shop:".length).trim();
			continue;
		}
		if (line.startsWith("working_dir:")) {
			inTeam = false;
			inRoutes = false;
			inInstructions = false;
			currentRouteAgent = null;
			workingDir = line.slice("working_dir:".length).trim();
			continue;
		}
		if (line.startsWith("instructions:")) {
			inTeam = false;
			inRoutes = false;
			inInstructions = true;
			currentRouteAgent = null;
			continue;
		}
		if (line.startsWith("facilitator:")) {
			inTeam = false;
			inRoutes = false;
			inInstructions = false;
			currentRouteAgent = null;
			facilitator = line.slice("facilitator:".length).trim();
			continue;
		}
		if (line.startsWith("repo:")) {
			inTeam = false;
			inRoutes = false;
			inInstructions = false;
			currentRouteAgent = null;
			repo = line.slice("repo:".length).trim();
			continue;
		}

		if (inTeam) {
			if (teamMultiLineKey !== null) {
				if (line.startsWith("  ") || line.startsWith("\t")) {
					const content = line.replace(/^[ \t]{2}/, "");
					teamMultiLineLines.push(content);
					continue;
				}
				if (line.trim() === "") {
					teamMultiLineLines.push("");
					continue;
				}
				team[teamMultiLineKey] = teamMultiLineLines.join("\n");
				teamMultiLineKey = null;
				teamMultiLineLines = [];
			}
			if (line.startsWith("  ") || line.startsWith("\t")) {
				const trimmed = line.trim();
				const colonIdx = trimmed.indexOf(":");
				if (colonIdx !== -1) {
					const name = trimmed.slice(0, colonIdx).trim();
					const role = trimmed.slice(colonIdx + 1).trim();
					if (role === "|" || role.startsWith("| ")) {
						teamMultiLineKey = name;
						teamMultiLineLines = [];
					} else {
						team[name] = role;
					}
				}
			} else if (line.trim() !== "") {
				inTeam = false;
			}
		}

		if (inRoutes) {
			if (line.startsWith("  ") || line.startsWith("\t")) {
				const trimmed = line.trim();
				if (trimmed.startsWith("- ")) {
					if (currentRouteAgent) {
						routes[currentRouteAgent].push(trimmed.slice(2).trim());
					}
				} else {
					const colonIdx = trimmed.indexOf(":");
					if (colonIdx !== -1) {
						const name = trimmed.slice(0, colonIdx).trim();
						currentRouteAgent = name;
						if (!routes[currentRouteAgent]) {
							routes[currentRouteAgent] = [];
						}
					}
				}
			} else if (line.trim() !== "") {
				inRoutes = false;
				currentRouteAgent = null;
			}
		}

		if (inInstructions) {
			if (instructionsMultiLineKey !== null) {
				if (line.startsWith("  ") || line.startsWith("\t")) {
					const content = line.replace(/^[ \t]{2}/, "");
					instructionsMultiLineLines.push(content);
					continue;
				}
				if (line.trim() === "") {
					instructionsMultiLineLines.push("");
					continue;
				}
				instructions[instructionsMultiLineKey] = instructionsMultiLineLines.join("\n");
				instructionsMultiLineKey = null;
				instructionsMultiLineLines = [];
			}
			if (line.startsWith("  ") || line.startsWith("\t")) {
				const trimmed = line.trim();
				const colonIdx = trimmed.indexOf(":");
				if (colonIdx !== -1) {
					const name = trimmed.slice(0, colonIdx).trim();
					const value = trimmed.slice(colonIdx + 1).trim();
					if (value === "|" || value.startsWith("| ")) {
						instructionsMultiLineKey = name;
						instructionsMultiLineLines = [];
					} else {
						instructions[name] = value;
					}
				}
			} else if (line.trim() !== "") {
				inInstructions = false;
			}
		}
	}

	if (teamMultiLineKey !== null) {
		team[teamMultiLineKey] = dedentLines(teamMultiLineLines);
	}
	if (instructionsMultiLineKey !== null) {
		instructions[instructionsMultiLineKey] = dedentLines(instructionsMultiLineLines);
	}

	if ((options?.requireTeam ?? true) && Object.keys(team).length === 0) {
		throw new Error("No team members found in front matter");
	}

	return {
		team,
		body,
		...(repo ? { repo } : {}),
		...(teamName ? { teamName } : {}),
		...(Object.keys(routes).length > 0 ? { routes } : {}),
		...(facilitator ? { facilitator } : {}),
		...(tailorShop ? { tailorShop } : {}),
		...(workingDir ? { workingDir } : {}),
		...(Object.keys(instructions).length > 0 ? { instructions } : {}),
	};
}

export function parseProtocol(filePath: string, options?: { requireTeam?: boolean }): Protocol {
	const content = fs.readFileSync(filePath, "utf-8");
	return parseProtocolFromString(content, options);
}

export function parseAgentPromptFile(content: string): {
	model?: string;
	execution: string;
	body: string;
} {
	if (!content.startsWith("---")) {
		return { execution: "session", body: content };
	}

	const endIdx = content.indexOf("\n---", 3);
	if (endIdx === -1) {
		return { execution: "session", body: content };
	}

	const frontMatter = content.slice(3, endIdx).trim();
	const body = content.slice(endIdx + 4).trimStart();

	const modelMatch = frontMatter.match(/^model:\s*(.+)$/m);
	const executionMatch = frontMatter.match(/^execution:\s*(.+)$/m);
	return {
		model: modelMatch ? modelMatch[1].trim() : undefined,
		execution: executionMatch ? executionMatch[1].trim() : "session",
		body,
	};
}
