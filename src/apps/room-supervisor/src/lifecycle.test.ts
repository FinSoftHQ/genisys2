import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRoomFromMarkdown } from './manager.js';
import {
	listRooms,
	getRoom,
	getRoomStatus,
	sendInstructions,
	completeRoom,
	destroyRoom,
} from './lifecycle.js';
import { getRoomEvents } from './event-store.js';
import type { Room } from '@repo/agent-rooms-core';
import { setupTestDataDir, teardownTestDataDir, clearIndexDb } from '@repo/agent-rooms-core';

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

	afterEach(() => {
		try {
			destroyRoom(roomId);
		} catch {
			// ignore cleanup failures
		}
	});

	afterEach(() => {
		try {
			destroyRoom(roomId);
		} catch {
			// ignore cleanup failures
		}
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

	it('returns events and supports since cursor', async () => {
		const room = getRoom(roomId)!;
		const result = await getRoomEvents(room);
		expect(Array.isArray(result.events)).toBe(true);
		expect(result.hasMore).toBe(false);
		const sinceResult = await getRoomEvents(room, 999_999);
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

	it('completes and persists room to index DB', async () => {
		completeRoom(roomId);
		const room = getRoom(roomId);
		expect(room).toBeDefined();
		expect(room!.status).toBe('completed');
		const events = (await getRoomEvents(room!)).events;
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[events.length - 1]).toMatchObject({
			type: 'room_closed',
			from: 'system',
			reason: 'completed',
		});
		destroyRoom(roomId);
		// Phase B: room survives destroy in index DB until retention GC
		const afterDestroy = getRoom(roomId);
		expect(afterDestroy).toBeDefined();
		expect(afterDestroy!.status).toBe('completed');
	});

	it('preserves prompt directory on completion for retention GC', () => {
		const room = getRoom(roomId)!;
		const promptDir = room.promptDir;
		expect(existsSync(promptDir)).toBe(true);
		completeRoom(roomId);
		// Phase B: promptDir is now persistent; retention GC deletes it later
		expect(existsSync(promptDir)).toBe(true);
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

		it('filters by tag', async () => {
			const taggedResult = await createRoomFromMarkdown(`---\nteam:\n  gamma: Lead\n---\n\nTest.\n`, { tag: 'test-tag' });
			try {
				const tagged = listRooms(undefined, 50, 0, 'test-tag');
				expect(tagged.some((r: any) => r.roomId === taggedResult.roomId)).toBe(true);
				expect(tagged.some((r: any) => r.roomId === roomId)).toBe(false);

				const untagged = listRooms(undefined, 50, 0, 'other-tag');
				expect(untagged.some((r: any) => r.roomId === taggedResult.roomId)).toBe(false);
			} finally {
				destroyRoom(taggedResult.roomId);
			}
		});
	});
});
