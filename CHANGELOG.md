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

### Intentionally Deferred

- SSE / real-time updates
- Optimistic locking enforcement (version field exists but is not checked)
- Idempotency keys
- Processor hooks and DLQ
- Pagination on snapshot
- Event logging and audit trail
