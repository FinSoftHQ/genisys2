import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, './server.ts');
const source = readFileSync(serverPath, 'utf-8');

describe('server.ts kanban registration expectation', () => {
  it('imports kanban routes from kanban module', () => {
    expect(source).toContain("from './kanban/routes.js'");
    expect(source).toContain('kanbanRoutes');
  });

  it('registers kanban routes under /api/boards prefix', () => {
    expect(source).toMatch(
      /app\.register\s*\(\s*kanbanRoutes\s*,\s*\{\s*prefix:\s*['"]\/api\/boards['"]\s*\}\s*\)/,
    );
  });
});

describe('server.ts testability expectations', () => {
  it('exports the fastify app instance for programmatic use', () => {
    expect(source).toMatch(/export\s+(?:const|let|var)?\s*app\b/);
  });

  it('does not start the server at module evaluation time', () => {
    expect(source).not.toMatch(/await\s+app\.listen\s*\(/);
  });
});
