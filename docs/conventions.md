# Engineering Conventions

These conventions are the baseline guardrails for refactoring and daily development.

## Design and module boundaries

- Keep HTTP, SSE, and SQLite contracts stable unless a task explicitly allows contract changes.
- Prefer behavior-preserving refactors that are protected by existing tests.
- Keep one primary concern per file/module.

## File size budgets

- TypeScript (`.ts`): target <= 400 lines.
- Vue SFC (`.vue`): target <= 250 lines.
- Temporary exceptions are allowed for existing legacy files and must be documented in the refactor plan.

## Dependency and typing rules

- Do not introduce new `instance: unknown` data-access APIs.
- Use typed `DbInstance`/context types at module boundaries.
- Resolve loose/untyped dependencies at route/plugin edges, not inside core domain modules.

## Lint and code health

- Keep `import/no-cycle` clean for new code.
- Use `max-lines` warnings as early pressure to split growing modules.
- If a file is explicitly allowlisted for legacy reasons, avoid adding new responsibilities to it.

## PR and execution flow

- Keep PRs small and reviewable whenever possible.
- Run `pnpm lint`, `pnpm typecheck`, and `just test` before merge.
- Regenerate `llm_context.md` at phase boundaries during major refactors.
