import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	createRoomFromMarkdown,
	getRoom,
	getRoomStatus,
	getRoomEvents,
	sendInstructions,
	completeRoom,
} from './manager.js';

describe('agent-rooms manager', () => {
	let roomId: string;

	beforeEach(() => {
		const markdown = `---\nteam:\n  alpha: Lead\n  beta: Dev\n---\n\nSay hello briefly.\n`;
		const result = createRoomFromMarkdown(markdown);
		roomId = result.roomId;
	});

	afterEach(() => {
		try {
			completeRoom(roomId);
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

	it('sends instructions to a target agent', () => {
		const room = getRoom(roomId)!;
		const result = sendInstructions(room, 'alpha', ['Please summarize.']);
		expect(result.queuedItems).toBe(1);
	});

	it('throws for unknown agent in instructions', () => {
		const room = getRoom(roomId)!;
		expect(() => sendInstructions(room, 'gamma', ['Hello'])).toThrow(
			'Agent gamma not found in room',
		);
	});

	it('completes and removes the room', () => {
		completeRoom(roomId);
		expect(getRoom(roomId)).toBeUndefined();
	});
});
