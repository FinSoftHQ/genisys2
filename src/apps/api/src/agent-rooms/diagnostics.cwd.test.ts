import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';

describe('agent-rooms diagnostics cwd', () => {
	it('prints and verifies the working directory', () => {
		console.log('[DIAGNOSTICS] CWD:', process.cwd());

		expect(process.cwd()).toBe('/home/dev3x/w/genisys2');
		expect(existsSync('/home/dev3x/w/genisys2/package.json')).toBe(true);
	});
});
