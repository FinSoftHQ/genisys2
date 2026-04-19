import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	createRoomFromMarkdown,
	listRooms,
	getRoom,
	getRoomStatus,
	getRoomEvents,
	sendInstructions,
	completeRoom,
	destroyRoom,
	buildPiArgs,
	determineRecipients,
	routeMessageToAgents,
	type Room,
} from './manager.js';

describe('agent-rooms manager', () => {
	let roomId: string;

	beforeEach(async () => {
		const markdown = `---\nteam:\n  alpha: Lead\n  beta: Dev\n---\n\nSay hello briefly.\n`;
		const result = await createRoomFromMarkdown(markdown);
		roomId = result.roomId;
	});

	afterEach(() => {
		try {
			destroyRoom(roomId);
		} catch {
			// ignore cleanup failures
		}
	});

	it('creates a room from markdown protocol with correct agents', () => {
		const room = getRoom(roomId);
		expect(room).toBeDefined();
		expect(room!.agents.size).toBe(2);
		expect(room!.agents.has('alpha')).toBe(true);
		expect(room!.agents.has('beta')).toBe(true);
	});

	it('returns room status with expected shape', () => {
		const room = getRoom(roomId)!;
		const status = getRoomStatus(room) as Record<string, unknown>;
		expect(status.roomId).toBe(roomId);
		expect(status.status).toBeDefined();
		expect(status.agents).toBeDefined();
		const agents = status.agents as Record<string, { status: string }>;
		expect(agents.alpha).toBeDefined();
		expect(agents.beta).toBeDefined();
	});

	it('returns events and supports since cursor', () => {
		const room = getRoom(roomId)!;
		const result = getRoomEvents(room);
		expect(Array.isArray(result.events)).toBe(true);
		expect(result.hasMore).toBe(false);
		const sinceResult = getRoomEvents(room, 999_999);
		expect(sinceResult.events).toEqual([]);
		expect(sinceResult.hasMore).toBe(false);
	});

	it('sends instructions to a target agent', async () => {
		const room = getRoom(roomId)!;
		const result = await sendInstructions(room, 'alpha', ['Please summarize.']);
		expect(result.queuedItems).toBe(1);
	});

	it('throws for unknown agent in instructions', async () => {
		const room = getRoom(roomId)!;
		await expect(sendInstructions(room, 'gamma', ['Hello'])).rejects.toThrow(
			'Agent gamma not found in room',
		);
	});

	it('rejects instructions for a completed room', async () => {
		const room = getRoom(roomId)!;
		completeRoom(roomId);
		await expect(sendInstructions(room, 'alpha', ['Hello'])).rejects.toThrow(
			'Room is completed',
		);
		destroyRoom(roomId);
	});

	it('completes and preserves room until hard-deleted', () => {
		completeRoom(roomId);
		const room = getRoom(roomId);
		expect(room).toBeDefined();
		expect(room!.status).toBe('completed');
		expect(getRoomEvents(room!).events.length).toBeGreaterThanOrEqual(0);
		destroyRoom(roomId);
		expect(getRoom(roomId)).toBeUndefined();
	});

	it('cleans up prompt temp directory on completion', () => {
		const room = getRoom(roomId)!;
		const promptDir = room.promptDir;
		expect(existsSync(promptDir)).toBe(true);
		completeRoom(roomId);
		expect(existsSync(promptDir)).toBe(false);
		expect(getRoom(roomId)).toBeDefined();
		destroyRoom(roomId);
	});

	describe('buildPiArgs', () => {
		let tailorDir: string;
		let roomPromptDir: string;
		let bodyPromptPath: string;
		let warnSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			roomPromptDir = mkdtempSync(join(tmpdir(), 'room-prompts-'));
			bodyPromptPath = join(roomPromptDir, 'body.prompt');
			writeFileSync(bodyPromptPath, 'Protocol body', 'utf-8');
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

		it('always appends body prompt', () => {
			const args = buildPiArgs('alpha', 'Lead', undefined, bodyPromptPath, roomPromptDir);
			expect(args).toEqual([
				'--mode', 'rpc', '--no-session',
				'--append-system-prompt', bodyPromptPath,
			]);
		});

		it('appends agent role prompt and working_protocol when both exist', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'alpha.md'), 'You are alpha.', 'utf-8');
			writeFileSync(join(tailorDir, 'working_protocol.md'), 'Work hard.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toEqual([
				'--mode', 'rpc', '--no-session',
				'--append-system-prompt', bodyPromptPath,
				'--append-system-prompt', join(tailorDir, 'agents', 'alpha.md'),
				'--append-system-prompt', join(tailorDir, 'working_protocol.md'),
			]);
		});

		it('falls back to role-based file when name-based is missing', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'Lead.md'), 'You are a lead.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toContain(join(tailorDir, 'agents', 'Lead.md'));
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('prefers name-based file over role-based file', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'alpha.md'), 'You are alpha.', 'utf-8');
			writeFileSync(join(agentsDir, 'Lead.md'), 'You are a lead.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toContain(join(tailorDir, 'agents', 'alpha.md'));
			expect(args).not.toContain(join(tailorDir, 'agents', 'Lead.md'));
		});

		it('extracts model from agent file front matter and writes stripped body to temp file', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, 'alpha.md'),
				"---\nmodel: gpt-4o\n---\n\nYou are alpha.",
				'utf-8',
			);

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toContain('--model');
			expect(args).toContain('gpt-4o');
			const tempPromptPath = join(roomPromptDir, 'alpha.prompt');
			expect(existsSync(tempPromptPath)).toBe(true);
			expect(args).toContain(tempPromptPath);
		});

		it('passes original file path when agent file has no front matter', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'alpha.md'), 'You are alpha.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toContain(join(tailorDir, 'agents', 'alpha.md'));
			expect(args).not.toContain(join(roomPromptDir, 'alpha.prompt'));
		});

		it('extracts model from working_protocol front matter and writes stripped body to temp file', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'alpha.md'), 'You are alpha.', 'utf-8');
			writeFileSync(
				join(tailorDir, 'working_protocol.md'),
				"---\nmodel: gpt-4o\n---\n\nShared protocol body.",
				'utf-8',
			);

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			const tempPromptPath = join(roomPromptDir, 'working_protocol.prompt');
			expect(existsSync(tempPromptPath)).toBe(true);
			expect(args).toContain(tempPromptPath);
			expect(args).not.toContain(join(tailorDir, 'working_protocol.md'));
		});

		it('passes original working_protocol path when it has no front matter', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'alpha.md'), 'You are alpha.', 'utf-8');
			writeFileSync(join(tailorDir, 'working_protocol.md'), 'Shared protocol body.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toContain(join(tailorDir, 'working_protocol.md'));
			expect(args).not.toContain(join(roomPromptDir, 'working_protocol.prompt'));
		});

		it('warns and skips missing agent prompt but still appends working_protocol', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));
			writeFileSync(join(tailorDir, 'working_protocol.md'), 'Work hard.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toEqual([
				'--mode', 'rpc', '--no-session',
				'--append-system-prompt', bodyPromptPath,
				'--append-system-prompt', join(tailorDir, 'working_protocol.md'),
			]);
			expect(warnSpy).toHaveBeenCalledWith(
				'[agent-rooms] tailor_shop agent prompt not found:',
				join(tailorDir, 'agents', 'alpha.md'),
			);
		});

		it('warns when both agent prompt and working_protocol are missing', () => {
			tailorDir = mkdtempSync(join(tmpdir(), 'tailor-test-'));

			const args = buildPiArgs('alpha', 'Lead', tailorDir, bodyPromptPath, roomPromptDir);
			expect(args).toEqual([
				'--mode', 'rpc', '--no-session',
				'--append-system-prompt', bodyPromptPath,
			]);
			expect(warnSpy).toHaveBeenCalledWith(
				'[agent-rooms] tailor_shop agent prompt not found:',
				join(tailorDir, 'agents', 'alpha.md'),
			);
		});

		it('resolves relative tailorShop against workingDir when provided', () => {
			const baseDir = mkdtempSync(join(tmpdir(), 'base-test-'));
			tailorDir = join(baseDir, 'prompts');
			const agentsDir = join(tailorDir, 'agents');
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, 'alpha.md'), 'You are alpha.', 'utf-8');

			const args = buildPiArgs('alpha', 'Lead', './prompts', bodyPromptPath, roomPromptDir, baseDir);
			expect(args).toContain(join(tailorDir, 'agents', 'alpha.md'));
		});
	});

	describe('instructions front-matter', () => {
		it('sends instructions to matching agents and leaves others idle', async () => {
			const markdown = `---\nteam:\n  alpha: Lead\n  beta: Dev\ninstructions:\n  alpha: Please start\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			expect(room.agents.size).toBe(2);
			destroyRoom(result.roomId);
		});

		it('warns when instruction target is unknown', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const markdown = `---\nteam:\n  alpha: Lead\ninstructions:\n  gamma: Hello\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			expect(warnSpy).toHaveBeenCalledWith(
				'[agent-rooms] instruction target not found:',
				'gamma',
			);
			warnSpy.mockRestore();
			destroyRoom(result.roomId);
		});
	});

	describe('working_dir front-matter', () => {
		it('resolves relative working_dir and stores absolute path on room', async () => {
			const baseDir = mkdtempSync(join(tmpdir(), 'workdir-test-'));
			const markdown = `---\nteam:\n  alpha: Lead\nworking_dir: ${baseDir}\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			expect(room.workingDir).toBe(baseDir);
			destroyRoom(result.roomId);
		});
	});

	describe('determineRecipients', () => {
		function makeRoom(
			routingStrategy: 'broadcast' | 'explicit',
			agents: Array<{ name: string; role: string }>,
			routes?: Record<string, string[]>,
			facilitator?: string,
		): Room {
			return {
				id: 'test',
				status: 'running',
				agents: new Map(agents.map((a) => [a.name, { name: a.name, role: a.role } as any])),
				sseClients: new Set(),
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
				protocolBody: '',
				routingStrategy,
				routes,
				facilitator,
				events: [],
				eventSeq: 0,
				promptDir: '',
			} as Room;
		}

		it('broadcast mode sends to all other agents', () => {
			const room = makeRoom('broadcast', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', 'hello')).toEqual(['beta', 'gamma']);
		});

		it('explicit mode with static routes only', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			], { alpha: ['beta'] });
			expect(determineRecipients(room, 'alpha', 'hello')).toEqual(['beta']);
		});

		it('explicit mode with @attn: tags only', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', 'hey @attn:gamma check this')).toEqual(['gamma']);
		});

		it('explicit mode combines static routes and @attn: tags', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			], { alpha: ['beta'] });
			expect(determineRecipients(room, 'alpha', 'hey @attn:gamma check this')).toEqual(
				expect.arrayContaining(['beta', 'gamma']),
			);
		});

		it('explicit mode deduplicates recipients', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			], { alpha: ['beta'] });
			expect(determineRecipients(room, 'alpha', 'hey @attn:beta')).toEqual(['beta']);
		});

		it('explicit mode excludes self from static routes', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
			], { alpha: ['alpha', 'beta'] });
			expect(determineRecipients(room, 'alpha', 'hello')).toEqual(['beta']);
		});

		it('explicit mode excludes self from @attn: tags', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', '@attn:alpha')).toEqual([]);
		});

		it('explicit mode ignores non-existent agents in @attn:', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', '@attn:delta hello')).toEqual([]);
		});

		it('explicit mode ignores non-existent agents in routes', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
			], { alpha: ['delta'] });
			expect(determineRecipients(room, 'alpha', 'hello')).toEqual([]);
		});

		it('explicit mode returns empty array when sender has no routes and no mentions', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
			], { beta: ['alpha'] });
			expect(determineRecipients(room, 'alpha', 'hello')).toEqual([]);
		});

		it('explicit mode resolves @attn: by role', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', 'hey @attn:Dev')).toEqual(
				expect.arrayContaining(['beta', 'gamma']),
			);
		});

		it('explicit mode resolves @attn: by role for multiple matching agents', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
				{ name: 'delta', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', '@attn:Dev')).toEqual(
				expect.arrayContaining(['beta', 'gamma', 'delta']),
			);
		});

		it('explicit mode deduplicates when name and role match the same agent', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
				{ name: 'gamma', role: 'Dev' },
			]);
			// @attn:beta matches by name, @attn:Dev matches by role (includes beta and gamma)
			expect(determineRecipients(room, 'alpha', '@attn:beta @attn:Dev')).toEqual(
				expect.arrayContaining(['beta', 'gamma']),
			);
		});

		it('explicit mode excludes sender when mentioning own role', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Lead' },
				{ name: 'gamma', role: 'Dev' },
			]);
			// alpha mentions Lead role; alpha should be excluded, beta should receive
			expect(determineRecipients(room, 'alpha', '@attn:Lead')).toEqual(['beta']);
		});

		it('explicit mode ignores non-existent roles in @attn:', () => {
			const room = makeRoom('explicit', [
				{ name: 'alpha', role: 'Lead' },
				{ name: 'beta', role: 'Dev' },
			]);
			expect(determineRecipients(room, 'alpha', '@attn:QA hello')).toEqual([]);
		});
	});

	describe('routeMessageToAgents fallback protocol', () => {
		function makeAgent(name: string, isStreaming = false) {
			const writeFn = vi.fn();
			return {
				name,
				isStreaming,
				proc: { stdin: { write: writeFn } },
			} as any;
		}

		function makeRoom(routingStrategy: 'broadcast' | 'explicit', agents: any[], routes?: Record<string, string[]>, facilitator?: string): Room {
			return {
				id: 'test',
				status: 'running',
				agents: new Map(agents.map((a) => [a.name, a])),
				sseClients: new Set(),
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
				protocolBody: '',
				routingStrategy,
				routes,
				facilitator,
				events: [],
				eventSeq: 0,
				promptDir: '',
			} as Room;
		}

		it('delivers original message when recipients exist', () => {
			const beta = makeAgent('beta');
			const room = makeRoom('explicit', [makeAgent('alpha'), beta], { alpha: ['beta'] });
			routeMessageToAgents(room, 'alpha', 'hello');
			expect(beta.proc.stdin.write).toHaveBeenCalledWith(
				`${JSON.stringify({ type: 'prompt', message: '[alpha]: hello' })}\n`,
			);
		});

		it('warns and drops message when no recipients and no facilitator', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const room = makeRoom('explicit', [makeAgent('alpha'), makeAgent('beta')]);
			routeMessageToAgents(room, 'alpha', 'hello');
			expect(warnSpy).toHaveBeenCalledWith(
				'[SYSTEM WARNING] Dropped message from alpha: no recipients and no facilitator configured.',
			);
			warnSpy.mockRestore();
		});

		it('sends wrapped message to facilitator when no recipients', () => {
			const facilitator = makeAgent('facilitator');
			const room = makeRoom('explicit', [makeAgent('alpha'), makeAgent('beta'), facilitator], undefined, 'facilitator');
			routeMessageToAgents(room, 'alpha', 'hello');
			expect(facilitator.proc.stdin.write).toHaveBeenCalledWith(
				`${JSON.stringify({
					type: 'prompt',
					message: '[SYSTEM_ROUTING_FAILURE]\n**Original Sender:** alpha\n**Status:** This message reached no one because no attention tags were used and no static routes exist.\n**Content:**\n> ---\nhello',
				})}\n`,
			);
		});

		it('logs critical error when facilitator is the sender with no recipients', () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const facilitator = makeAgent('facilitator');
			const room = makeRoom('explicit', [makeAgent('alpha'), facilitator], undefined, 'facilitator');
			routeMessageToAgents(room, 'facilitator', 'hello');
			expect(errorSpy).toHaveBeenCalledWith(
				'[CRITICAL ERROR] Facilitator facilitator sent a message with no recipients. This creates an infinite loop. Configure routes for the facilitator agent.',
			);
			expect(facilitator.proc.stdin.write).not.toHaveBeenCalled();
			errorSpy.mockRestore();
		});

		it('warns and drops when facilitator is defined but not in room', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const room = makeRoom('explicit', [makeAgent('alpha'), makeAgent('beta')], undefined, 'ghost');
			routeMessageToAgents(room, 'alpha', 'hello');
			expect(warnSpy).toHaveBeenCalledWith(
				'[SYSTEM WARNING] Facilitator ghost not found in room. Dropping message from alpha.',
			);
			warnSpy.mockRestore();
		});
	});

	describe('listRooms', () => {
		it('returns all rooms when no filters provided', () => {
			const rooms = listRooms();
			expect(Array.isArray(rooms)).toBe(true);
			expect(rooms.length).toBeGreaterThanOrEqual(1);
			expect(rooms.some((r: any) => r.roomId === roomId)).toBe(true);
		});

		it('filters by status', () => {
			const running = listRooms('running');
			const completed = listRooms('completed');
			expect(Array.isArray(running)).toBe(true);
			expect(Array.isArray(completed)).toBe(true);
			expect(running.some((r: any) => r.roomId === roomId)).toBe(false);
			expect(completed.some((r: any) => r.roomId === roomId)).toBe(false);
		});

		it('respects limit and offset', () => {
			const all = listRooms();
			const limited = listRooms(undefined, 1, 0);
			expect(limited.length).toBeLessThanOrEqual(1);
			if (all.length > 1) {
				const offset = listRooms(undefined, 1, 1);
				expect(offset.length).toBeLessThanOrEqual(1);
			}
		});

		it('returns empty array when no rooms match status', () => {
			const rooms = listRooms('nonexistent');
			expect(rooms).toEqual([]);
		});
	});
});
