# Refactoring Plan — Genisys

**Scope:** full codebase (api, web, libs, tools, docs, tests)
**Risk level:** moderate — internal module APIs may change; HTTP, SSE, and DB contracts are preserved unless explicitly flagged.
**Style:** phased, checkbox-driven; each phase ends with `pnpm lint && pnpm typecheck && just test` green.
**Destination:** `docs/refactoring-plan.md` (this file).

---

## How to use this document

This plan is the **single source of truth** for the Genisys refactoring effort. Treat it as a living checklist, not a one-shot proposal.

**Working rhythm**

1. **One PR per task.** Each top-level checkbox (e.g. `2.1.4`, `3.2`) is sized to be a single, reviewable PR — typically ≤ 400 LOC of net diff (rule C.1). Sub-bullets are implementation notes, not separate PRs.
2. **Phases are gates, not just folders.** Don't start Phase N+1 until every box in Phase N is checked and the "Exit criteria" line is satisfied. Phases 0–7 are designed to run **serially**.
3. **Check the box in the same PR that completes the task.** Edit this file as part of the PR; reviewers verify the box matches the diff. A merged PR with an unchecked box is a process bug.
4. **Update `llm_context.md` at every phase boundary** (rule C.4). Run `pnpm refresh-context` (added in 7.3) or the equivalent generator. This keeps future agents/contributors looking at the current shape.
5. **Do not log refactors in `CHANGELOG.md`** (rule C.5). That file is reserved for user-visible feature slices. This document *is* the refactor log.

**Definition of done for any task**

- [ ] Box checked in this file.
- [ ] `pnpm lint && pnpm typecheck && just test` green locally and in CI.
- [ ] No file exceeds the 400/250 LOC ceiling without a justification comment at the top of the file.
- [ ] Behavior unchanged: HTTP routes, SSE event shapes, and the SQLite schema are byte-identical to the pre-PR state, unless the task explicitly says otherwise.
- [ ] Renames used `git mv` so blame survives (rule C.2).
- [ ] Any new public symbol has a corresponding test, or an existing test was rewired to the new location.

**When a task turns out to be wrong**

If reality contradicts the plan (e.g. a "5-minute extraction" reveals a hidden cyclic dependency), **stop and update this document first** in its own small PR before continuing. Add a short note under the affected task explaining the deviation. The plan should reflect what we are actually doing, not what we wished we were doing.

**Skipping or deferring tasks**

Mark a task `~~deferred~~` with a one-line rationale and a link to the issue or follow-up plan. Do not silently delete tasks — leave the audit trail.

**Reviewing this plan**

Re-read the full document at the start of every phase (5 minutes). Priorities and constraints from earlier phases often inform the next one (e.g. Phase 4's typed context becomes much easier once Phase 2.2's repos are split).

---

## Decisions captured from clarifying round

1. `squads/` is **internal-only and safe to delete** (no external clients on `/squads/*`).
2. Web polish (Phase 6) **stays in scope**.
3. Shared processor helpers will live under **`kanban/processors/runtime/`**.
4. `useBoardStore` will be **migrated to Pinia** (not left as a hand-rolled `ref` store).
5. Refactor work will **not** be logged in `CHANGELOG.md`; that file remains a feature/slice log.
6. Phases will run **serially** (single-engineer cadence assumed).

## Guiding principles

1. **Behavior-preserving by default.** Test suite must stay green at every step. HTTP, SSE, and DB schema are untouched.
2. **One concern per file.** Target ceiling: ~400 LOC for `.ts`, ~250 for `.vue`. Larger files require justification.
3. **Explicit dependencies.** No more `instance: unknown` for the DB. Use a typed `DbInstance` (or Fastify-decorated context) and resolve at the edge.
4. **Eliminate duplication cheaply first.** Extract helpers/factories before introducing frameworks.
5. **Tests pin contracts, not implementations.** Keep boundary tests; refactor internals freely.

---

## Phase 0 — Preconditions (1 PR, ~2h)

- [x] **0.1** Confirm CI runs `pnpm lint && pnpm typecheck && pnpm test` on every PR; add if missing.
- [x] **0.2** Capture a `vitest --coverage` baseline; commit summary to `docs/coverage-baseline.md` as a regression guardrail.
- [x] **0.3** Add `eslint-plugin-import` `no-cycle` and `max-lines` (warn at 500). Allowlist current offenders so the rule isn't blocking.
- [x] **0.4** Document the "no `instance: unknown`" target and the 400/250 LOC ceiling in `docs/conventions.md`.

**Exit criteria:** lint/typecheck/test pass; baseline metrics committed.

Current status (2026-05-08): tasks 0.1-0.4 completed; `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green (lint warnings only).

## Phase 1 — Quick wins, no behavior change (~3 PRs, 1 day)

- [x] **1.1** **Delete legacy `squads/`** (confirmed internal-only).
  - Remove `src/apps/api/src/squads/{manager,manager.test,routes,jsonl,logger}.ts`.
  - Move the still-used pieces (`jsonl.ts`, `SquadLogger` → renamed `RoomLogger`) into `agent-rooms/internal/`.
  - Drop `squadRoutes` registration from `server.ts`.
  - `rg "from ['\"].*squads" src` to verify zero remaining imports.
- [x] **1.2** **Stale doc cleanup.**
  - `docs/schema-patched.ts` is out of sync with `db/schema.ts` → relocate to `docs/_archive/schema-2024.ts` with a header comment, or delete.
- [x] **1.3** **Disambiguate processor file names.**
  - Rename `kanban/processor-routes.ts` → `kanban/processors/context-routes.ts` (it serves the generic `ProcessorContext` callback).
  - Top-of-file comment on `processor-registry.ts` explaining its scope (registry + health polling, not HTTP routes).
- [x] **1.4** **Bootstrap `kanban/processors/runtime/`** with shared boilerplate:
  - `error-response.ts` — `errorResponse(code, message, details?)`.
  - `callback.ts` — `fireAndForgetCallback(url, payload)`.
  - `define-processor.ts` — `definePiProcessor({ id, schemas, onEnter, onUpdate?, onAction?, onExit?, canExit? })` factory returning a Fastify plugin.
  - Migrate **`processor-done.ts`** as the proof of concept (smallest, simplest).

**Exit criteria:** ~600 LOC removed; one processor on the new helper; tests pass.

## Phase 2 — Split the giants (~5 PRs, 3–4 days)

### 2.1 `agent-rooms/manager.ts` (1,193 LOC → 5 files of ≤300 LOC)

- [x] **2.1.1** `agent-rooms/types.ts` — `Room`, `AgentState`, `StoredEvent`, `RoomStatus`, `RoutingStrategy`, `RoomCloseReason`. Pure types.
- [x] **2.1.2** `agent-rooms/event-store.ts` — `pushEvent`, `truncateEvents`, `getRoomEvents`, SSE broadcast helper.
- [x] **2.1.3** `agent-rooms/router.ts` — `determineRecipients`, `resolveMessageTargets`, `routeMessageToAgents`, `shouldCheckCompletionAfterTaskMarker`. Pure-ish; existing tests already cover it.
- [x] **2.1.4** `agent-rooms/spawn.ts` — `buildPiArgs`, `spawnAgentProcess`, `spawnAndSendToSingleShot`, `attachAgentEventHandlers`, `terminateSingleShotAgent`, `killAgentProcess`. Owns child-process lifecycle.
- [x] **2.1.5** `agent-rooms/lifecycle.ts` — expiry timers, idle-completion timers, callback signing, `notifyRoomClosedCallback`.
- [x] **2.1.6** `manager.ts` becomes a thin façade: `createRoomFromMarkdown`, `listRooms`, `getRoom`, `sendInstructions`, `destroyRoom`, `completeRoom`. Target ~250 LOC.
- [x] **2.1.7** Split `manager.test.ts` into `router.test.ts`, `spawn.test.ts`, `lifecycle.test.ts` reflecting the new boundaries. Keep `manager.test.ts` for façade-level scenarios.

### 2.2 `kanban/repository.ts` (820 LOC → 4 files)

- [ ] **2.2.1** `kanban/repos/board-repo.ts` — boards, suites, sequences (`createBoard`, `updateBoard`, `seedBoard`, `createSuite`, `listSuites`, `getSuiteById`, `getSuiteSnapshot`, `listBoards`, `getBoardById`, `getSnapshot`).
- [ ] **2.2.2** `kanban/repos/card-repo.ts` — cards (`getCardById`, `createCard`, `updateCard`, `moveCard`, `updateCardProcessingState`).
- [ ] **2.2.3** `kanban/repos/processor-repo.ts` — processor registry + callback tokens (`getProcessorById`, `upsertProcessorRegistry`, `createCallbackToken`, `getCallbackToken`, `deleteCallbackToken`).
- [ ] **2.2.4** `repository.ts` becomes a `@deprecated` barrel re-exporting the above + `db-context` + `family-tree` for back-compat.
- [ ] **2.2.5** Replace `instance: unknown` with `DbInstance` in **all new repo files**. Keep `unknown` only on the deprecated barrel.

### 2.3 `kanban/routes.ts` (670 LOC → 4 files)

- [ ] **2.3.1** `kanban/routes/board-routes.ts` — board + snapshot + audit-log endpoints.
- [ ] **2.3.2** `kanban/routes/card-routes.ts` — card CRUD + move + relationship + family.
- [ ] **2.3.3** `kanban/routes/suite-routes.ts` — moves the existing `suiteRoutes` plugin.
- [ ] **2.3.4** `kanban/routes/callback-routes.ts` — moves the existing `callbackRoutes` plugin.
- [ ] **2.3.5** `routes.ts` becomes a registration index that just `instance.register(...)`s the four files above.

### 2.4 `kanban/processor-explore.ts` (717) and `kanban/processor-planning.ts` (528)

- [ ] **2.4.1** Extract LLM prompt building into `kanban/llm-prompts/{explore,planning}.ts`.
- [ ] **2.4.2** Extract delimiter/JSONL parsing into `kanban/llm-parsers/`.
- [ ] **2.4.3** Move workspace path & executable resolution into `kanban/workspace.ts` (shared with `processor-prep.ts`).
- [ ] **2.4.4** Each processor file becomes orchestration only (≤200 LOC).

**Exit criteria:** no file in `src/apps/api/src/` exceeds 400 LOC except deprecated barrels. All tests pass.

## Phase 3 — Unify the processor framework (~3 PRs, 2 days)

Phase 1.4's `definePiProcessor` becomes load-bearing here.

- [ ] **3.1** Migrate every remaining processor to `kanban/processors/runtime/define-processor.ts`:
  - `processor-prep`, `processor-planning`, `processor-explore`, `processor-delegated`, `processor-agentic-team`, `processor-commit`, `processor-wrap`. (`processor-default`, `processor-todo` are seed-only — no routes.)
- [ ] **3.2** Auto-register processors in `server.ts`:
  - Replace 8 manual `await app.register(...)` calls with a `for` loop over a `processors` array exported from `kanban/processors/index.ts`.
- [ ] **3.3** Centralize `getApiBaseUrl`, `getAgentRoomsUrl`, `getRoomClosedCallbackUrl`, `getDevWrapupBaseUrl` in `kanban/processors/runtime/urls.ts`. Currently duplicated across `processor-agentic-team`, `processor-commit`, `processor-wrap`.
- [ ] **3.4** Add `kanban/processors/runtime/README.md` documenting how to add a new processor (target: ≤50 LOC of new code, no edits to `server.ts`).

**Exit criteria:** new processor = one new file under `kanban/processors/<name>.ts` exporting `definePiProcessor({...})`; `server.ts` untouched.

## Cross-cutting rules (apply during every phase)

- [ ] **C.1** Each PR ≤ ~400 LOC of net diff (excluding pure moves).
- [ ] **C.2** Use `git mv` for renames so blame survives.
- [ ] **C.3** Prefer barrel re-exports during transitions; remove the barrel in a follow-up PR after consumers are migrated.
- [ ] **C.4** Regenerate `llm_context.md` at the end of each phase.
- [ ] **C.5** Track per-PR refactor progress by checking off boxes in `docs/refactoring-plan.md`. Do **not** add refactor entries to `CHANGELOG.md` — that file is reserved for features/slices and shouldn't be diluted by refactor noise.

## What this plan deliberately does NOT do

- Change the HTTP API surface, SSE event shape, or SQLite schema.
- Adopt new frameworks (no NestJS, no tRPC). Pinia is the only new runtime dependency, scoped to Phase 6.3.
- Touch `tools/context-extractor` or `tools/context-generator` internals.
- Rewrite the `pi-coding-agent` integration.

## Suggested order of attack

1. **Phase 0** + **Phase 1** in the same week — cheap, removes ~600 LOC, sets guardrails.
2. **Phase 2.1** (manager.ts split) next — biggest single navigability win.
3. **Phase 2.2 + 2.3** — both touch repository/routes seams; do 2.2 first so 2.3 can lean on the typed repos.
4. **Phase 3** — payoff is multiplicative once 2.1.4 and 1.4 are in.
