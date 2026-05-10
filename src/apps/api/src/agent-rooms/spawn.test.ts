import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChildProcess } from "child_process";
import {
	buildPiArgs,
	sendToAgent,
	killAgentProcess,
	spawnAgentProcess,
	terminateSingleShotAgent,
	waitForAllAgentsReady,
} from "./spawn.js";
import type { AgentState, Room } from "./types.js";

vi.mock("child_process", () => ({
	spawn: vi.fn(() => ({
		pid: 12345,
		stdin: { write: vi.fn(), end: vi.fn() },
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn() },
		on: vi.fn(),
		kill: vi.fn(),
	})),
}));

import { spawn as mockSpawn } from "child_process";

describe("spawn", () => {
	describe("sendToAgent", () => {
		it("writes JSON command to agent stdin", () => {
			const writeFn = vi.fn();
			const agent = {
				name: "alpha",
				proc: { stdin: { write: writeFn } },
			} as unknown as AgentState;
			sendToAgent(agent, { type: "get_state" });
			expect(writeFn).toHaveBeenCalledWith('{"type":"get_state"}\n');
		});

		it("warns and drops message when agent has no process", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const agent = { name: "alpha", proc: null } as unknown as AgentState;
			sendToAgent(agent, { type: "get_state" });
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("no active process"),
			);
			warnSpy.mockRestore();
		});
	});

	describe("killAgentProcess", () => {
		it("kills process group on non-Windows when pid is defined", () => {
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			const proc = { pid: 12345, kill: vi.fn() } as unknown as ChildProcess;
			killAgentProcess(proc);
			expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
			killSpy.mockRestore();
		});

		it("falls back to proc.kill when pid is undefined", () => {
			const procKill = vi.fn();
			const proc = { pid: undefined, kill: procKill } as unknown as ChildProcess;
			killAgentProcess(proc);
			expect(procKill).toHaveBeenCalledWith("SIGTERM");
		});
	});

	describe("spawnAgentProcess", () => {
		afterEach(() => {
			vi.mocked(mockSpawn).mockClear();
		});

		it("spawns pi with correct args and sets agent.proc", () => {
			const mockProc = {
				pid: 12345,
				stdin: { write: vi.fn(), end: vi.fn() },
				stdout: { on: vi.fn() },
				stderr: { on: vi.fn() },
				on: vi.fn(),
				kill: vi.fn(),
			};
			vi.mocked(mockSpawn).mockReturnValue(mockProc as unknown as ChildProcess);

			const room = {
				id: "test-room",
				workingDir: "/tmp/work",
			} as unknown as Room;
			const agent = {
				name: "alpha",
				piArgs: ["--mode", "rpc"],
				proc: null,
			} as unknown as AgentState;

			const proc = spawnAgentProcess(room, agent);
			expect(proc).toBe(mockProc);
			expect(agent.proc).toBe(mockProc);
			expect(mockSpawn).toHaveBeenCalledWith(
				"pi",
				["--mode", "rpc"],
				expect.objectContaining({
					cwd: "/tmp/work",
					detached: true,
					stdio: ["pipe", "pipe", "pipe"],
				}),
			);
		});

		it("falls back to process.cwd when room has no workingDir", () => {
			const mockProc = {
				pid: 12345,
				stdin: { write: vi.fn(), end: vi.fn() },
				stdout: { on: vi.fn() },
				stderr: { on: vi.fn() },
				on: vi.fn(),
				kill: vi.fn(),
			};
			vi.mocked(mockSpawn).mockReturnValue(mockProc as unknown as ChildProcess);

			const room = { id: "test-room" } as unknown as Room;
			const agent = {
				name: "alpha",
				piArgs: ["--mode", "rpc"],
				proc: null,
			} as unknown as AgentState;

			spawnAgentProcess(room, agent);
			const [, , options] = vi.mocked(mockSpawn).mock.calls[0] as [
				string,
				string[],
				{ cwd?: string },
			];
			expect(options.cwd).toBe(process.cwd());
		});
	});

	describe("terminateSingleShotAgent", () => {
		it("sends abort, ends stdin, kills process, and resets agent state", () => {
			const writeFn = vi.fn();
			const endFn = vi.fn();
			const killFn = vi.fn();
			const proc = {
				stdin: { write: writeFn, end: endFn },
				kill: killFn,
			} as unknown as ChildProcess;
			const agent = {
				name: "alpha",
				proc,
				isStreaming: true,
				status: "streaming",
				ready: true,
			} as unknown as AgentState;

			terminateSingleShotAgent(agent);
			expect(writeFn).toHaveBeenCalledWith('{"type":"abort"}\n');
			expect(endFn).toHaveBeenCalled();
			expect(killFn).toHaveBeenCalledWith("SIGTERM");
			expect(agent.proc).toBeNull();
			expect(agent.isStreaming).toBe(false);
			expect(agent.status).toBe("idle");
			expect(agent.ready).toBe(false);
		});

		it("is a no-op when agent has no process", () => {
			const agent = {
				name: "alpha",
				proc: null,
				isStreaming: true,
				status: "streaming",
			} as unknown as AgentState;

			terminateSingleShotAgent(agent);
			expect(agent.proc).toBeNull();
			expect(agent.isStreaming).toBe(true);
		});
	});

	describe("waitForAllAgentsReady", () => {
		it("resolves immediately when all agents with proc are ready", async () => {
			const agent = {
				proc: { pid: 1 },
				ready: true,
			} as unknown as AgentState;
			const room = {
				agents: new Map([["a", agent]]),
			} as unknown as Room;
			await waitForAllAgentsReady(room);
			expect(true).toBe(true);
		});

		it("resolves when agent becomes ready", async () => {
			const agent = {
				proc: { pid: 1 },
				ready: false,
			} as unknown as AgentState;
			const room = {
				agents: new Map([["a", agent]]),
			} as unknown as Room;

			const promise = waitForAllAgentsReady(room);
			agent._readyResolve!();
			await promise;
			expect(true).toBe(true);
		});

		it("skips agents without proc", async () => {
			const agent = { proc: null, ready: false } as unknown as AgentState;
			const room = {
				agents: new Map([["a", agent]]),
			} as unknown as Room;
			await waitForAllAgentsReady(room);
			expect(true).toBe(true);
		});
	});

	describe("buildPiArgs", () => {
		let tailorDir: string;
		let roomPromptDir: string;
		let bodyPromptPath: string;
		let warnSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			roomPromptDir = mkdtempSync(join(tmpdir(), "room-prompts-"));
			bodyPromptPath = join(roomPromptDir, "body.prompt");
			writeFileSync(bodyPromptPath, "Protocol body", "utf-8");
		});

		afterEach(() => {
			warnSpy.mockRestore();
			if (tailorDir) {
				try {
					rmSync(tailorDir, { recursive: true, force: true });
				} catch {
					// ignore
				}
			}
			if (roomPromptDir) {
				try {
					rmSync(roomPromptDir, { recursive: true, force: true });
				} catch {
					// ignore
				}
			}
		});

		it("always appends cwd, identity, and body prompts", () => {
			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				undefined,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toEqual([
				"--mode",
				"rpc",
				"--no-session",
				"--append-system-prompt",
				join(roomPromptDir, "alpha.cwd.prompt"),
				"--append-system-prompt",
				join(roomPromptDir, "alpha.identity.prompt"),
				"--append-system-prompt",
				bodyPromptPath,
			]);
		});

		it("injects working directory prompt with absolute path when workingDir is provided", () => {
			const baseDir = mkdtempSync(join(tmpdir(), "cwd-test-"));
			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				undefined,
				bodyPromptPath,
				roomPromptDir,
				baseDir,
			);
			const cwdPromptPath = join(roomPromptDir, "alpha.cwd.prompt");
			expect(args).toContain(cwdPromptPath);
			expect(existsSync(cwdPromptPath)).toBe(true);
			const content = readFileSync(cwdPromptPath, "utf-8");
			expect(content).toContain(
				`Your current working directory is: ${baseDir}`,
			);
			expect(content).toContain(
				"This directory IS your project root. All code, tests, and files you create must be written relative to this directory.",
			);
			expect(content).toContain(
				"All relative paths in read, write, and edit operations are resolved from this directory.",
			);
			expect(content).toContain(
				"When running tests, use explicit file paths (e.g., vitest run src/apps/api/path/to/file.test.ts).",
			);
			expect(content).toContain(
				"process.cwd() inside this environment will return the path shown above.",
			);
			expect(content).toContain(
				"This workspace is a git clone of the project. If body text or instructions mention absolute paths from the original repository, treat them as relative to this workspace directory.",
			);
		});

		it("appends cwd, identity, agent role prompt, and working_protocol when both exist", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");
			writeFileSync(join(tailorDir, "working_protocol.md"), "Work hard.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toEqual([
				"--mode",
				"rpc",
				"--no-session",
				"--append-system-prompt",
				join(roomPromptDir, "alpha.cwd.prompt"),
				"--append-system-prompt",
				join(roomPromptDir, "alpha.identity.prompt"),
				"--append-system-prompt",
				bodyPromptPath,
				"--append-system-prompt",
				join(tailorDir, "agents", "alpha.md"),
				"--append-system-prompt",
				join(tailorDir, "working_protocol.md"),
			]);
		});

		it("falls back to role-based file when name-based is missing", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "Lead.md"), "You are a lead.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toContain(join(tailorDir, "agents", "Lead.md"));
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("prefers name-based file over role-based file", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");
			writeFileSync(join(agentsDir, "Lead.md"), "You are a lead.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toContain(join(tailorDir, "agents", "alpha.md"));
			expect(args).not.toContain(join(tailorDir, "agents", "Lead.md"));
		});

		it("extracts model from agent file front matter and writes stripped body to temp file", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "alpha.md"),
				"---\nmodel: gpt-4o\n---\n\nYou are alpha.",
				"utf-8",
			);

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toContain("--model");
			expect(args).toContain("gpt-4o");
			const tempPromptPath = join(roomPromptDir, "alpha.prompt");
			expect(existsSync(tempPromptPath)).toBe(true);
			expect(args).toContain(tempPromptPath);
		});

		it("passes original file path when agent file has no front matter", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toContain(join(tailorDir, "agents", "alpha.md"));
			expect(args).not.toContain(join(roomPromptDir, "alpha.prompt"));
		});

		it("extracts model from working_protocol front matter and writes stripped body to temp file", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");
			writeFileSync(
				join(tailorDir, "working_protocol.md"),
				"---\nmodel: gpt-4o\n---\n\nShared protocol body.",
				"utf-8",
			);

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			const tempPromptPath = join(roomPromptDir, "working_protocol.prompt");
			expect(existsSync(tempPromptPath)).toBe(true);
			expect(args).toContain(tempPromptPath);
			expect(args).not.toContain(join(tailorDir, "working_protocol.md"));
		});

		it("passes original working_protocol path when it has no front matter", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");
			writeFileSync(join(tailorDir, "working_protocol.md"), "Shared protocol body.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toContain(join(tailorDir, "working_protocol.md"));
			expect(args).not.toContain(join(roomPromptDir, "working_protocol.prompt"));
		});

		it("warns and skips missing agent prompt but still appends working_protocol", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			writeFileSync(join(tailorDir, "working_protocol.md"), "Work hard.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toEqual([
				"--mode",
				"rpc",
				"--no-session",
				"--append-system-prompt",
				join(roomPromptDir, "alpha.cwd.prompt"),
				"--append-system-prompt",
				join(roomPromptDir, "alpha.identity.prompt"),
				"--append-system-prompt",
				bodyPromptPath,
				"--append-system-prompt",
				join(tailorDir, "working_protocol.md"),
			]);
			expect(warnSpy).toHaveBeenCalledWith(
				"[agent-rooms] tailor_shop agent prompt not found:",
				join(tailorDir, "agents", "alpha.md"),
			);
		});

		it("warns when both agent prompt and working_protocol are missing", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(args).toEqual([
				"--mode",
				"rpc",
				"--no-session",
				"--append-system-prompt",
				join(roomPromptDir, "alpha.cwd.prompt"),
				"--append-system-prompt",
				join(roomPromptDir, "alpha.identity.prompt"),
				"--append-system-prompt",
				bodyPromptPath,
			]);
			expect(warnSpy).toHaveBeenCalledWith(
				"[agent-rooms] tailor_shop agent prompt not found:",
				join(tailorDir, "agents", "alpha.md"),
			);
		});

		it("defaults executionMode to session when no execution field in agent file", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");

			const { executionMode } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(executionMode).toBe("session");
		});

		it("resolves executionMode to session from explicit front matter", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "alpha.md"),
				"---\nexecution: session\n---\n\nYou are alpha.",
				"utf-8",
			);

			const { executionMode } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(executionMode).toBe("session");
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("resolves executionMode to single-shot from front matter", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "alpha.md"),
				"---\nexecution: single-shot\n---\n\nYou are alpha.",
				"utf-8",
			);

			const { executionMode } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(executionMode).toBe("single-shot");
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("warns for unknown execution value and falls back to session", () => {
			tailorDir = mkdtempSync(join(tmpdir(), "tailor-test-"));
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "alpha.md"),
				"---\nexecution: turbo\n---\n\nYou are alpha.",
				"utf-8",
			);

			const { executionMode } = buildPiArgs(
				"alpha",
				"Lead",
				tailorDir,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(executionMode).toBe("session");
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"turbo"'));
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("alpha"));
		});

		it("defaults executionMode to session when no tailorShop is provided", () => {
			const { executionMode } = buildPiArgs(
				"alpha",
				"Lead",
				undefined,
				bodyPromptPath,
				roomPromptDir,
			);
			expect(executionMode).toBe("session");
		});

		it("resolves relative tailorShop against workingDir when provided", () => {
			const baseDir = mkdtempSync(join(tmpdir(), "base-test-"));
			tailorDir = join(baseDir, "prompts");
			const agentsDir = join(tailorDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "alpha.md"), "You are alpha.", "utf-8");

			const { args } = buildPiArgs(
				"alpha",
				"Lead",
				"./prompts",
				bodyPromptPath,
				roomPromptDir,
				baseDir,
			);
			expect(args).toContain(join(tailorDir, "agents", "alpha.md"));
		});
	});
});
