# Kanban Components — Slice 1, 2, 3 & 4

> **Scope:** Slice 1 MVP + Slice 2 "Safe Moves" + Slice 3 "Smart Columns" + Slice 4 "Live Board"
> **Status:** Implemented.

---

## `pages/index.vue`

Landing page that allows users to navigate to a board by UUID.

### Behavior
- Displays a centered form with a "Board ID" input and an "Open Board" button.
- On submit, routes to `/boards/{boardId}`.

### Dependencies
- `vue-router` — `useRouter`
- `@nuxt/ui` — `UContainer`, `UPageHeader`, `UForm`, `UFormField`, `UInput`, `UButton`

---

## `pages/boards/[boardId].vue`

Route-level page component that hosts a single kanban board.

### Route Parameters
| Param     | Type   | Description         |
|-----------|--------|---------------------|
| `boardId` | string | Board UUID from URL |

### Behavior
- On mount, calls `loadSnapshot()` to fetch the full board state.
- Uses `useBoardStore()` for state management.
- Shows a loading spinner while fetching.
- Shows an error alert with a retry button on failure.
- Renders `BoardView` once the board is loaded.

### API Calls
| Method | Endpoint                              | Purpose        |
|--------|---------------------------------------|----------------|
| GET    | `/api/boards/{boardId}/snapshot`      | Load full state|

### Dependencies
- `@repo/shared` — `SnapshotResponse`
- `@nuxt/ui` — `UPage`, `UContainer`, `UAlert`, `UButton`, `UIcon`

---

## `composables/useBoardStore.ts`

Reducer-style in-memory reactive store for the kanban board.

Designed so that future SSE events can mutate the same store with zero UI rewrites.

### State Shape
```ts
interface BoardStore {
  board: BoardEntity | null;
  cardsById: Map<string, CardEntity>;
  columnCardIds: Map<string, string[]>; // columnUid -> cardUid[]
  ui: {
    isLoading: boolean;
    isSaving: boolean;
    error: string | null;
    draggedCardId: string | null;
    pollIntervalId: ReturnType<typeof setInterval> | null;
  };
}
```

### Computed
| Name                | Type                | Description                                            |
|---------------------|---------------------|--------------------------------------------------------|
| `sortedColumns`     | `BoardColumn[]`     | Board columns sorted by `order` ascending              |
| `hasProcessingCards`| `boolean`           | True when any card has `processing_state === 'PROCESSING'` |

### Methods
| Method                | Signature                                                          | Description                                                            |
|-----------------------|--------------------------------------------------------------------|------------------------------------------------------------------------|
| `resetStore`          | `() => void`                                                       | Clears all state back to initial values; stops polling if active       |
| `setLoading`          | `(value: boolean) => void`                                         | Toggles `ui.isLoading`                                                 |
| `setSaving`           | `(value: boolean) => void`                                         | Toggles `ui.isSaving`                                                  |
| `setError`            | `(error: string \| null) => void`                                  | Sets `ui.error`                                                        |
| `hydrate`             | `(snapshot: { board, cards }) => void`                             | Populates store from a snapshot response; builds `cardsById` and `columnCardIds` |
| `addCard`             | `(card: CardEntity) => void`                                       | Inserts a new card into `cardsById` and appends to `columnCardIds`     |
| `updateCard`          | `(card: CardEntity) => void`                                       | Updates `cardsById`; if `current_status` changed, moves between columns |
| `moveCardLocal`       | `(cardId: string, toColumnUid: string) => void`                    | Optimistically moves a card to another column without API call         |
| `setDraggedCardId`    | `(cardId: string \| null) => void`                                | Tracks the currently dragged card                                      |
| `startPolling`        | `(refresh: () => Promise<void>, intervalMs = 2000) => void`       | Starts interval polling for snapshot refresh                           |
| `stopPolling`         | `() => void`                                                       | Stops active polling interval                                          |
| `getCardById`         | `(cardId: string) => CardEntity \| undefined`                     | Returns a single card entity by UUID                                   |
| `getCardsForColumn`   | `(columnUid: string) => CardEntity[]`                              | Returns card entities for a given column uid                           |

### Notes
- The store is a single `ref<BoardStore>` exported as a module-level singleton.
- `hydrate` is the primary entry point; it reconstructs derived maps from the server snapshot.
- `moveCardLocal` does not update `version` or `updated_at`; it is meant for optimistic UI only.
- Polling is started/stopped automatically by `BoardView` based on `hasProcessingCards`.

---

## `composables/useBoardRealtime.ts`

Composable that manages a `fetch`-based Server-Sent Events connection for a single board.

### Signature
```ts
function useBoardRealtime(
  boardId: string,
  opts?: { onReload?: () => void }
): {
  status: Ref<ConnectionStatus>;
  lastEventId: Ref<string | null>;
  reconnectAttempt: Ref<number>;
  connect: () => Promise<void>;
  disconnect: () => void;
}
```

### Types
| Name                | Type                              | Description                                                |
|---------------------|-----------------------------------|------------------------------------------------------------|
| `ConnectionStatus`  | `'idle' \| 'connecting' \| 'connected' \| 'disconnected'` | Current SSE connection state |

### State
| Name              | Type                  | Description                                           |
|-------------------|-----------------------|-------------------------------------------------------|
| `status`          | `Ref<ConnectionStatus>` | Reactive connection status                            |
| `lastEventId`     | `Ref<string \| null>`  | Last received SSE `id` field, used for resumption     |
| `reconnectAttempt`| `Ref<number>`         | Number of consecutive reconnect attempts since last success |

### Methods
| Method      | Signature                              | Description                                                            |
|-------------|----------------------------------------|------------------------------------------------------------------------|
| `connect`   | `() => Promise<void>`                  | Opens the SSE stream. Sends `Last-Event-ID` header when resuming.      |
| `disconnect`| `() => void`                           | Aborts the active fetch, clears reconnect timers, sets status to `idle`|

### Behavior
- Uses `fetch` with `ReadableStream` reader instead of `EventSource` to gain control over headers (`Last-Event-ID`) and error handling.
- Manually parses SSE chunks line-by-line (`id:`, `event:`, `data:`) and handles partial messages across chunk boundaries.
- Every parsed message is validated against `BoardStreamSseEventSchema` (Zod). Invalid messages are logged and dropped.
- **Event application:**
  - `CARD_CREATED` → `boardStore.addCard(event.data.card)`
  - `CARD_UPDATED` → `boardStore.updateCard(event.data.card)`
  - `CARD_MOVED` → `boardStore.updateCard(event.data.card)` (the store detects the column change)
  - `BOARD_RELOAD` → calls `opts.onReload()` (typically fetches a fresh snapshot)
- **Version gating:** `updateCard` in the store ignores events where `incoming.version < existing.version`, preventing stale events from overwriting newer local state.
- **Reconnect logic:** On unexpected disconnect, schedules exponential backoff (base 1s, cap 30s). `reconnectAttempt` resets to 0 on successful connection.
- **Cleanup:** `onUnmounted` calls `disconnect()` automatically.

### Constants
| Name                  | Value   | Description                              |
|-----------------------|---------|------------------------------------------|
| `RECONNECT_BASE_MS`   | `1000`  | Initial reconnect delay                  |
| `RECONNECT_MAX_MS`    | `30000` | Maximum reconnect delay                  |

### Dependencies
- `@repo/shared` — `BoardStreamSseEventSchema`, `BoardStreamSseEvent`
- `~/composables/useBoardStore` — `addCard`, `updateCard`

---

## `components/kanban/BoardView.vue`

Root layout component that renders the full board with all columns horizontally.

### Props
| Prop       | Type   | Required | Description                |
|------------|--------|----------|----------------------------|
| `boardUid` | string | yes      | Board UUID (for API calls) |

### Behavior
- Renders `UPageHeader` with board title and prefix; shows a **real-time status badge** and a "Saving..." badge during mutations.
- Renders `UAlert` for transient errors.
- Iterates over `sortedColumns` from `useBoardStore()` and renders a `BoardColumn` for each.
- Handles drag-and-drop move orchestration:
  1. Calls `moveCardLocal(cardId, toColumnUid)` optimistically.
  2. POSTs to `/api/boards/{boardUid}/cards/{cardId}/move`.
  3. On success, calls `updateCard(response.data.card)` to reconcile.
  4. On failure, calls `moveCardLocal(cardId, originalStatus)` to revert and sets `ui.error`.
- Hosts `CreateCardModal`, `EditCardModal`, and `AuditLogPanel`.
- After card creation or edit, calls `refreshSnapshot()` to reload the full board state.
- **Blocked-move toast:** If the server rejects a move with `MOVE_BLOCKED`, a toast is shown via `useToast()` (color `error`, icon `i-lucide-ban`) and the optimistic local move is reverted so the card snaps back.
- **Real-time SSE sync:** On mount, opens `useBoardRealtime(boardUid)`. Incoming SSE events mutate the store directly; cards glide between columns without full page refresh.
- **Real-time status badge:**
  - `connected` → green "Live" `UBadge` with `animate-pulse`.
  - `connecting` → yellow "Connecting..." badge.
  - `disconnected` → red "Offline" badge.
- **BOARD_RELOAD recovery:** When the SSE stream emits `BOARD_RELOAD` (buffer miss, cursor expired, or server reset), `refreshSnapshot()` is called to re-hydrate the entire board from the server.
- **Auto-polling:** Watches `hasProcessingCards`. When true, starts polling the snapshot endpoint every 2 seconds so the UI reflects processor callback results (unlock/move) without manual refresh. Stops polling when no cards are processing. Cleans up on unmount. Polling complements SSE as a fallback.

### Events (internal)
| Handler          | Triggered by     | Action                                      |
|------------------|------------------|---------------------------------------------|
| `onCreateCard`   | BoardColumn      | Opens `CreateCardModal` for the column      |
| `onEditCard`     | KanbanCard       | Opens `EditCardModal` with the card         |
| `onDropCard`     | BoardColumn      | Orchestrates optimistic move + API + revert; shows toast on `MOVE_BLOCKED` |

### API Calls
| Method | Endpoint                                       | Purpose            |
|--------|------------------------------------------------|--------------------|
| POST   | `/api/boards/{boardUid}/cards/{cardId}/move`   | Persist card move  |
| GET    | `/api/boards/{boardUid}/snapshot`              | Refresh full state |

### Dependencies
- `@repo/shared` — `SnapshotResponse`, `MoveCardRequest`, `MoveCardResponse`, `CardEntity`
- `@nuxt/ui` — `UPageHeader`, `UPageBody`, `UAlert`, `UBadge`
- `~/composables/useBoardRealtime` — SSE connection management

---

## `components/kanban/BoardColumn.vue`

Renders a single column and the cards within it.

### Props
| Prop       | Type                              | Required | Description                  |
|------------|-----------------------------------|----------|------------------------------|
| `column`   | `BoardEntity['schema']['columns'][number]` | yes | Column schema object         |
| `cards`    | `CardEntity[]`                    | yes      | Cards currently in this column|
| `boardUid` | string                            | yes      | Board UUID                   |

### Events
| Event      | Payload                               | Description                          |
|------------|---------------------------------------|--------------------------------------|
| `create`   | `columnUid: string`                   | User clicked the "+" add button      |
| `edit`     | `card: CardEntity`                    | User clicked a card's edit button    |
| `drop-card`| `{ cardId: string; toColumnUid: string }` | A card was dropped into this column  |

### Behavior
- Fixed width (`280px`) with `shrink-0` for horizontal scroll layout.
- Column header shows the column title and a small "+" ghost button to create cards.
- **Processing badge:** When `column.type === 'Processing'`, an `info` `UBadge` labeled "Processing" is rendered next to the title.
- Drop zone background: `bg-gray-50 dark:bg-gray-800/50`.
- Renders a `KanbanCard` for each card in the `cards` prop.
- Shows "Drop cards here" placeholder when empty.
- Implements `dragover` and `drop` handlers for HTML5 drag-and-drop.
- Uses `<TransitionGroup name="card-move">` for smooth card movement animations between columns.

### Dependencies
- `@repo/shared` — `BoardEntity`, `CardEntity`
- `@nuxt/ui` — `UButton`, `UBadge`

---

## `components/kanban/KanbanCard.vue`

Displays a single card with title, description, badges, drag support, and processing-state overlays.

### Props
| Prop  | Type        | Required | Description      |
|-------|-------------|----------|------------------|
| `card`| `CardEntity`| yes      | Card data object |

### Events
| Event  | Payload        | Description                     |
|--------|----------------|---------------------------------|
| `edit` | `card: CardEntity` | User clicked the pencil button  |

### Behavior
- **Lock state:** `isLocked` is true when `processing_state` is `PROCESSING` or `ERROR`.
- **Drag:** The card is draggable only when not locked. On `dragstart`, stores the card's `uid` in `dataTransfer` with effect `move`. Locked cards prevent drag via `event.preventDefault()`.
- **Edit:** The pencil icon button is hidden when `!card.is_editable || isLocked`. Emits `edit` event.
- **Processing spinner overlay:** When `processing_state === 'PROCESSING'`, a full-card absolute overlay renders with a spinning `i-lucide-loader-2` icon and a semi-transparent blurred backdrop (`bg-white/60 dark:bg-gray-900/60 backdrop-blur-[1px]`).
- **State badge:** `processing_state` badge is shown only when not `IDLE` (`ERROR` = error color, `PROCESSING` = info color).
- Title is truncated with `truncate`.
- Description is clamped to 2 lines (`line-clamp-2`) when present.
- Displays `display_id` as a subtle badge.

### Styling
- `UCard` with custom `ui` prop.
- Normal state: `cursor-grab active:cursor-grabbing`.
- Locked state: `cursor-not-allowed opacity-80`.

### Dependencies
- `@repo/shared` — `CardEntity`
- `@nuxt/ui` — `UCard`, `UButton`, `UBadge`, `UIcon`

---

## `components/kanban/AuditLogPanel.vue`

Slide-over drawer that displays the immutable audit log for the current board.

### Props
| Prop       | Type    | Required | Description                |
|------------|---------|----------|----------------------------|
| `boardId`  | string  | yes      | Board UUID to query        |

### v-model
| Name   | Type      | Default | Description                 |
|--------|-----------|---------|-----------------------------|
| `open` | `boolean` | `false` | Controls slide-over visibility |

### State
| Name         | Type                        | Description                                      |
|--------------|-----------------------------|--------------------------------------------------|
| `events`     | `Ref<EventLogRow[]>`        | Loaded audit events, chronologically ordered     |
| `loading`    | `Ref<boolean>`              | True while fetching                              |
| `error`      | `Ref<string \| null>`       | Error message on fetch failure                   |
| `nextCursor` | `Ref<string \| null>`       | Pagination cursor for the next page              |
| `hasMore`    | `ComputedRef<boolean>`      | True when `nextCursor` is non-null               |

### Methods
| Method         | Signature                          | Description                                                   |
|----------------|------------------------------------|---------------------------------------------------------------|
| `loadAuditLog` | `(isLoadMore = false) => Promise<void>` | Fetches audit log. On first open loads page 1; on "Load more" appends the next page. |

### Behavior
- Uses `USlideover` from `@nuxt/ui` with `side="right"` and title "Audit Log".
- Lazy-loads: fetches only when `open` becomes `true` and `events` is empty.
- Validates server response via `AuditLogResponseSchema` (Zod).
- Each event renders as a `UCard`:
  - Header row: `UBadge` for the action (colored by category) + localized timestamp.
  - Body: human-readable sentence describing the actor, action, and column transition or card reference.
- **Categories:**
  - `user_action` → primary color badge
  - `lifecycle` → info color badge
  - otherwise → neutral color badge
- **Empty state:** `UIcon` (`i-lucide-clipboard-list`) + "No audit events yet".
- **Loading state:** `USkeleton` placeholders shown during initial fetch.
- **Error state:** `UAlert` (color `error`) displays the failure message.
- **Pagination:** "Load more" `UButton` fetches the next cursor page and appends to `events`.

### API Calls
| Method | Endpoint                                           | Purpose          |
|--------|----------------------------------------------------|------------------|
| GET    | `/api/boards/{boardId}/audit-log?limit=50&cursor=` | Fetch audit events |

### Dependencies
- `@repo/shared` — `AuditLogResponseSchema`, `EventLogRow`
- `@nuxt/ui` — `USlideover`, `UAlert`, `USkeleton`, `UCard`, `UBadge`, `UButton`, `UIcon`

---

## `components/kanban/CreateCardModal.vue`

Modal form for creating a new card within a specific column.

### Props
| Prop        | Type    | Required | Description                        |
|-------------|---------|----------|------------------------------------|
| `open`      | boolean | yes      | Controls modal visibility (v-model)|
| `columnUid` | string  | yes      | Target column for the new card     |
| `boardUid`  | string  | yes      | Board UUID for the API call        |

### Events
| Event          | Payload   | Description                    |
|----------------|-----------|--------------------------------|
| `update:open`  | `boolean` | v-model for modal visibility   |
| `created`      | —         | Card was successfully created  |

### Behavior
- Uses `UModal` with title "Create Card".
- Form fields: Title (required, 1–200 chars), Description (optional, max 5000 chars).
- Client-side validation via Zod schema (`z.string().min(1).max(200)` for title).
- On submit, POSTs to `/api/boards/{boardUid}/cards` with `title`, `description`, and `current_status = columnUid`.
- Resets form and closes modal on success; emits `created`.
- Shows error alert inline on failure.

### API Calls
| Method | Endpoint                              | Purpose       |
|--------|---------------------------------------|---------------|
| POST   | `/api/boards/{boardUid}/cards`        | Create card   |

### Dependencies
- `@repo/shared` — `CreateCardRequest`, `CreateCardResponse`
- `@nuxt/ui` — `UModal`, `UForm`, `UFormField`, `UInput`, `UTextarea`, `UAlert`, `UButton`

---

## `components/kanban/EditCardModal.vue`

Modal form for editing an existing card's title and description.

### Props
| Prop       | Type             | Required | Description                        |
|------------|------------------|----------|------------------------------------|
| `open`     | boolean          | yes      | Controls modal visibility (v-model)|
| `card`     | `CardEntity \| null` | yes   | Card to edit (null when closed)    |
| `boardUid` | string           | yes      | Board UUID for the API call        |

### Events
| Event          | Payload   | Description                   |
|----------------|-----------|-------------------------------|
| `update:open`  | `boolean` | v-model for modal visibility  |
| `updated`      | —         | Card was successfully updated |

### Behavior
- Uses `UModal` with title "Edit Card" and description showing the card's `display_id`.
- Form fields pre-populated from `card` prop via `watch` with `{ immediate: true }`.
- Client-side validation via Zod (same rules as CreateCardModal).
- On submit, PATCHes to `/api/boards/{boardUid}/cards/{card.uid}` with `title`, `description`, and `version` (optimistic locking).
- Emits `updated` and closes on success.
- Shows error alert inline on generic failures.
- **Conflict banner:** On `409 CONFLICT`, displays a red `UAlert` with title "Someone else edited this — refresh and retry" and a **Refresh** button. Clicking Refresh pushes the server card into the store and clears the banner.
- **Lock guard:** Computes `isLocked` when `processing_state` is `PROCESSING` or `ERROR`. Shows a warning `UAlert` (icon `i-lucide-lock`, color `warning`) with title "Card is locked" and description explaining the card cannot be edited. The **Save** button is disabled when locked.

### API Calls
| Method | Endpoint                                       | Purpose       |
|--------|------------------------------------------------|---------------|
| PATCH  | `/api/boards/{boardUid}/cards/{cardId}`        | Update card   |

### State (local)
| Name                  | Type                  | Description                                      |
|-----------------------|-----------------------|--------------------------------------------------|
| `isSaving`            | `Ref<boolean>`        | Loading state during PATCH                       |
| `errorMsg`            | `Ref<string>`         | Generic error message text                       |
| `conflictServerCard`  | `Ref<CardEntity \| null>` | Authoritative card returned in a 409 conflict |
| `isLocked`            | `ComputedRef<boolean>`| True when card is PROCESSING or ERROR            |

### Dependencies
- `@repo/shared` — `UpdateCardRequest`, `UpdateCardResponse`, `CardEntity`
- `@nuxt/ui` — `UModal`, `UForm`, `UFormField`, `UInput`, `UTextarea`, `UAlert`, `UButton`
