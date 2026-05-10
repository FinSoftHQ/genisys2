import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { parseAgentPromptFile } from "@repo/shared";
import type { Room, AgentState, ExecutionMode } from "@repo/agent-rooms-core";

let pathDeprecationWarned = false;

export function killAgentProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	try {
		if (proc.pid !== undefined && process.platform !== "win32") {
			process.kill(-proc.pid, signal);
			return;
		}
	} catch {
		// process may have already exited
	}
	try {
		proc.kill(signal);
	} catch {
		// ignore
	}
}

export async function killAgentProcessWithEscalation(
	proc: ChildProcess,
	timeoutMs = 3000,
): Promise<void> {
	killAgentProcess(proc, "SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, timeoutMs));
	if (!proc.killed) {
		killAgentProcess(proc, "SIGKILL");
	}
}

export function sendToAgent(agent: AgentState, cmd: object): void {
	if (!agent.proc) {
		console.warn(
			`[agent-rooms] sendToAgent: agent "${agent.name}" has no active process — message dropped.`,
		);
		return;
	}
	agent.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
}

export function buildPiArgs(
	agentName: string,
	role: string,
	tailorShop: string | undefined,
	bodyPromptPath: string,
	roomPromptDir: string,
	workingDir?: string,
): { args: string[]; executionMode: ExecutionMode } {
	const args = ["--mode", "rpc", "--no-session"];
	let executionMode: ExecutionMode = "session";

	// 1. Working directory prompt as first system prompt
	const cwdPromptPath = join(roomPromptDir, `${agentName}.cwd.prompt`);
	const effectiveCwd = workingDir ?? process.cwd();
	writeFileSync(
		cwdPromptPath,
		`[SYSTEM WORKING DIRECTORY] Your current working directory is: ${effectiveCwd}\n` +
			`This directory IS your project root. All code, tests, and files you create must be written relative to this directory.\n` +
			`All relative paths in read, write, and edit operations are resolved from this directory.\n` +
			`When running tests, use explicit file paths (e.g., vitest run src/apps/api/path/to/file.test.ts).\n` +
			`process.cwd() inside this environment will return the path shown above.\n` +
			`This workspace is a git clone of the project. If body text or instructions mention absolute paths from the original repository, treat them as relative to this workspace directory.\n` +
			`Do not change directory or write files outside this directory unless explicitly instructed.\n\n`,
		"utf-8",
	);
	args.push("--append-system-prompt", cwdPromptPath);

	// 2. Agent identity notification
	const identityPromptPath = join(roomPromptDir, `${agentName}.identity.prompt`);
	writeFileSync(
		identityPromptPath,
		`[SYSTEM IDENTITY NOTIFICATION] You are ${agentName}, the ${role}.\n\n`,
		"utf-8",
	);
	args.push("--append-system-prompt", identityPromptPath);

	// 3. Protocol body as system prompt
	args.push("--append-system-prompt", bodyPromptPath);

	if (tailorShop) {
		// Resolve tailorShop to absolute so pi can find it regardless of cwd
		const resolvedTailorShop = isAbsolute(tailorShop)
			? tailorShop
			: resolve(workingDir ?? process.cwd(), tailorShop);

		// 4. Agent-specific prompt file: name first, then role fallback
		const namePath = join(resolvedTailorShop, "agents", `${agentName}.md`);
		const rolePath = join(resolvedTailorShop, "agents", `${role}.md`);

		let resolvedPath: string | undefined;
		let resolvedContent: string | undefined;

		if (existsSync(namePath)) {
			resolvedPath = namePath;
			resolvedContent = readFileSync(namePath, "utf-8");
		} else if (existsSync(rolePath)) {
			resolvedPath = rolePath;
			resolvedContent = readFileSync(rolePath, "utf-8");
		}

		if (resolvedPath && resolvedContent) {
			const parsed = parseAgentPromptFile(resolvedContent);
			if (parsed.model) {
				args.push("--model", parsed.model);
			}

			const VALID_EXECUTION_MODES = ["session", "single-shot"] as const;
			if ((VALID_EXECUTION_MODES as readonly string[]).includes(parsed.execution)) {
				executionMode = parsed.execution as ExecutionMode;
			} else {
				console.warn(
					`[agent-rooms] Unknown execution value "${parsed.execution}" for agent "${agentName}". Expected "session" or "single-shot". Defaulting to "session".`,
				);
			}

			if (resolvedContent.startsWith("---") && parsed.body) {
				// Write stripped body to a temp file so pi doesn't ingest raw YAML
				const promptFile = join(roomPromptDir, `${agentName}.prompt`);
				writeFileSync(promptFile, parsed.body, "utf-8");
				args.push("--append-system-prompt", promptFile);
			} else {
				// No front matter (or empty body) — pass original file path directly
				args.push("--append-system-prompt", resolvedPath);
			}
		} else {
			console.warn("[agent-rooms] tailor_shop agent prompt not found:", namePath);
		}

		// 5. Optional shared working protocol
		const workingPath = join(resolvedTailorShop, "working_protocol.md");
		if (existsSync(workingPath)) {
			const workingContent = readFileSync(workingPath, "utf-8");
			const parsedWorking = parseAgentPromptFile(workingContent);
			if (workingContent.startsWith("---") && parsedWorking.body) {
				// Write stripped body to a temp file so pi doesn't ingest raw YAML
				const promptFile = join(roomPromptDir, "working_protocol.prompt");
				writeFileSync(promptFile, parsedWorking.body, "utf-8");
				args.push("--append-system-prompt", promptFile);
			} else {
				// No front matter (or empty body) — pass original file path directly
				args.push("--append-system-prompt", workingPath);
			}
		}
	}

	return { args, executionMode };
}

export function spawnAgentProcess(room: Room, agent: AgentState): ChildProcess {
	const env = { ...process.env };
	if (
		!pathDeprecationWarned &&
		(process.env.PATH ?? "").split(":").some((segment) => segment.endsWith("node_modules/.bin"))
	) {
		pathDeprecationWarned = true;
		console.warn("[agent-rooms] Deprecated PATH setup detected (node_modules/.bin). The supervisor no longer rewrites PATH.");
	}

	const spawnCwd = room.workingDir ?? process.cwd();
	console.log(`[agent-rooms] Spawning agent "${agent.name}" in room ${room.id} with cwd: ${spawnCwd}`);
	if (!room.workingDir) {
		console.warn(`[agent-rooms] WARNING: room ${room.id} has no workingDir; falling back to process.cwd()`);
	}

	const proc = spawn("pi", agent.piArgs, {
		stdio: ["pipe", "pipe", "pipe"],
		env,
		detached: true,
		cwd: spawnCwd,
	});
	agent.proc = proc;

	proc.stderr!.on("data", (chunk: Buffer) => {
		const lines = chunk
			.toString("utf8")
			.split("\n")
			.filter((l) => l.trim());
		for (const line of lines) {
			console.warn(`[agent-rooms][stderr][${agent.name}] ${line}`);
		}
	});

	return proc;
}

export function terminateSingleShotAgent(agent: AgentState): void {
	if (!agent.proc) return;
	// Capture and null agent.proc BEFORE calling kill().
	// The exit handler uses `agent.proc !== proc` to detect deliberate termination.
	// Setting agent.proc = null first ensures the check works whether the exit event
	// fires synchronously (in tests) or asynchronously (in production with a real proc).
	const procToKill = agent.proc;
	agent.proc = null;
	agent.isStreaming = false;
	agent.status = "idle";
	agent.ready = false;
	try {
		procToKill.stdin!.write(`${JSON.stringify({ type: "abort" })}\n`);
		procToKill.stdin!.end();
		killAgentProcess(procToKill);
	} catch {
		// ignore — process may have already exited
	}
}

export async function waitForAllAgentsReady(room: Room): Promise<void> {
	await Promise.all(
		Array.from(room.agents.values())
			.filter((agent) => agent.proc !== null)
			.map((agent) => {
				if (agent.ready) return Promise.resolve();
				return new Promise<void>((resolve, reject) => {
					agent._readyResolve = resolve;
					agent._readyReject = reject;
				});
			}),
	);
}
