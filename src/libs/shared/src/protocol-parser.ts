import fs from "fs";

export interface Protocol {
	team: Record<string, string>;
	body: string;
	routes?: Record<string, string[]>;
}

export function parseProtocol(filePath: string): Protocol {
	const content = fs.readFileSync(filePath, "utf-8");

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
	const lines = frontMatter.split("\n");
	let inTeam = false;
	let inRoutes = false;
	let currentRouteAgent: string | null = null;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");

		if (line.startsWith("team:")) {
			inTeam = true;
			inRoutes = false;
			currentRouteAgent = null;
			continue;
		}
		if (line.startsWith("routes:")) {
			inRoutes = true;
			inTeam = false;
			currentRouteAgent = null;
			continue;
		}

		if (inTeam) {
			if (line.startsWith("  ") || line.startsWith("\t")) {
				const trimmed = line.trim();
				const colonIdx = trimmed.indexOf(":");
				if (colonIdx !== -1) {
					const name = trimmed.slice(0, colonIdx).trim();
					const role = trimmed.slice(colonIdx + 1).trim();
					team[name] = role;
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
	}

	if (Object.keys(team).length === 0) {
		throw new Error("No team members found in front matter");
	}

	return { team, body, ...(Object.keys(routes).length > 0 ? { routes } : {}) };
}
