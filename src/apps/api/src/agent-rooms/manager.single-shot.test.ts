import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

class FakeProc extends EventEmitter {
	stdout: Record<string, never>;
	stdin: { write: (chunk: string) => void; end: () => void };
	commands: string[];

	constructor(private emitJson: (proc: FakeProc, event: Record<string, unknown>) => void) {
		super();
		this.stdout = {};
		this.commands = [];
		this.stdin = {
			write: (chunk: string) => {
				let parsed: { type?: string } = {};
				try {
					parsed = JSON.parse(chunk.trim()) as { type?: string };
				} catch {
					return;
				}
				if (parsed.type) this.commands.push(parsed.type);
				if (parsed.type === 'get_state') {
					queueMicrotask(() => {
						this.emitJson(this, {
							type: 'response',
							command: 'get_state',
							success: true,
						});
					});
				}
			},
			end: () => {},
		};
	}

	kill(_signal?: string): boolean {
		// Mirrors pi's real RPC behaviour: pi registers its own SIGTERM handler and calls
		// process.exit(143), so the parent sees code=143, signal=null — NOT code=null.
		// Using queueMicrotask also mirrors the async nature of a real process exit.
		queueMicrotask(() => {
			this.emit('exit', 143, null);
		});
		return true;
	}
}

const readers = new WeakMap<object, (line: string) => void>();
const spawned: FakeProc[] = [];

function emitJson(proc: FakeProc, event: Record<string, unknown>): void {
	const reader = readers.get(proc.stdout);
	if (!reader) throw new Error('No jsonl reader attached');
	reader(JSON.stringify(event));
}

vi.mock('child_process', () => {
	return {
		spawn: vi.fn(() => {
			const proc = new FakeProc(emitJson);
			spawned.push(proc);
			return proc;
		}),
	};
});

vi.mock('./internal/jsonl.js', () => {
	return {
		attachJsonlReader: vi.fn((stdout: object, cb: (line: string) => void) => {
			readers.set(stdout, cb);
		}),
	};
});

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('Timed out waiting for condition');
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

afterEach(() => {
	spawned.length = 0;
});

describe('single-shot lifecycle', () => {
	it('re-spawns single-shot agent after completion marker termination', async () => {
		const { createRoomFromMarkdown, getRoom, routeMessageToAgents, destroyRoom } = await import('./manager.js');

		const tailorDir = mkdtempSync(join(tmpdir(), 'tailor-single-shot-'));
		const agentsDir = join(tailorDir, 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, 'alpha.md'), '---\nexecution: session\n---\n\nYou are alpha.', 'utf-8');
		writeFileSync(join(agentsDir, 'beta.md'), '---\nexecution: single-shot\n---\n\nYou are beta.', 'utf-8');

		const markdown = `---\nteam:\n  alpha: Lead\n  beta: Reviewer\ntailor_shop: ${tailorDir}\n---\n\nProtocol body.\n`;
		const result = await createRoomFromMarkdown(markdown);
		const room = getRoom(result.roomId)!;

		const beta = room.agents.get('beta')!;
		expect(beta.proc).toBeNull();

		routeMessageToAgents(room, 'alpha', 'First review task');
		await waitFor(() => room.agents.get('beta')!.proc !== null);
		const firstProc = room.agents.get('beta')!.proc as unknown as FakeProc;
		await waitFor(() => firstProc.commands.includes('prompt'));

		emitJson(firstProc, {
			type: 'message_start',
			message: { role: 'assistant', timestamp: Date.now() },
		});
		emitJson(firstProc, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'Done. [@TASK: VIPER-RTB]' },
		});
		emitJson(firstProc, {
			type: 'message_end',
			message: { role: 'assistant' },
		});

		// terminateSingleShotAgent should have fired: proc nulled, status idle.
		// CRITICAL: room must NOT be put into error state — this was the bug where
		// pi's process.exit(143) (from its SIGTERM handler) caused code=143 to fall
		// through the old `code === null` guard and erroneously mark room.status = 'error'.
		await waitFor(() => room.agents.get('beta')!.proc === null);
		expect(room.agents.get('beta')!.proc).toBeNull();
		expect(room.status).not.toBe('error');
		expect(room.agents.get('beta')!.status).toBe('idle');

		routeMessageToAgents(room, 'alpha', 'Second review task');
		await waitFor(() => room.agents.get('beta')!.proc !== null);
		const secondProc = room.agents.get('beta')!.proc as unknown as FakeProc;
		expect(secondProc).not.toBe(firstProc);

		destroyRoom(result.roomId);
		rmSync(tailorDir, { recursive: true, force: true });
	});
});
