import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	createRoomFromMarkdown,
	getRoom,
	getRoomStatus,
	getRoomEvents,
	sendInstructions,
	completeRoom,
	destroyRoom,
	buildPiArgs,
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
		const events = getRoomEvents(room);
		expect(Array.isArray(events)).toBe(true);
		const sinceEvents = getRoomEvents(room, 999_999);
		expect(sinceEvents).toEqual([]);
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
		expect(getRoomEvents(room!).length).toBeGreaterThanOrEqual(0);
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
});
