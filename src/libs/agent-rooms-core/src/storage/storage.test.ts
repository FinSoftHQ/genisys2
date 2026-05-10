import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { setupTestDataDir, teardownTestDataDir, clearIndexDb } from '../test-helpers.js';
import { openIndexDb, closeIndexDb, getRoomIndex, listRoomsIndex, upsertRoom, getTerminalRoomsOlderThan, deleteRoomIndex } from './index-db.js';
import { RoomLog } from './room-log.js';
import { getRoomEventsPath, getRoomDir, getRoomProtocolPath } from './paths.js';
import { performGc } from './retention-gc.js';

describe('agent-rooms storage', () => {
	beforeAll(() => {
		setupTestDataDir();
	});

	afterAll(() => {
		teardownTestDataDir();
	});

	beforeEach(() => {
		clearIndexDb();
	});

	it('upserts and reads room from index DB', () => {
		upsertRoom({
			id: 'rm_test_1',
			status: 'running',
			tag: 'integration',
			created_at: Date.now(),
			updated_at: Date.now(),
			last_activity_at: Date.now(),
			protocol_body: 'Test protocol',
			facilitator: null,
			routing_strategy: 'broadcast',
			failed_agent: null,
			failed_reason: null,
			callback_url: null,
			callback_secret: null,
			completed_at: null,
		});

		const row = getRoomIndex('rm_test_1');
		expect(row).toBeDefined();
		expect(row!.status).toBe('running');
		expect(row!.tag).toBe('integration');
	});

	it('lists rooms with filters', () => {
		const now = Date.now();
		upsertRoom({
			id: 'rm_a',
			status: 'completed',
			tag: 'tag1',
			created_at: now,
			updated_at: now,
			last_activity_at: now,
			protocol_body: '',
			facilitator: null,
			routing_strategy: 'broadcast',
			failed_agent: null,
			failed_reason: null,
			callback_url: null,
			callback_secret: null,
			completed_at: now,
		});
		upsertRoom({
			id: 'rm_b',
			status: 'running',
			tag: 'tag2',
			created_at: now + 1,
			updated_at: now + 1,
			last_activity_at: now + 1,
			protocol_body: '',
			facilitator: null,
			routing_strategy: 'broadcast',
			failed_agent: null,
			failed_reason: null,
			callback_url: null,
			callback_secret: null,
			completed_at: null,
		});

		const all = listRoomsIndex();
		expect(all.length).toBe(2);

		const completed = listRoomsIndex('completed');
		expect(completed.length).toBe(1);
		expect(completed[0].id).toBe('rm_a');

		const tagged = listRoomsIndex(undefined, 'tag2');
		expect(tagged.length).toBe(1);
		expect(tagged[0].id).toBe('rm_b');
	});

	it('appends events to RoomLog and reads them back', async () => {
		const log = new RoomLog('rm_log_test');
		log.append({ id: 1, type: 'message', from: 'alpha', at: new Date().toISOString(), text: 'hello' });
		log.append({ id: 2, type: 'thinking', from: 'beta', at: new Date().toISOString(), thinking: 'hmm' });
		await log.close();

		const result = await RoomLog.readEvents('rm_log_test');
		expect(result.events.length).toBe(2);
		expect(result.events[0].type).toBe('message');
		expect(result.events[1].type).toBe('thinking');
		expect(result.hasMore).toBe(false);
	});

	it('survives simulated restart (close and reopen index DB)', () => {
		upsertRoom({
			id: 'rm_survive',
			status: 'completed',
			tag: null,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_activity_at: Date.now(),
			protocol_body: 'Survival test',
			facilitator: null,
			routing_strategy: 'broadcast',
			failed_agent: null,
			failed_reason: null,
			callback_url: null,
			callback_secret: null,
			completed_at: Date.now(),
		});

		const before = getRoomIndex('rm_survive');
		expect(before).toBeDefined();

		// Simulate restart
		closeIndexDb();
		openIndexDb();

		const after = getRoomIndex('rm_survive');
		expect(after).toBeDefined();
		expect(after!.protocol_body).toBe('Survival test');
	});

	it('retention GC deletes terminal rooms older than threshold', () => {
		const now = Date.now();
		const old = now - 100_000; // 100s ago

		upsertRoom({
			id: 'rm_old',
			status: 'completed',
			tag: null,
			created_at: old,
			updated_at: old,
			last_activity_at: old,
			protocol_body: '',
			facilitator: null,
			routing_strategy: 'broadcast',
			failed_agent: null,
			failed_reason: null,
			callback_url: null,
			callback_secret: null,
			completed_at: old,
		});
		upsertRoom({
			id: 'rm_recent',
			status: 'completed',
			tag: null,
			created_at: now,
			updated_at: now,
			last_activity_at: now,
			protocol_body: '',
			facilitator: null,
			routing_strategy: 'broadcast',
			failed_agent: null,
			failed_reason: null,
			callback_url: null,
			callback_secret: null,
			completed_at: now,
		});

		// Create room dirs so GC can delete them
		const oldLog = new RoomLog('rm_old');
		oldLog.append({ id: 1, type: 'room_closed', from: 'system', at: new Date().toISOString(), reason: 'completed' });
		oldLog.close();

		const recentLog = new RoomLog('rm_recent');
		recentLog.append({ id: 1, type: 'room_closed', from: 'system', at: new Date().toISOString(), reason: 'completed' });
		recentLog.close();

		const cutoff = now - 50_000; // 50s threshold
		const stale = getTerminalRoomsOlderThan(cutoff);
		expect(stale.some((r) => r.id === 'rm_old')).toBe(true);
		expect(stale.some((r) => r.id === 'rm_recent')).toBe(false);
	});

	it('RoomLog supports since and limit filtering', async () => {
		const log = new RoomLog('rm_filter');
		for (let i = 1; i <= 5; i++) {
			log.append({ id: i, type: 'message', from: 'a', at: new Date().toISOString(), text: `msg ${i}` });
		}
		await log.close();

		const since3 = await RoomLog.readEvents('rm_filter', 2);
		expect(since3.events.length).toBe(3);
		expect(since3.events[0].id).toBe(3);

		const limit2 = await RoomLog.readEvents('rm_filter', undefined, 2);
		expect(limit2.events.length).toBe(2);
		expect(limit2.hasMore).toBe(true);
	});
});
