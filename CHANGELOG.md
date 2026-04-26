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

### Intentionally Deferred

- SSE / real-time updates
- Async processor hooks and DLQ
- Idempotency keys
- Pagination on snapshot
- Event logging and audit trail
