import { describe, it, expect, vi } from "vitest";
import {
	determineRecipients,
	resolveMessageTargets,
	shouldCheckCompletionAfterTaskMarker,
	routeMessageToAgents,
} from "./router.js";
import type { Room, AgentState } from "./types.js";

describe("router", () => {
	describe("determineRecipients", () => {
		function makeRoom(
			routingStrategy: "broadcast" | "explicit",
			agents: Array<{ name: string; role: string }>,
			routes?: Record<string, string[]>,
			facilitator?: string,
		): Room {
			return {
				id: "test",
				status: "running",
				agents: new Map(
					agents.map((a) => [a.name, { name: a.name, role: a.role } as any]),
				),
				sseClients: new Set(),
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
				protocolBody: "",
				routingStrategy,
				routes,
				facilitator,
				events: [],
				eventSeq: 0,
				promptDir: "",
			} as Room;
		}

		it("broadcast mode sends to all other agents", () => {
			const room = makeRoom("broadcast", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
				{ name: "gamma", role: "Dev" },
			]);
			expect(determineRecipients(room, "alpha", "hello")).toEqual([
				"beta",
				"gamma",
			]);
		});

		it("explicit mode with static routes only", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
					{ name: "gamma", role: "Dev" },
				],
				{ alpha: ["beta"] },
			);
			expect(determineRecipients(room, "alpha", "hello")).toEqual(["beta"]);
		});

		it("explicit mode with @attn: tags only", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
				{ name: "gamma", role: "Dev" },
			]);
			expect(
				determineRecipients(room, "alpha", "hey @attn:gamma check this"),
			).toEqual(["gamma"]);
		});

		it("explicit mode combines static routes and @attn: tags", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
					{ name: "gamma", role: "Dev" },
				],
				{ alpha: ["beta"] },
			);
			expect(
				determineRecipients(room, "alpha", "hey @attn:gamma check this"),
			).toEqual(expect.arrayContaining(["beta", "gamma"]));
		});

		it("explicit mode deduplicates recipients", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
					{ name: "gamma", role: "Dev" },
				],
				{ alpha: ["beta"] },
			);
			expect(determineRecipients(room, "alpha", "hey @attn:beta")).toEqual([
				"beta",
			]);
		});

		it("explicit mode excludes self from static routes", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
				],
				{ alpha: ["alpha", "beta"] },
			);
			expect(determineRecipients(room, "alpha", "hello")).toEqual(["beta"]);
		});

		it("explicit mode excludes self from @attn: tags", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
			]);
			expect(determineRecipients(room, "alpha", "@attn:alpha")).toEqual([]);
		});

		it("explicit mode ignores non-existent agents in @attn:", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
			]);
			expect(
				determineRecipients(room, "alpha", "@attn:delta hello"),
			).toEqual([]);
		});

		it("explicit mode ignores non-existent agents in routes", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
				],
				{ alpha: ["delta"] },
			);
			expect(determineRecipients(room, "alpha", "hello")).toEqual([]);
		});

		it("explicit mode returns empty array when sender has no routes and no mentions", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
				],
				{ beta: ["alpha"] },
			);
			expect(determineRecipients(room, "alpha", "hello")).toEqual([]);
		});

		it("explicit mode resolves @attn: by role", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
				{ name: "gamma", role: "Dev" },
			]);
			expect(
				determineRecipients(room, "alpha", "hey @attn:Dev"),
			).toEqual(expect.arrayContaining(["beta", "gamma"]));
		});

		it("explicit mode resolves @attn: by role for multiple matching agents", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
				{ name: "gamma", role: "Dev" },
				{ name: "delta", role: "Dev" },
			]);
			expect(determineRecipients(room, "alpha", "@attn:Dev")).toEqual(
				expect.arrayContaining(["beta", "gamma", "delta"]),
			);
		});

		it("explicit mode deduplicates when name and role match the same agent", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
				{ name: "gamma", role: "Dev" },
			]);
			// @attn:beta matches by name, @attn:Dev matches by role (includes beta and gamma)
			expect(
				determineRecipients(room, "alpha", "@attn:beta @attn:Dev"),
			).toEqual(expect.arrayContaining(["beta", "gamma"]));
		});

		it("explicit mode excludes sender when mentioning own role", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Lead" },
				{ name: "gamma", role: "Dev" },
			]);
			// alpha mentions Lead role; alpha should be excluded, beta should receive
			expect(determineRecipients(room, "alpha", "@attn:Lead")).toEqual([
				"beta",
			]);
		});

		it("explicit mode ignores non-existent roles in @attn:", () => {
			const room = makeRoom("explicit", [
				{ name: "alpha", role: "Lead" },
				{ name: "beta", role: "Dev" },
			]);
			expect(
				determineRecipients(room, "alpha", "@attn:QA hello"),
			).toEqual([]);
		});
	});

	describe("completion flow helpers", () => {
		function makeRoom(
			routingStrategy: "broadcast" | "explicit",
			agents: Array<{ name: string; role: string; taskCompleted?: boolean }>,
			routes?: Record<string, string[]>,
			facilitator?: string,
		): Room {
			return {
				id: "test",
				status: "running",
				agents: new Map(
					agents.map((a) => [
						a.name,
						{
							name: a.name,
							role: a.role,
							taskCompleted: Boolean(a.taskCompleted),
						} as any,
					]),
				),
				sseClients: new Set(),
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
				protocolBody: "",
				routingStrategy,
				routes,
				facilitator,
				events: [],
				eventSeq: 0,
				promptDir: "",
			} as Room;
		}

		it("resolveMessageTargets returns explicit recipients first", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "beta", role: "Dev" },
					{ name: "fac", role: "Lead" },
				],
				{ alpha: ["beta"] },
				"fac",
			);
			expect(resolveMessageTargets(room, "alpha", "hello")).toEqual([
				"beta",
			]);
		});

		it("resolveMessageTargets falls back to facilitator when no recipients", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead" },
					{ name: "fac", role: "Lead" },
				],
				undefined,
				"fac",
			);
			expect(resolveMessageTargets(room, "alpha", "hello")).toEqual([
				"fac",
			]);
		});

		it("shouldCheckCompletionAfterTaskMarker is false when routing to incomplete target", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead", taskCompleted: true },
					{ name: "beta", role: "Dev", taskCompleted: false },
				],
				{ alpha: ["beta"] },
			);
			expect(
				shouldCheckCompletionAfterTaskMarker(room, "alpha", "done"),
			).toBe(false);
		});

		it("shouldCheckCompletionAfterTaskMarker is true when all targets already completed", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead", taskCompleted: true },
					{ name: "beta", role: "Dev", taskCompleted: true },
				],
				{ alpha: ["beta"] },
			);
			expect(
				shouldCheckCompletionAfterTaskMarker(room, "alpha", "done"),
			).toBe(true);
		});

		it("shouldCheckCompletionAfterTaskMarker is true when there are no targets", () => {
			const room = makeRoom(
				"explicit",
				[
					{ name: "alpha", role: "Lead", taskCompleted: true },
					{ name: "beta", role: "Dev", taskCompleted: false },
				],
			);
			expect(
				shouldCheckCompletionAfterTaskMarker(room, "alpha", "done"),
			).toBe(true);
		});
	});

	describe("routeMessageToAgents fallback protocol", () => {
		function makeAgent(name: string, isStreaming = false) {
			const writeFn = vi.fn();
			return {
				name,
				isStreaming,
				proc: { stdin: { write: writeFn } },
			} as any;
		}

		function makeRoom(
			routingStrategy: "broadcast" | "explicit",
			agents: any[],
			routes?: Record<string, string[]>,
			facilitator?: string,
		): Room {
			return {
				id: "test",
				status: "running",
				agents: new Map(agents.map((a) => [a.name, a])),
				sseClients: new Set(),
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
				protocolBody: "",
				routingStrategy,
				routes,
				facilitator,
				events: [],
				eventSeq: 0,
				promptDir: "",
			} as Room;
		}

		const mockDeps = {
			sendToAgent: (agent: AgentState, cmd: object) => {
				agent.proc?.stdin?.write(`${JSON.stringify(cmd)}\n`);
			},
			clearIdleCompletionTimeout: () => {},
			spawnAndSendToSingleShot: () => Promise.resolve(),
		};

		it("delivers original message when recipients exist", () => {
			const beta = makeAgent("beta");
			const room = makeRoom(
				"explicit",
				[makeAgent("alpha"), beta],
				{ alpha: ["beta"] },
			);
			routeMessageToAgents(room, "alpha", "hello", mockDeps);
			expect(beta.proc.stdin.write).toHaveBeenCalledWith(
				`${JSON.stringify({ type: "prompt", message: "[alpha]: hello" })}\n`,
			);
		});

		it("warns and drops message when no recipients and no facilitator", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const room = makeRoom("explicit", [makeAgent("alpha"), makeAgent("beta")]);
			routeMessageToAgents(room, "alpha", "hello", mockDeps);
			expect(warnSpy).toHaveBeenCalledWith(
				"[SYSTEM WARNING] Dropped message from alpha: no recipients and no facilitator configured.",
			);
			warnSpy.mockRestore();
		});

		it("sends wrapped message to facilitator when no recipients", () => {
			const facilitator = makeAgent("facilitator");
			const room = makeRoom(
				"explicit",
				[makeAgent("alpha"), makeAgent("beta"), facilitator],
				undefined,
				"facilitator",
			);
			routeMessageToAgents(room, "alpha", "hello", mockDeps);
			expect(facilitator.proc.stdin.write).toHaveBeenCalledWith(
				`${JSON.stringify({
					type: "prompt",
					message:
						"[SYSTEM_ROUTING_FAILURE]\n**Original Sender:** alpha\n**Status:** This message reached no one because no attention tags were used and no static routes exist.\n**Content:**\n> ---\nhello",
				})}\n`,
			);
		});

		it("logs critical error when facilitator is the sender with no recipients", () => {
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const facilitator = makeAgent("facilitator");
			const room = makeRoom(
				"explicit",
				[makeAgent("alpha"), facilitator],
				undefined,
				"facilitator",
			);
			routeMessageToAgents(room, "facilitator", "hello", mockDeps);
			expect(errorSpy).toHaveBeenCalledWith(
				"[CRITICAL ERROR] Facilitator facilitator sent a message with no recipients. This creates an infinite loop. Configure routes for the facilitator agent.",
			);
			expect(facilitator.proc.stdin.write).not.toHaveBeenCalled();
			errorSpy.mockRestore();
		});

		it("warns and drops when facilitator is defined but not in room", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const room = makeRoom(
				"explicit",
				[makeAgent("alpha"), makeAgent("beta")],
				undefined,
				"ghost",
			);
			routeMessageToAgents(room, "alpha", "hello", mockDeps);
			expect(warnSpy).toHaveBeenCalledWith(
				"[SYSTEM WARNING] Facilitator ghost not found in room. Dropping message from alpha.",
			);
			warnSpy.mockRestore();
		});
	});
});
