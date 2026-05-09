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
		const events = getRoomEvents(room!).events;
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[events.length - 1]).toMatchObject({
			type: 'room_closed',
			from: 'system',
			reason: 'completed',
		});
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

	it('sends callback with x-signature when room completes', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 204 }));

		const markdown = `---\nteam:\n  alpha: Lead\n---\n\nComplete this task.\n`;
		const result = await createRoomFromMarkdown(markdown, {
			callbackUrl: 'https://example.com/room-hook',
			callbackSecret: 'top-secret',
		});

		completeRoom(result.roomId);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://example.com/room-hook');
		const payload = JSON.parse(String(init.body)) as Record<string, string>;
		expect(payload.type).toBe('room_closed');
		expect(payload.roomId).toBe(result.roomId);
		expect(payload.reason).toBe('completed');
		const headers = init.headers as Record<string, string>;
		expect(headers['x-signature']).toBeTypeOf('string');
		expect(headers['x-signature'].length).toBeGreaterThan(0);

		destroyRoom(result.roomId);
		fetchSpy.mockRestore();
	});

	it('sends callback for manual and expired destroys', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 204 }));
		const markdown = `---\nteam:\n  alpha: Lead\n---\n\nDo work.\n`;

		const manual = await createRoomFromMarkdown(markdown, {
			callbackUrl: 'https://example.com/room-hook',
		});
		destroyRoom(manual.roomId, 'manual');

		const expired = await createRoomFromMarkdown(markdown, {
			callbackUrl: 'https://example.com/room-hook',
		});
		destroyRoom(expired.roomId, 'expired');

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const reasons = fetchSpy.mock.calls.map(([, init]) => {
			const payload = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
			return payload.reason;
		});
		expect(reasons).toEqual(expect.arrayContaining(['manual', 'expired']));
		fetchSpy.mockRestore();
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
