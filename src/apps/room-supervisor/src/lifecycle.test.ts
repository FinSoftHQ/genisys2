import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'fs';
import { createRoomFromMarkdown } from './manager.js';
import {
	rooms,
	sendInstructions,
	completeRoom,
	destroyRoom,
} from './lifecycle.js';
import { getRoomEvents } from './event-store.js';
import {
	setupTestDataDir,
	teardownTestDataDir,
	clearIndexDb,
	listRoomsIndex,
	getRoomIndex,
} from '@repo/agent-rooms-core';

describe('agent-rooms lifecycle', () => {
	let roomId: string;

	beforeAll(() => {
		setupTestDataDir();
	});

	afterAll(() => {
		teardownTestDataDir();
	});

	beforeEach(async () => {
		clearIndexDb();
		const markdown = `---
team:
  alpha: Lead
  beta: Dev
---

Say hello briefly.
`;
		const result = await createRoomFromMarkdown(markdown);
		roomId = result.roomId;
	});

	afterEach(async () => {
		try {
			await destroyRoom(roomId);
		} catch {
			// ignore cleanup failures
		}
	});

	afterEach(async () => {
		try {
			await destroyRoom(roomId);
		} catch {
			// ignore cleanup failures
		}
	});

	it('returns room status with expected shape', () => {
		const room = rooms.get(roomId)!;
		const status = {
			roomId: room.id,
			status: room.status,
			agents: Object.fromEntries(Array.from(room.agents.entries()).map(([name, agent]) => [name, { status: agent.status }])),
		} as Record<string, unknown>;
		expect(status.roomId).toBe(roomId);
		expect(status.status).toBeDefined();
		expect(status.agents).toBeDefined();
		const agents = status.agents as Record<string, { status: string }>;
		expect(agents.alpha).toBeDefined();
		expect(agents.beta).toBeDefined();
	});

	it('returns events and supports since cursor', async () => {
		const room = rooms.get(roomId)!;
		const result = await getRoomEvents(room);
		expect(Array.isArray(result.events)).toBe(true);
		expect(result.hasMore).toBe(false);
		const sinceResult = await getRoomEvents(room, 999_999);
		expect(sinceResult.events).toEqual([]);
		expect(sinceResult.hasMore).toBe(false);
	});

	it('sends instructions to a target agent', async () => {
		const room = rooms.get(roomId)!;
		const result = await sendInstructions(room, 'alpha', ['Please summarize.']);
		expect(result.queuedItems).toBe(1);
	});

	it('throws for unknown agent in instructions', async () => {
		const room = rooms.get(roomId)!;
		await expect(sendInstructions(room, 'gamma', ['Hello'])).rejects.toThrow(
			'Agent gamma not found in room',
		);
	});

	it('rejects instructions for a completed room', async () => {
		const room = rooms.get(roomId)!;
		await completeRoom(roomId);
		await expect(sendInstructions(room, 'alpha', ['Hello'])).rejects.toThrow(
			'Room is completed',
		);
		await destroyRoom(roomId);
	});

	it('completes and persists room to index DB', async () => {
		await completeRoom(roomId);
		const room = rooms.get(roomId);
		expect(room).toBeDefined();
		expect(room!.status).toBe('completed');
		const events = (await getRoomEvents(room!)).events;
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[events.length - 1]).toMatchObject({
			type: 'room_closed',
			from: 'system',
			reason: 'completed',
		});
		await destroyRoom(roomId);
		// Phase B: room survives destroy in index DB until retention GC
		const afterDestroy = getRoomIndex(roomId);
		expect(afterDestroy).toBeDefined();
		expect(afterDestroy!.status).toBe('completed');
	});

	it('preserves prompt directory on completion for retention GC', async () => {
		const room = rooms.get(roomId)!;
		const promptDir = room.promptDir;
		expect(existsSync(promptDir)).toBe(true);
		await completeRoom(roomId);
		// Phase B: promptDir is now persistent; retention GC deletes it later
		expect(existsSync(promptDir)).toBe(true);
		expect(rooms.get(roomId)).toBeDefined();
		await destroyRoom(roomId);
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

		await completeRoom(result.roomId);
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

		await destroyRoom(result.roomId);
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
		await destroyRoom(manual.roomId, 'manual');

		const expired = await createRoomFromMarkdown(markdown, {
			callbackUrl: 'https://example.com/room-hook',
		});
		await destroyRoom(expired.roomId, 'expired');

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const reasons = fetchSpy.mock.calls.map(([, init]) => {
			const payload = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
			return payload.reason;
		});
		expect(reasons).toEqual(expect.arrayContaining(['manual', 'expired']));
		fetchSpy.mockRestore();
	});

	describe('listRoomsIndex', () => {
		it('returns all rooms when no filters provided', () => {
			const rows = listRoomsIndex();
			expect(Array.isArray(rows)).toBe(true);
			expect(rows.length).toBeGreaterThanOrEqual(1);
			expect(rows.some((r: any) => r.id === roomId)).toBe(true);
		});

		it('filters by status', () => {
			const running = listRoomsIndex('running');
			const completed = listRoomsIndex('completed');
			expect(Array.isArray(running)).toBe(true);
			expect(Array.isArray(completed)).toBe(true);
			expect(running.some((r: any) => r.id === roomId)).toBe(false);
			expect(completed.some((r: any) => r.id === roomId)).toBe(false);
		});

		it('respects limit and offset', () => {
			const all = listRoomsIndex();
			const limited = listRoomsIndex(undefined, undefined, 1, 0);
			expect(limited.length).toBeLessThanOrEqual(1);
			if (all.length > 1) {
				const offset = listRoomsIndex(undefined, undefined, 1, 1);
				expect(offset.length).toBeLessThanOrEqual(1);
			}
		});

		it('returns empty array when no rooms match status', () => {
			const rows = listRoomsIndex('nonexistent');
			expect(rows).toEqual([]);
		});

		it('filters by tag', async () => {
			const taggedResult = await createRoomFromMarkdown(`---\nteam:\n  gamma: Lead\n---\n\nTest.\n`, { tag: 'test-tag' });
			try {
				const tagged = listRoomsIndex(undefined, 'test-tag', 50, 0);
				expect(tagged.some((r: any) => r.id === taggedResult.roomId)).toBe(true);
				expect(tagged.some((r: any) => r.id === roomId)).toBe(false);

				const untagged = listRoomsIndex(undefined, 'other-tag', 50, 0);
				expect(untagged.some((r: any) => r.id === taggedResult.roomId)).toBe(false);
			} finally {
				await destroyRoom(taggedResult.roomId);
			}
		});
	});
});
