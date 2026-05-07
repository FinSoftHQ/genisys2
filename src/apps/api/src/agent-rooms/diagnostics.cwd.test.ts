import { existsSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('agent-rooms diagnostics cwd', () => {
	it('prints and verifies the working directory', () => {
		console.log('[DIAGNOSTICS] CWD:', process.cwd());

		expect(typeof process.cwd()).toBe('string');
		expect(existsSync(path.join(process.cwd(), 'package.json'))).toBe(true);
		expect(existsSync(path.join(process.cwd(), 'src/apps/api/package.json'))).toBe(true);
	});
});
