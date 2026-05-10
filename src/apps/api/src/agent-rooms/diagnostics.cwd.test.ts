import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

describe('agent-rooms diagnostics cwd', () => {
	it('prints and verifies the working directory', () => {
		console.log('[DIAGNOSTICS] CWD:', process.cwd());

		const cwd = process.cwd();
		const searchRoots = [cwd, resolve(cwd, '..'), resolve(cwd, '../..'), resolve(cwd, '../../..')];
		const detectedRepoRoot = searchRoots.find((root) => existsSync(resolve(root, 'package.json')));

		expect(detectedRepoRoot).toBeDefined();
	});
});

describe('types.ts importability', () => {
	it('types.ts module can be imported without throwing', async () => {
		const mod = await import('./types.js');
		expect(mod).toBeDefined();
	});
});
