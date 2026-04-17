import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseProtocol, parseAgentPromptFile } from './protocol-parser.js';

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

	it('parses tailor_shop field', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\ntailor_shop: ./my-shop\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.team).toEqual({ alice: 'Developer' });
				expect(result.tailorShop).toBe('./my-shop');
				expect(result.body).toBe('Hello team!');
			},
		);
	});

	it('leaves tailor_shop undefined when omitted', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.tailorShop).toBeUndefined();
			},
		);
	});

	it('parses instructions field', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\n  bob: Tester\ninstructions:\n  alice: Start coding\n  bob: Write tests\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.instructions).toEqual({
					alice: 'Start coding',
					bob: 'Write tests',
				});
			},
		);
	});

	it('leaves instructions undefined when omitted', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.instructions).toBeUndefined();
			},
		);
	});
});

describe('parseAgentPromptFile', () => {
	it('extracts model and body from front matter', () => {
		const result = parseAgentPromptFile(`---\nmodel: gpt-4o\n---\n\nYou are an architect.`);
		expect(result.model).toBe('gpt-4o');
		expect(result.body).toBe('You are an architect.');
	});

	it('returns undefined model when front matter lacks model', () => {
		const result = parseAgentPromptFile(`---\nother: value\n---\n\nYou are a developer.`);
		expect(result.model).toBeUndefined();
		expect(result.body).toBe('You are a developer.');
	});

	it('returns whole content as body when no front matter', () => {
		const result = parseAgentPromptFile('You are a tester.');
		expect(result.model).toBeUndefined();
		expect(result.body).toBe('You are a tester.');
	});

	it('handles empty body after front matter', () => {
		const result = parseAgentPromptFile(`---\nmodel: gpt-4o\n---\n`);
		expect(result.model).toBe('gpt-4o');
		expect(result.body).toBe('');
	});
});
