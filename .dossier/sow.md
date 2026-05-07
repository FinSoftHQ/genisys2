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
