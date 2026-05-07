# Project Context

Generated from: `/home/dev3x/w/genisys2/src/apps/api/.workspaces/B0EE-1`

## Table of Contents

1. [Project Tree](#project-tree)
2. [File Contents](#file-contents)

## Summary

- **Files Discovered:** 127
- **Files Parsed:** 127
- **Files Skipped:** 0

## Project Tree

```
├── docs
│   └── schema-patched.ts
├── e2e
│   ├── tests
│   │   └── hello-board.spec.ts
│   ├── fixtures.ts
│   └── playwright.config.ts
├── src
│   ├── apps
│   │   ├── ai-workflow
│   │   │   ├── src
│   │   │   │   └── mastra
│   │   │   │       ├── agents
│   │   │   │       │   ├── agent-rooms-agent.ts
│   │   │   │       │   └── pi-agent.ts
│   │   │   │       ├── tools
│   │   │   │       │   ├── agent-rooms-tool.test.ts
│   │   │   │       │   ├── agent-rooms-tool.ts
│   │   │   │       │   ├── filesystem-tool.test.ts
│   │   │   │       │   └── filesystem-tool.ts
│   │   │   │       ├── workflows
│   │   │   │       │   ├── steps
│   │   │   │       │   │   ├── agent-room-create-step.ts
│   │   │   │       │   │   ├── agent-room-return-step.ts
│   │   │   │       │   │   ├── agent-room-wait-idle-step.ts
│   │   │   │       │   │   ├── agent-rooms-workflow-schemas.ts
│   │   │   │       │   │   ├── pi-agent-destroy-step.ts
│   │   │   │       │   │   ├── pi-agent-schemas.ts
│   │   │   │       │   │   └── pi-agent-step.ts
│   │   │   │       │   ├── agent-rooms-workflow.ts
│   │   │   │       │   └── pi-agent-workflow.ts
│   │   │   │       ├── agent-os-server.ts
│   │   │   │       └── index.ts
│   │   │   └── vitest.config.ts
│   │   ├── api
│   │   │   ├── src
│   │   │   │   ├── agent-rooms
│   │   │   │   │   ├── diagnostics.cwd.test.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── manager.single-shot.test.ts
│   │   │   │   │   ├── manager.spawn-cwd.test.ts
│   │   │   │   │   ├── manager.test.ts
│   │   │   │   │   ├── manager.ts
│   │   │   │   │   └── routes.ts
│   │   │   │   ├── db
│   │   │   │   │   ├── client.ts
│   │   │   │   │   ├── schema.ts
│   │   │   │   │   ├── seed.test.ts
│   │   │   │   │   └── seed.ts
│   │   │   │   ├── dev-wrapup
│   │   │   │   │   ├── routes.test.ts
│   │   │   │   │   ├── routes.ts
│   │   │   │   │   ├── service.test.ts
│   │   │   │   │   └── service.ts
│   │   │   │   ├── kanban
│   │   │   │   │   ├── board-stream.test.ts
│   │   │   │   │   ├── board-stream.ts
│   │   │   │   │   ├── config.ts
│   │   │   │   │   ├── db-context.ts
│   │   │   │   │   ├── event-log.ts
│   │   │   │   │   ├── exec-helpers.ts
│   │   │   │   │   ├── family-tree.ts
│   │   │   │   │   ├── git-helpers.ts
│   │   │   │   │   ├── hook-dispatcher.test.ts
│   │   │   │   │   ├── hook-dispatcher.ts
│   │   │   │   │   ├── processing-orchestrator.test.ts
│   │   │   │   │   ├── processing-orchestrator.ts
│   │   │   │   │   ├── processor-agentic-team.test.ts
│   │   │   │   │   ├── processor-agentic-team.ts
│   │   │   │   │   ├── processor-commit.test.ts
│   │   │   │   │   ├── processor-commit.ts
│   │   │   │   │   ├── processor-delegated.test.ts
│   │   │   │   │   ├── processor-delegated.ts
│   │   │   │   │   ├── processor-done.test.ts
│   │   │   │   │   ├── processor-done.ts
│   │   │   │   │   ├── processor-planning.test.ts
│   │   │   │   │   ├── processor-planning.ts
│   │   │   │   │   ├── processor-prep.test.ts
│   │   │   │   │   ├── processor-prep.ts
│   │   │   │   │   ├── processor-registry.test.ts
│   │   │   │   │   ├── processor-registry.ts
│   │   │   │   │   ├── processor-routes.test.ts
│   │   │   │   │   ├── processor-routes.ts
│   │   │   │   │   ├── processor-wrap.test.ts
│   │   │   │   │   ├── processor-wrap.ts
│   │   │   │   │   ├── repository.test.ts
│   │   │   │   │   ├── repository.ts
│   │   │   │   │   ├── request-actor.ts
│   │   │   │   │   ├── routes.test.ts
│   │   │   │   │   └── routes.ts
│   │   │   │   ├── lib
│   │   │   │   │   └── ai-auth.ts
│   │   │   │   ├── proxy-room
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── routes.test.ts
│   │   │   │   │   └── routes.ts
│   │   │   │   ├── squads
│   │   │   │   │   ├── jsonl.ts
│   │   │   │   │   ├── logger.ts
│   │   │   │   │   ├── manager.test.ts
│   │   │   │   │   ├── manager.ts
│   │   │   │   │   └── routes.ts
│   │   │   │   ├── health.test.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── server.test.ts
│   │   │   │   └── server.ts
│   │   │   └── vitest.config.ts
│   │   └── web
│   │       ├── app
│   │       │   ├── components
│   │       │   │   ├── home
│   │       │   │   │   ├── HomeBoardQuickAccessCard.test.ts
│   │       │   │   │   ├── HomeBoardQuickAccessCard.vue
│   │       │   │   │   ├── HomeSuiteQuickAccessCard.test.ts
│   │       │   │   │   └── HomeSuiteQuickAccessCard.vue
│   │       │   │   └── kanban
│   │       │   │       ├── AuditLogPanel.test.ts
│   │       │   │       ├── AuditLogPanel.vue
│   │       │   │       ├── BoardColumn.test.ts
│   │       │   │       ├── BoardColumn.vue
│   │       │   │       ├── BoardView.test.ts
│   │       │   │       ├── BoardView.vue
│   │       │   │       ├── CreateCardModal.vue
│   │       │   │       ├── EditCardModal.vue
│   │       │   │       ├── KanbanCard.test.ts
│   │       │   │       └── KanbanCard.vue
│   │       │   ├── composables
│   │       │   │   ├── useBoardRealtime.test.ts
│   │       │   │   ├── useBoardRealtime.ts
│   │       │   │   ├── useBoardsList.ts
│   │       │   │   ├── useBoardStore.test.ts
│   │       │   │   ├── useBoardStore.ts
│   │       │   │   └── useSuitesList.ts
│   │       │   ├── contracts
│   │       │   │   └── kanban-home.contract.ts
│   │       │   ├── layouts
│   │       │   │   └── default.vue
│   │       │   ├── pages
│   │       │   │   ├── boards
│   │       │   │   │   └── [boardId].vue
│   │       │   │   ├── index.test.ts
│   │       │   │   └── index.vue
│   │       │   ├── utils
│   │       │   │   └── api-error.ts
│   │       │   └── app.vue
│   │       ├── nuxt.config.ts
│   │       └── vitest.config.ts
│   └── libs
│       ├── logger
│       │   ├── src
│       │   │   ├── index.test.ts
│       │   │   └── index.ts
│       │   └── vitest.config.ts
│       └── shared
│           ├── src
│           │   ├── index.test.ts
│           │   ├── index.ts
│           │   ├── kanban-schemas.test.ts
│           │   ├── kanban-schemas.ts
│           │   ├── protocol-parser.test.ts
│           │   └── protocol-parser.ts
│           └── vitest.config.ts
├── vitest.config.ts
└── vitest.workspace.ts
```

------

## File Contents

<file path=".dossier/sow.md">
<reasoning>Mission statement; include first so downstream readers understand the requested work.</reasoning>
```md
# Statement of Work

## Card
- Display ID: PH8I-1
- Title: TST

## Mission
## Diagnostics Mission — Verify Agent Working Directory

The mission is to create and run a working-directory diagnostic test:

1. Create a test file at `src/apps/api/src/agent-rooms/diagnostics.cwd.test.ts`
2. Write a test that:
  - Prints the current working directory using `console.log('[DIAGNOSTICS] CWD:', process.cwd())`
  - Asserts that `process.cwd()` is a valid path that contains a `package.json` file (use `fs.existsSync(path.join(process.cwd(), 'package.json'))`)
  - Verifies that `src/apps/api/package.json` exists relative to the current working directory
3. Run the test with `pnpm vitest run src/apps/api/src/agent-rooms/diagnostics.cwd.test.ts`
4. Report the full test output back to Linda.

After Linda receive the report, She will close the mission.

```
</file>

<file path="src/apps/api/src/agent-rooms/diagnostics.cwd.test.ts">
<reasoning>Test file to be created/modified based on the SOW mission.</reasoning>
```ts
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';

describe('agent-rooms diagnostics cwd', () => {
	it('prints and verifies the working directory', () => {
		console.log('[DIAGNOSTICS] CWD:', process.cwd());

		expect(process.cwd()).toBe('/home/dev3x/w/genisys2');
		expect(existsSync('/home/dev3x/w/genisys2/package.json')).toBe(true);
	});
});

```
</file>

<file path="src/apps/api/vitest.config.ts">
<reasoning>Vitest configuration for the API app, needed to understand test setup and run command.</reasoning>
```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/.workspaces/**'],
  },
});

```
</file>

<file path="vitest.workspace.ts">
<reasoning>Workspace configuration defining which vitest configs are active, relevant for running tests.</reasoning>
```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'src/apps/*/vitest.config.ts',
  'src/libs/*/vitest.config.ts',
]);

```
</file>

<file path="vitest.config.ts">
<reasoning>Root vitest configuration, relevant for understanding global test settings.</reasoning>
```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.workspaces/**'],
  },
});

```
</file>

<file path="package.json">
<reasoning>Root package.json with pnpm scripts and workspace configuration needed to run tests.</reasoning>
```json
{
  "name": "genisys",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.0.0 <23.0.0"
  },
  "devEngines": {
    "runtime": {
      "name": "bun",
      "version": ">=1.2.0"
    }
  },
  "packageManager": "pnpm@10.20.0",
  "scripts": {
    "dev": "just dev",
    "build": "just build",
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:e2e": "just test-e2e",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit && pnpm --filter web typecheck",
    "start": "node src/apps/api/dist/index.js"
  },
  "pnpm": {
    "onlyBuiltDependencies": [
      "esbuild",
      "@parcel/watcher",
      "better-sqlite3"
    ]
  },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/typescript-config": "workspace:*",
    "@vitest/coverage-v8": "catalog:",
    "eslint": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}

```
</file>

<file path="src/apps/api/package.json">
<reasoning>API app package.json with vitest dependency and scripts; path is validated by the diagnostic test.</reasoning>
```json
{
  "name": "@repo/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --out-dir dist --target node22",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/cors": "catalog:",
    "@fastify/helmet": "catalog:",
    "@fastify/rate-limit": "catalog:",
    "@fastify/websocket": "catalog:",
    "@mariozechner/pi-ai": "catalog:",
    "@mariozechner/pi-coding-agent": "catalog:",
    "@octokit/rest": "catalog:",
    "@repo/logger": "workspace:*",
    "@repo/shared": "workspace:*",
    "better-sqlite3": "catalog:",
    "drizzle-orm": "catalog:",
    "fastify": "catalog:",
    "fastify-type-provider-zod": "catalog:",
    "pino": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@types/better-sqlite3": "catalog:",
    "@types/node": "catalog:",
    "drizzle-kit": "catalog:",
    "tsup": "catalog:",
    "tsx": "catalog:",
    "typescript": "catalog:"
  }
}

```
</file>
