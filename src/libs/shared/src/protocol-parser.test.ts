import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseProtocol, parseProtocolFromString, parseAgentPromptFile } from './protocol-parser.js';

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

	it('parses facilitator field', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\n  bob: Tester\nfacilitator: alice\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.team).toEqual({ alice: 'Developer', bob: 'Tester' });
				expect(result.facilitator).toBe('alice');
				expect(result.body).toBe('Hello team!');
			},
		);
	});

	it('leaves facilitator undefined when omitted', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.facilitator).toBeUndefined();
			},
		);
	});

	it('parses repo field', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\nrepo: https://github.com/test-org/test-repo.git\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.repo).toBe('https://github.com/test-org/test-repo.git');
			},
		);
	});

	it('parses team_name field', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\nteam_name: dev\n---\n\nHello team!`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.teamName).toBe('dev');
			},
		);
	});

	it('parses repo and team_name together', () => {
		withTempFile(
			`---\nteam:\n  alice: Developer\nrepo: https://github.com/test-org/test-repo.git\nteam_name: sample\ntailor_shop: ./override\n---\n\nBody content.`,
			(path) => {
				const result = parseProtocol(path);
				expect(result.repo).toBe('https://github.com/test-org/test-repo.git');
				expect(result.teamName).toBe('sample');
				expect(result.tailorShop).toBe('./override');
				expect(result.body).toBe('Body content.');
			},
		);
	});
});

describe('parseProtocolFromString', () => {
	it('parses front matter and body from a string', () => {
		const content = `---\nteam:\n  alice: Developer\nrepo: https://github.com/org/repo.git\n---\n\nDo the work.`;
		const result = parseProtocolFromString(content);
		expect(result.team).toEqual({ alice: 'Developer' });
		expect(result.repo).toBe('https://github.com/org/repo.git');
		expect(result.body).toBe('Do the work.');
	});

	it('throws when content does not start with ---', () => {
		expect(() => parseProtocolFromString('No front matter')).toThrow('Expected front matter starting with ---');
	});

	it('throws when closing --- is missing', () => {
		expect(() => parseProtocolFromString('---\nteam:\n  alice: Dev\n')).toThrow('Expected closing --- for front matter');
	});
});

describe('parseAgentPromptFile', () => {
	it('extracts model and body from front matter', () => {
		const result = parseAgentPromptFile(`---\nmodel: gpt-4o\n---\n\nYou are an architect.`);
		expect(result.model).toBe('gpt-4o');
		expect(result.execution).toBe('session');
		expect(result.body).toBe('You are an architect.');
	});

	it('returns undefined model when front matter lacks model', () => {
		const result = parseAgentPromptFile(`---\nother: value\n---\n\nYou are a developer.`);
		expect(result.model).toBeUndefined();
		expect(result.execution).toBe('session');
		expect(result.body).toBe('You are a developer.');
	});

	it('returns whole content as body when no front matter', () => {
		const result = parseAgentPromptFile('You are a tester.');
		expect(result.model).toBeUndefined();
		expect(result.execution).toBe('session');
		expect(result.body).toBe('You are a tester.');
	});

	it('handles empty body after front matter', () => {
		const result = parseAgentPromptFile(`---\nmodel: gpt-4o\n---\n`);
		expect(result.model).toBe('gpt-4o');
		expect(result.execution).toBe('session');
		expect(result.body).toBe('');
	});

	it('defaults execution to session when field is absent', () => {
		const result = parseAgentPromptFile(`---\nmodel: gpt-4o\n---\n\nBody.`);
		expect(result.execution).toBe('session');
	});

	it('passes through execution: session', () => {
		const result = parseAgentPromptFile(`---\nexecution: session\n---\n\nBody.`);
		expect(result.execution).toBe('session');
	});

	it('passes through execution: single-shot', () => {
		const result = parseAgentPromptFile(`---\nexecution: single-shot\n---\n\nBody.`);
		expect(result.execution).toBe('single-shot');
	});

	it('passes through unknown execution value without validation', () => {
		const result = parseAgentPromptFile(`---\nexecution: turbo\n---\n\nBody.`);
		expect(result.execution).toBe('turbo');
	});
});
