import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import { setupTestDataDir, teardownTestDataDir, clearIndexDb } from './test-helpers.js';

vi.mock('child_process', async () => {
	const actual = await vi.importActual<typeof import('child_process')>('child_process');
	return {
		...actual,
		spawn: vi.fn(),
	};
});

import { spawn as mockSpawn } from 'child_process';
import { createRoomFromMarkdown } from './manager.js';
import { getRoom, destroyRoom } from './lifecycle.js';

function createMockProc(): ChildProcess & { _stdout: EventEmitter; _stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } } {
	const stdout = new EventEmitter();
	const stdin = { write: vi.fn(), end: vi.fn() };
	const stderr = { on: vi.fn() };
	const proc = {
		stdin,
		stdout,
		stderr,
		on: vi.fn(),
		kill: vi.fn(),
		pid: 12345,
		_stdout: stdout,
		_stdin: stdin,
	} as unknown as ChildProcess & { _stdout: EventEmitter; _stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } };

	stdin.write.mockImplementation((data: string) => {
		try {
			const cmd = JSON.parse(data.trim());
			if (cmd.type === 'get_state') {
				setTimeout(() => {
					stdout.emit(
						'data',
						Buffer.from(JSON.stringify({ type: 'response', command: 'get_state', success: true }) + '\n'),
					);
				}, 5);
			}
		} catch {
			// ignore non-JSON writes
		}
	});

	return proc;
}

describe('agent-rooms spawn cwd', () => {
	beforeAll(() => {
		setupTestDataDir();
	});

	afterAll(() => {
		teardownTestDataDir();
	});

	afterEach(() => {
		vi.mocked(mockSpawn).mockClear();
		clearIndexDb();
	});

	it('spawns pi with cwd set to room.workingDir when provided', async () => {
		vi.mocked(mockSpawn).mockImplementation(() => createMockProc() as ChildProcess);

		const baseDir = mkdtempSync(join(tmpdir(), 'spawn-cwd-test-'));
		const markdown = `---\nteam:\n  alpha: Lead\nworking_dir: ${baseDir}\n---\n\nProtocol body.\n`;

		const result = await createRoomFromMarkdown(markdown);
		const room = getRoom(result.roomId)!;
		expect(room).toBeDefined();
		expect(room.workingDir).toBe(baseDir);

		const spawnCalls = vi.mocked(mockSpawn).mock.calls;
		expect(spawnCalls.length).toBeGreaterThan(0);

		const piSpawn = spawnCalls.find((call) => call[0] === 'pi');
		expect(piSpawn).toBeDefined();

		const options = piSpawn![2] as { cwd?: string };
		expect(options.cwd).toBe(baseDir);

		const piArgs = piSpawn![1] as string[];
		const cwdPromptIndex = piArgs.findIndex((arg) => arg.endsWith('alpha.cwd.prompt'));
		expect(cwdPromptIndex).toBeGreaterThan(-1);
		expect(piArgs[cwdPromptIndex - 1]).toBe('--append-system-prompt');

		destroyRoom(result.roomId);
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('spawns pi with cwd set to process.cwd() when workingDir is omitted', async () => {
		vi.mocked(mockSpawn).mockImplementation(() => createMockProc() as ChildProcess);

		const markdown = `---\nteam:\n  alpha: Lead\n---\n\nProtocol body.\n`;

		const result = await createRoomFromMarkdown(markdown);
		const room = getRoom(result.roomId)!;
		expect(room).toBeDefined();
		expect(room.workingDir).toBeUndefined();

		const spawnCalls = vi.mocked(mockSpawn).mock.calls;
		const piSpawn = spawnCalls.find((call) => call[0] === 'pi');
		expect(piSpawn).toBeDefined();

		const options = piSpawn![2] as { cwd?: string };
		expect(options.cwd).toBe(process.cwd());

		destroyRoom(result.roomId);
	});
});
