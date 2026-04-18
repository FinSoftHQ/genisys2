import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	createSquadFromMarkdown,
	listSquads,
	getSquad,
	destroySquad,
} from './manager.js';

describe('squads manager', () => {
	let squadId: string;

	beforeEach(() => {
		const markdown = `---\nteam:\n  alpha: Lead\n  beta: Dev\n---\n\nSay hello briefly.\n`;
		const result = createSquadFromMarkdown(markdown);
		squadId = result.squadId;
	});

	afterEach(() => {
		try {
			destroySquad(squadId);
		} catch {
			// ignore cleanup failures
		}
	});

	it('creates a squad from markdown protocol with correct agents', () => {
		const squad = getSquad(squadId);
		expect(squad).toBeDefined();
		expect(squad!.agents.size).toBe(2);
		expect(squad!.agents.has('alpha')).toBe(true);
		expect(squad!.agents.has('beta')).toBe(true);
	});

	describe('listSquads', () => {
		it('returns all squads when no filters provided', () => {
			const squads = listSquads();
			expect(Array.isArray(squads)).toBe(true);
			expect(squads.length).toBeGreaterThanOrEqual(1);
			expect(squads.some((s: any) => s.squadId === squadId)).toBe(true);
		});

		it('filters by status', () => {
			const running = listSquads('running');
			const completed = listSquads('completed');
			expect(Array.isArray(running)).toBe(true);
			expect(Array.isArray(completed)).toBe(true);
			expect(running.some((s: any) => s.squadId === squadId)).toBe(false);
			expect(completed.some((s: any) => s.squadId === squadId)).toBe(false);
		});

		it('respects limit and offset', () => {
			const all = listSquads();
			const limited = listSquads(undefined, 1, 0);
			expect(limited.length).toBeLessThanOrEqual(1);
			if (all.length > 1) {
				const offset = listSquads(undefined, 1, 1);
				expect(offset.length).toBeLessThanOrEqual(1);
			}
		});

		it('returns empty array when no squads match status', () => {
			const squads = listSquads('nonexistent');
			expect(squads).toEqual([]);
		});
	});
});
