# Changelog

## [1.0.0-slice1] — 2026-04-26

### Added

#### Backend — Kanban Slice 1 MVP

- **Database schema** (`src/apps/api/src/db/schema.ts`, `src/apps/api/src/db/migrations/0001_kanban_slice1.sql`)
  - SQLite tables: `boards`, `board_sequences`, `cards`
  - WAL-mode pragmas: `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`
  - Indexes on `cards(board_uid)` and `cards(display_id)`

- **Deterministic demo board seeding** (`src/apps/api/src/db/seed.ts`)
  - `seedBoard()` creates a demo board with three columns: **Backlog**, **In Progress**, **Done**
  - Prefix format `S{n}` for display ID generation (e.g. `S0-1`)

- **Transactional display ID generation** (`board_sequences` table)
  - Atomic `{prefix}-{seq_value}` allocation via SQL `seq_value + 1` update within a transaction

- **Kanban repository** (`src/apps/api/src/kanban/repository.ts`)
  - `getBoardById`, `getSnapshot`, `getCardById`
  - `createCard` — validates column membership, allocates display ID atomically, inserts card
  - `updateCard` — partial update of title/description, auto-increments `version`
  - `moveCard` — changes `current_status`, validates target column, auto-increments `version`

- **Kanban API routes** (`src/apps/api/src/kanban/routes.ts`) mounted at `/api/boards`
  - `GET /:boardId/snapshot` — full board state with all cards (no pagination), returns `{ data: { board, cards } }`
  - `POST /:boardId/cards` — create card, validates `current_status` against board schema
  - `GET /:boardId/cards/:cardId` — get single card
  - `PATCH /:boardId/cards/:cardId` — update card title/description, requires at least one field
  - `POST /:boardId/cards/:cardId/move` — move card between columns, validates target column

- **Response envelope** — all endpoints return `{ data: { ... } }` to leave room for future pagination metadata

- **Validation** — input validated via Zod schemas in `@repo/shared` (`kanban-schemas.ts`)
  - `BoardPathParamsSchema`, `CardPathParamsSchema`
  - `CreateCardRequestSchema`, `UpdateCardRequestSchema`, `MoveCardRequestSchema`

#### Frontend — Kanban Slice 1 MVP

- **Board landing page** (`src/apps/web/pages/index.vue`)
  - Simple input form to navigate to a board by UUID

- **Board page** (`src/apps/web/pages/boards/[boardId].vue`)
  - Route-level host for a single kanban board
  - Fetches snapshot on mount, handles loading/error states, renders `BoardView`

- **Board store** (`src/apps/web/composables/useBoardStore.ts`)
  - Reducer-style in-memory reactive store designed for future SSE integration
  - `hydrate(snapshot)` — populates `board`, `cardsById` Map, and `columnCardIds` Map
  - `addCard(card)`, `updateCard(card)`, `moveCardLocal(cardId, toColumnUid)` — optimistic mutations
  - `getCardsForColumn(columnUid)` — returns sorted cards for a given column
  - UI state tracked separately: `isLoading`, `isSaving`, `error`, `draggedCardId`

- **Board view** (`src/apps/web/components/kanban/BoardView.vue`)
  - Root layout rendering all columns horizontally
  - Orchestrates drag-and-drop move: optimistic local update → API call → server response reconciliation → revert on failure
  - Hosts `CreateCardModal` and `EditCardModal`

- **Board column** (`src/apps/web/components/kanban/BoardColumn.vue`)
  - Renders a single column with title, card count area, and drop zone
  - Emits `create`, `edit`, `drop-card` events
  - HTML5 drag-and-drop drop target

- **Kanban card** (`src/apps/web/components/kanban/KanbanCard.vue`)
  - Displays card title, optional description (clamped), `display_id` badge, and processing state badge
  - Draggable via HTML5 DnD; emits `edit` event on pencil click

- **Create card modal** (`src/apps/web/components/kanban/CreateCardModal.vue`)
  - Nuxt UI modal with title/description form
  - Zod client-side validation, submits to `POST /api/boards/{boardUid}/cards`

- **Edit card modal** (`src/apps/web/components/kanban/EditCardModal.vue`)
  - Nuxt UI modal pre-filled with existing card data
  - Zod client-side validation, submits to `PATCH /api/boards/{boardUid}/cards/{cardId}`

## [1.1.0-slice2] — 2026-04-27

### Added

#### Backend — Safe Moves & Optimistic Locking

- **Optimistic locking on card updates** (`src/apps/api/src/kanban/routes.ts`, `src/apps/api/src/kanban/repository.ts`)
  - `PATCH /api/boards/{boardId}/cards/{cardId}` now requires `version` in the request body.
  - Repository `updateCard` rejects the update when `input.version` does not match the DB row.
  - On mismatch, the endpoint returns `409 Conflict` with `error.details.card` containing the authoritative current state.

- **Synchronous `can-exit` hook dispatcher** (`src/apps/api/src/kanban/hook-dispatcher.ts`)
  - `dispatchSyncHook` POSTs to `{processor.base_url}/{hook}` with a strict 3-second timeout (`AbortController` + `Promise.race`).
  - Timeout hard-coded to `3000ms`; violation aborts the fetch and throws.
  - Parses and validates the processor response through `CanExitHookResponseSchema`.

- **`can-exit` gatekeeper on card moves** (`src/apps/api/src/kanban/routes.ts`)
  - `POST /api/boards/{boardId}/cards/{cardId}/move` resolves the card's current column, looks up its `processor_id`, and dispatches `can-exit`.
  - If the processor returns `allowed: false`, the API immediately returns `409 Conflict` (`MOVE_BLOCKED`) with the processor's message; the card is **not** moved.
  - If the hook times out or fails, the error propagates and the move is aborted.

- **Processor registry table & default processor** (`src/apps/api/src/db/migrations/0002_kanban_slice2.sql`, `src/apps/api/src/db/schema.ts`, `src/apps/api/src/db/seed.ts`)
  - New `processor_registry` table stores processor metadata, supported hooks, SLA, and auth config.
  - `bootstrapDefaultProcessor()` seeds a `default-manual` processor that registers all five hooks (`on-enter`, `on-update`, `on-action`, `can-exit`, `on-exit`).
  - The default processor runs at `http://localhost:4001` and currently returns `allowed: true` for all `can-exit` calls.

- **Card state fields** (`src/apps/api/src/db/schema.ts`)
  - `processing_state` (`IDLE` | `PROCESSING` | `ERROR`) added to `cards` table, default `IDLE`.
  - `is_editable` (`boolean`) added to `cards` table, default `true`.
  - Both fields are present in `CardEntitySchema` and returned in all card responses.

#### Frontend — Conflict Banner & Blocked-Move Toast

- **Optimistic-lock conflict handling in `EditCardModal.vue`**
  - On `409 CONFLICT`, the modal displays a red `UAlert` banner: "Someone else edited this — refresh and retry".
  - The banner exposes a **Refresh** `UButton` that calls `onRefreshConflict()`, which pushes the server card into the store via `updateCard()` and dismisses the banner.
  - The **Save** button is disabled (`:disabled="!!conflictServerCard"`) while the conflict is visible, preventing repeated overwrites.

- **Blocked-move toast in `BoardView.vue`**
  - When a drag-and-drop move receives `409 MOVE_BLOCKED`, the failure handler calls `useToast().add()` with `color: 'error'`, `icon: 'i-lucide-ban'`, and the processor message.
  - The optimistic local move is reverted immediately so the card snaps back to its original column.
  - Generic move errors continue to surface through the existing `UAlert` error banner.

- **Store additions** (`composables/useBoardStore.ts`)
  - Added `getCardById(cardId: string): CardEntity | undefined` helper used by `EditCardModal` and `BoardView`.

### Changed

- **OpenAPI spec** (`docs/openapi.yaml`)
  - Bumped version to `1.1.0`.
  - `UpdateCardRequest` now requires `version`.
  - `PATCH /boards/{boardId}/cards/{cardId}` documents `409 Conflict` (`CardConflictResponse`).
  - `POST /boards/{boardId}/cards/{cardId}/move` documents `409 Conflict` (`MoveCardBlockedResponse`) and the `can-exit` hook behavior.

## [1.2.0-slice3] — 2026-04-27

### Added

#### Backend — Smart Columns & Async Processing

- **Processing column support** (`src/apps/api/src/db/schema.ts`, `src/apps/api/src/db/migrations/0003_kanban_slice3.sql`)
  - `cards.processing_state` enum (`IDLE` | `PROCESSING` | `ERROR`) with default `IDLE`.
  - `cards.is_editable` boolean, default `true`. Schema validation enforces `is_editable: false` when state is `PROCESSING` or `ERROR`.
  - `BoardColumn.type` now supports `Normal` and `Processing`. Processing columns require at least one `exit_logic` route.
  - New `callback_tokens` table: `token` (UUID PK), `card_uid`, `processor_id`, `hook`, `idempotency_key`, `context`, `expires_at`, `created_at`.

- **Processor registry** (`src/apps/api/src/db/schema.ts`, `src/apps/api/src/kanban/processor-registry.ts`)
  - `processor_registry` table stores processor metadata: `base_url`, `health_endpoint`, supported `hooks`, `sla_seconds`, `max_sla_seconds`, `auth_type`, `auth_config`, `hmac_secret`, and `status`.
  - `runHealthCheck(processor)` performs a `GET {base_url}{health_endpoint}` with a 3-second timeout and returns `healthy`, `degraded`, or `unhealthy`.
  - `getHealthPollConfig()` returns `interval_seconds: 30`, `timeout_ms: 3000`.
  - `seed.ts` and `repository.ts` seed a `manager-approval` processor for the `in-review` Processing column. `hmac_secret` is seeded as `temp-secret-ignore` (actual HMAC enforcement deferred to Slice 6).

- **Async hook dispatcher** (`src/apps/api/src/kanban/hook-dispatcher.ts`)
  - `dispatchAsyncHook(processor, hook, payload)` POSTs to `{processor.base_url}/{hook}` without timeout (fire-and-forget style).
  - `dispatchSyncHook(...)` unchanged from Slice 2 (3-second timeout, used for `can-exit`).

- **Processing orchestrator** (`src/apps/api/src/kanban/processing-orchestrator.ts`)
  - `startProcessing(db, board, card, processingColumn)` — validates transition from `IDLE`, atomically sets `processing_state = PROCESSING` and `is_editable = false`, generates a UUID `callback_token` with 10-minute expiry, stores it in `callback_tokens`, and dispatches `on-enter` to the processor with `callback_url`, `idempotency_key`, and full context.
  - `consumeCallback(db, token, authHeader, payload)` — looks up the token (404 if missing, 410 if expired, 409 if replayed), applies `payload_updates` on success, optionally moves the card via `move_to_column`, sets `processing_state = IDLE` and `is_editable = true` on success or `ERROR`/`false` on error, atomically deletes the token row, and adds the token to an in-memory replay-protection set.

- **Callback receiver endpoint** (`src/apps/api/src/kanban/routes.ts`)
  - `POST /api/callbacks/{token}` — validates path param, `Authorization: Bearer` header, and request body via Zod schemas.
  - Returns `{ data: { card } }` on success.
  - Error codes: `CALLBACK_TOKEN_MISSING` (404), `CALLBACK_TOKEN_EXPIRED` (410), `CALLBACK_TOKEN_REPLAYED` (409).

- **Move blocking for locked cards** (`src/apps/api/src/kanban/routes.ts`)
  - `POST /api/boards/{boardId}/cards/{cardId}/move` rejects cards in `PROCESSING` state with `409 MOVE_BLOCKED` before the `can-exit` hook is even dispatched.

- **Repository additions** (`src/apps/api/src/kanban/repository.ts`)
  - `updateCardProcessingState` — atomic conditional update using `fromState` / `toState` validation via `ProcessingStateTransitionSchema`.
  - `createCallbackToken`, `getCallbackToken`, `deleteCallbackToken` — callback token CRUD.
  - `getProcessorById`, `upsertProcessorRegistry` — processor registry access.
  - `seedDemoBoardWithProcessingColumn` — creates a demo board with a Processing `in-review` column.
  - `bootstrapDefaultProcessor` — seeds the `default-manual` processor.

- **Seeding** (`src/apps/api/src/db/seed.ts`)
  - `seedDemoBoardWithProcessingColumn()` creates a board with `backlog` (Normal), `in-review` (Processing, `manager-approval`), and `done` (Normal).
  - Ensures `manager-approval` processor row exists in `processor_registry` with placeholder `hmac_secret`.

#### Frontend — Spinner, Lock, and Polling

- **Board store polling** (`src/apps/web/app/composables/useBoardStore.ts`)
  - New computed: `hasProcessingCards` — true when any card has `processing_state === 'PROCESSING'`.
  - New state: `ui.pollIntervalId`.
  - `startPolling(refresh, intervalMs = 2000)` — starts an interval that calls the provided `refresh()` function every 2 seconds.
  - `stopPolling()` — clears the interval and nulls the id.
  - `resetStore()` now stops polling before clearing state.

- **Kanban card spinner overlay** (`src/apps/web/app/components/kanban/KanbanCard.vue`)
  - When `processing_state === 'PROCESSING'`, a full-card overlay renders with a spinning `i-lucide-loader-2` icon and a semi-transparent backdrop (`bg-white/60 dark:bg-gray-900/60 backdrop-blur-[1px]`).
  - Cards in `PROCESSING` or `ERROR` state are non-draggable (`draggable: false`), non-editable (pencil hidden), and styled with `cursor-not-allowed opacity-80`.
  - `processing_state` badge shown when not `IDLE` (`ERROR` = error color, `PROCESSING` = info color).

- **Board column Processing badge** (`src/apps/web/app/components/kanban/BoardColumn.vue`)
  - Columns of `type === 'Processing'` display an `info` colored `UBadge` labeled "Processing" next to the column title.

- **Board view polling orchestration** (`src/apps/web/app/components/kanban/BoardView.vue`)
  - Watches `hasProcessingCards` and automatically starts/stops snapshot polling.
  - When a card enters `PROCESSING`, the board refreshes every 2 seconds so the UI can detect when the processor callback unlocks or moves the card.
  - Polling is cleaned up on component unmount via `onUnmounted`.

- **Edit card modal lock guard** (`src/apps/web/app/components/kanban/EditCardModal.vue`)
  - New computed `isLocked` — true when `processing_state` is `PROCESSING` or `ERROR`.
  - Displays a warning `UAlert` with lock icon when the card is locked: "Card is locked — This card is being processed and cannot be edited right now."
  - The **Save** button is disabled when `isLocked` is true.
  - Submit handler rejects edits early with `errorMsg = 'This card is currently locked and cannot be edited.'`.

### Changed

- **OpenAPI spec** (`docs/openapi.yaml`)
  - Bumped version to `1.2.0`.
  - Added `POST /boards` (create board).
  - Added `POST /callbacks/{token}` with full request/response schemas and error codes.
  - `CardEntity` now documents `processing_state` and `is_editable` semantics.
  - `BoardColumn` documents `Processing` type and `exit_logic` requirements.
  - `POST /boards/{boardId}/cards/{cardId}/move` documents `MOVE_BLOCKED` for cards in `PROCESSING` state.

### Intentionally Deferred

- HMAC signature verification on callbacks (trust the token for now)
- DLQ for SLA breaches
- SSE real-time updates
- Pagination on snapshot
- Event logging and audit trail
