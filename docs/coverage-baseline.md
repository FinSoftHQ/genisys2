# Coverage Baseline

Date: 2026-05-08
Command: `pnpm vitest run --coverage`

## Current baseline snapshot

- Test files: `39` total (`32` passed, `7` failed)
- Test cases: `602` total (`546` passed, `56` failed)
- Runtime: `49.54s`

## Current blocker

Coverage percentages were not emitted because the run ended with existing test failures in `@repo/web`.

Primary failing suite:

- `src/apps/web/app/pages/index.test.ts`
- Additional failures in home and kanban component suites under `src/apps/web/app/components/**`

## Next step to refresh this baseline

1. Resolve existing `@repo/web` failing tests.
2. Re-run `pnpm vitest run --coverage`.
3. Replace this file with branch/function/line/statements percentages per workspace package.
