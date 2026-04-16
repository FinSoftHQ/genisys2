import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseProtocol } from './protocol-parser.js';

describe('parseProtocol', () => {
	function withTempFile(content: string, fn: (path: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), 'proto-test-'));
		const filePath = join(dir, 'protocol.md');
		writeFileSync(filePath, content, 'utf-8');
		try {
			fn(filePath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it('parses team and body without routes', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\n  bob: Tester\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.team).toEqual({ alice: 'Developer', bob: 'Tester' });
				expect(result.body).toBe('Hello team!');
				expect(result.routes).toBeUndefined();
			},
		);
	});

	it('parses routes block with indented arrays', () => {
		withTempFile(
			`---\nteam:\n  architect: System Architect\n  developer: Senior Developer\nroutes:\n  architect:\n    - developer\n  developer:\n    - architect\n---\n\nDesign the API.`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.team).toEqual({
					architect: 'System Architect',
					developer: 'Senior Developer',
				});
				expect(result.routes).toEqual({
					architect: ['developer'],
					developer: ['architect'],
				});
				expect(result.body).toBe('Design the API.');
			},
		);
	});

	it('parses routes with multiple targets', () => {
		withTempFile(
			`---\nteam:\n  a: Lead\n  b: Dev\n  c: QA\nroutes:\n  a:\n    - b\n    - c\n---\n\nWork together.`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.routes).toEqual({ a: ['b', 'c'] });
			},
		);
	});

	it('throws when no team block exists', () => {
		withTempFile(
			`---\nother:\n  key: value\n---\n\nNo team here.`,
			(path) => {
				expect(() => parseProtocol(path)).toThrow('No team members found');
			},
		);
	});
});
