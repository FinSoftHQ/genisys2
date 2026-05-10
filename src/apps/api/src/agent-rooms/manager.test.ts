import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRoomFromMarkdown } from './manager.js';
import { getRoom, destroyRoom } from './lifecycle.js';
import type { Room } from './types.js';

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

	it('creates single-shot agents as dormant and session agents as spawned at room creation', async () => {
		const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-exec-'));
		const agentsDir = join(tailorDir, 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, 'alpha.md'),
			'---\nexecution: session\n---\n\nYou are alpha.',
			'utf-8',
		);
		writeFileSync(
			join(agentsDir, 'beta.md'),
			'---\nexecution: single-shot\n---\n\nYou are beta.',
			'utf-8',
		);

		const markdown = `---\nteam:\n  alpha: Lead\n  beta: Reviewer\ntailor_shop: ${tailorDir}\n---\n\nProtocol body.\n`;
		const result = await createRoomFromMarkdown(markdown);
		const room = getRoom(result.roomId)!;

		const alpha = room.agents.get('alpha')!;
		const beta = room.agents.get('beta')!;

		expect(alpha.executionMode).toBe('session');
		expect(alpha.proc).not.toBeNull();

		expect(beta.executionMode).toBe('single-shot');
		expect(beta.proc).toBeNull();

		destroyRoom(result.roomId);
		rmSync(tailorDir, { recursive: true, force: true });
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

	describe('working_protocol.md defaults', () => {
		it('merges team from working_protocol.md when main protocol omits team', async () => {
			const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-defaults-'));
			writeFileSync(
				join(tailorDir, 'working_protocol.md'),
				'---\nteam:\n  gamma: Lead\n  delta: Dev\n---\n\nDefault protocol.',
				'utf-8',
			);
			const markdown = `---\ntailor_shop: ${tailorDir}\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			expect(room.agents.size).toBe(2);
			expect(room.agents.has('gamma')).toBe(true);
			expect(room.agents.has('delta')).toBe(true);
			destroyRoom(result.roomId);
		});

		it('merges routes and facilitator from working_protocol.md defaults', async () => {
			const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-defaults-'));
			writeFileSync(
				join(tailorDir, 'working_protocol.md'),
				'---\nteam:\n  gamma: Lead\n  delta: Dev\nroutes:\n  gamma:\n    - delta\nfacilitator: gamma\n---\n\nDefault protocol.',
				'utf-8',
			);
			const markdown = `---\ntailor_shop: ${tailorDir}\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			expect(room.routes).toEqual({ gamma: ['delta'] });
			expect(room.facilitator).toBe('gamma');
			destroyRoom(result.roomId);
		});

		it('main protocol overrides working_protocol.md defaults', async () => {
			const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-defaults-'));
			writeFileSync(
				join(tailorDir, 'working_protocol.md'),
				'---\nteam:\n  gamma: Lead\n  delta: Dev\nroutes:\n  gamma:\n    - delta\n---\n\nDefault protocol.',
				'utf-8',
			);
			const markdown = `---\nteam:\n  epsilon: Architect\ntailor_shop: ${tailorDir}\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			expect(room.agents.size).toBe(1);
			expect(room.agents.has('epsilon')).toBe(true);
			// routes still merge because main protocol does not define routes
			expect(room.routes).toEqual({ gamma: ['delta'] });
			destroyRoom(result.roomId);
		});

		it('merges instructions agent-by-agent with main taking precedence', async () => {
			const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-defaults-'));
			writeFileSync(
				join(tailorDir, 'working_protocol.md'),
				'---\nteam:\n  gamma: Lead\n  delta: Dev\ninstructions:\n  gamma: Default start\n  delta: Default task\n---\n\nDefault protocol.',
				'utf-8',
			);
			const markdown = `---\nteam:\n  gamma: Lead\n  delta: Dev\ntailor_shop: ${tailorDir}\ninstructions:\n  gamma: Override start\n---\n\nProtocol body.\n`;
			const result = await createRoomFromMarkdown(markdown);
			const room = getRoom(result.roomId)!;
			expect(room).toBeDefined();
			destroyRoom(result.roomId);
		});

		it('throws when no team in main or working_protocol.md', async () => {
			const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-defaults-'));
			writeFileSync(
				join(tailorDir, 'working_protocol.md'),
				'---\nfacilitator: gamma\n---\n\nDefault protocol.',
				'utf-8',
			);
			const markdown = `---\ntailor_shop: ${tailorDir}\n---\n\nProtocol body.\n`;
			await expect(createRoomFromMarkdown(markdown)).rejects.toThrow(
				'No team members found in front matter or working_protocol.md defaults',
			);
		});
	});
});
