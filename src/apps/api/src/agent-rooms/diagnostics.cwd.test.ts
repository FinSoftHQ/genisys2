import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';

describe('diagnostics cwd', () => {
	it('reports and validates the current working directory', () => {
		console.log('[DIAGNOSTICS] CWD:', process.cwd());

		expect(process.cwd()).toBeTruthy();
		expect(existsSync(join(process.cwd(), 'package.json'))).toBe(true);
		expect(existsSync(join(process.cwd(), 'src/apps/api/package.json'))).toBe(true);
	});
});
