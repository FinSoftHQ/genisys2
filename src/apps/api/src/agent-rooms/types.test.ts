import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoomsDir = resolve(__dirname);

function getTsSourceFiles(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules") {
			files.push(...getTsSourceFiles(fullPath));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			files.push(fullPath);
		}
	}
	return files;
}

const allSourceFiles = getTsSourceFiles(agentRoomsDir);
const typesFile = allSourceFiles.find((f) => f.endsWith("/types.ts"))!;
const typesSource = readFileSync(typesFile, "utf-8");
const managerFile = allSourceFiles.find((f) => f.endsWith("/manager.ts"))!;

function getRelativePath(absolutePath: string): string {
	return absolutePath.replace(agentRoomsDir + "/", "");
}

const CANONICAL_DOMAIN_TYPES = [
	"Room",
	"AgentState",
	"StoredEvent",
	"RoomStatus",
	"RoutingStrategy",
	"RoomCloseReason",
	"ExecutionMode",
	"StoredEventInput",
	"ReturnedEvent",
	"RoomCreateOptions",
];

describe("Phase 2.1.1 — single canonical declaration site", () => {
	it.each(CANONICAL_DOMAIN_TYPES)(
		"declares %s in types.ts",
		(typeName) => {
			const pattern = new RegExp(
				`\\b(?:export\\s+)?(?:interface|type)\\s+${typeName}\\b`,
			);
			expect(typesSource).toMatch(pattern);
		},
	);

	it.each(CANONICAL_DOMAIN_TYPES)(
		"does not re-declare %s in any other agent-rooms file",
		(typeName) => {
			for (const file of allSourceFiles) {
				if (file === typesFile) continue;
				const source = readFileSync(file, "utf-8");
				const pattern = new RegExp(
					`\\b(?:interface|type)\\s+${typeName}\\b`,
				);
				expect(
					source,
					`${getRelativePath(file)} re-declares ${typeName}`,
				).not.toMatch(pattern);
			}
		},
	);
});

describe("Phase 2.1.1 — internal references point to types.ts", () => {
	it("every file that imports domain types does so from types.ts", () => {
		for (const file of allSourceFiles) {
			if (file === typesFile) continue;
			const source = readFileSync(file, "utf-8");

			// Find type imports: import type { ... } from '...'
			const typeImportRegex =
				/import\s+type\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
			let match: RegExpExecArray | null;
			while ((match = typeImportRegex.exec(source)) !== null) {
				const importedTypes = match[1];
				const fromPath = match[2];
				const importsDomainType = CANONICAL_DOMAIN_TYPES.some((t) =>
					importedTypes.includes(t),
				);
				if (importsDomainType) {
					const isFromTypesTs =
						fromPath.endsWith("/types.js") ||
						fromPath === "./types.js" ||
						fromPath === "../types.js";
					expect(
						isFromTypesTs,
						`${getRelativePath(file)} imports domain types from ${fromPath} instead of types.ts`,
					).toBe(true);
				}
			}
		}
	});
});

describe("Phase 2.1.1 — no import cycles introduced", () => {
	function buildImportGraph(files: string[]): Map<string, Set<string>> {
		const graph = new Map<string, Set<string>>();
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			const imports: string[] = [];
			const regex = /from\s+['"]([^'"]+)['"]/g;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(source)) !== null) {
				imports.push(match[1]);
			}
			graph.set(file, new Set(imports));
		}
		return graph;
	}

	function resolveImport(fromFile: string, importPath: string): string | null {
		if (!importPath.startsWith(".")) return null;
		const fromDir = resolve(fromFile, "..");
		let resolved = resolve(fromDir, importPath);
		resolved = resolved.replace(/\.js$/, ".ts");

		const exactFile = resolved.endsWith(".ts")
			? resolved
			: resolved + ".ts";
		if (allSourceFiles.includes(exactFile)) return exactFile;

		const indexFile = resolved.endsWith(".ts")
			? resolve(resolved, "..", "index.ts")
			: join(resolved, "index.ts");
		if (allSourceFiles.includes(indexFile)) return indexFile;

		return null;
	}

	it("agent-rooms module graph is acyclic", () => {
		const graph = buildImportGraph(allSourceFiles);
		const visited = new Set<string>();
		const recursionStack = new Set<string>();

		function hasCycle(file: string): boolean {
			visited.add(file);
			recursionStack.add(file);
			for (const imp of graph.get(file) || []) {
				const resolved = resolveImport(file, imp);
				if (!resolved) continue;
				if (!visited.has(resolved)) {
					if (hasCycle(resolved)) return true;
				} else if (recursionStack.has(resolved)) {
					return true;
				}
			}
			recursionStack.delete(file);
			return false;
		}

		for (const file of allSourceFiles) {
			if (!visited.has(file)) {
				expect(
					hasCycle(file),
					`import cycle detected involving ${getRelativePath(file)}`,
				).toBe(false);
			}
		}
	});
});

describe("Phase 2.1.1 — manager.ts runtime export contract", () => {
	it("exports createRoom, createRoomFromMarkdown, and spawnAndSendToSingleShot", async () => {
		const manager = await import("./manager.js");
		expect(typeof manager.createRoom).toBe("function");
		expect(typeof manager.createRoomFromMarkdown).toBe("function");
		expect(typeof manager.spawnAndSendToSingleShot).toBe("function");
	});

	it("does not re-export domain types at runtime", async () => {
		const manager = await import("./manager.js");
		expect("Room" in manager).toBe(false);
		expect("AgentState" in manager).toBe(false);
		expect("StoredEvent" in manager).toBe(false);
		expect("RoomStatus" in manager).toBe(false);
	});

	it("manager.ts source still contains runtime exports (no export drift)", () => {
		const source = readFileSync(managerFile, "utf-8");
		expect(source).toMatch(/export\s+(?:async\s+)?function\s+createRoom\b/);
		expect(source).toMatch(/export\s+(?:async\s+)?function\s+createRoomFromMarkdown\b/);
		expect(source).toMatch(/export\s+(?:async\s+)?function\s+spawnAndSendToSingleShot\b/);
	});
});

describe("Phase 2.1.1 — type shape preservation", () => {
	it("RoomStatus has all expected literal values", () => {
		const expected = [
			"initialized",
			"running",
			"suspended",
			"error",
			"completed",
		];
		for (const value of expected) {
			expect(typesSource).toContain(`"${value}"`);
		}
	});

	it("RoomCloseReason has all expected literal values", () => {
		const expected = ["completed", "manual", "expired"];
		for (const value of expected) {
			expect(typesSource).toContain(`"${value}"`);
		}
	});

	it("RoutingStrategy has all expected literal values", () => {
		const expected = ["broadcast", "explicit"];
		for (const value of expected) {
			expect(typesSource).toContain(`"${value}"`);
		}
	});

	it("StoredEvent is a discriminated union with expected types", () => {
		const expectedTypes = [
			"thinking",
			"message",
			"tool_start",
			"tool_end",
			"retry_start",
			"retry_end",
			"agent_start",
			"agent_end",
			"room_error",
			"room_closed",
		];
		for (const typeName of expectedTypes) {
			expect(typesSource).toContain(`type: "${typeName}"`);
		}
	});
});

describe("Phase 2.1.1 — types.ts self-containedness", () => {
	it("types.ts does not import from other agent-rooms modules", () => {
		const source = readFileSync(typesFile, "utf-8");
		const regex = /from\s+['"]([^'"]+)['"]/g;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(source)) !== null) {
			const fromPath = match[1];
			if (fromPath.startsWith(".")) {
				// Only allowed internal import is internal/room-logger (type-only)
				expect(fromPath).toMatch(/^\.\/internal\/room-logger\.js$/);
			}
		}
	});
});
