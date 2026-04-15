import fs from "fs";

export interface Protocol {
	team: Record<string, string>;
	body: string;
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
	const lines = frontMatter.split("\n");
	let inTeam = false;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("team:")) {
			inTeam = true;
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
	}

	if (Object.keys(team).length === 0) {
		throw new Error("No team members found in front matter");
	}

	return { team, body };
}
