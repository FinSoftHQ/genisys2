# Kanban Components — Slice 1

> **Scope:** Slice 1 MVP — Board page, columns, cards, modals, drag-and-drop, and store.
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
  };
}
```

### Computed
| Name            | Type                | Description                              |
|-----------------|---------------------|------------------------------------------|
| `sortedColumns` | `BoardColumn[]`     | Board columns sorted by `order` ascending|

### Methods
| Method                | Signature                                                          | Description                                                            |
|-----------------------|--------------------------------------------------------------------|------------------------------------------------------------------------|
| `resetStore`          | `() => void`                                                       | Clears all state back to initial values                                |
| `setLoading`          | `(value: boolean) => void`                                         | Toggles `ui.isLoading`                                                 |
| `setSaving`           | `(value: boolean) => void`                                         | Toggles `ui.isSaving`                                                  |
| `setError`            | `(error: string \| null) => void`                                  | Sets `ui.error`                                                        |
| `hydrate`             | `(snapshot: { board, cards }) => void`                             | Populates store from a snapshot response; builds `cardsById` and `columnCardIds` |
| `addCard`             | `(card: CardEntity) => void`                                       | Inserts a new card into `cardsById` and appends to `columnCardIds`     |
| `updateCard`          | `(card: CardEntity) => void`                                       | Updates `cardsById`; if `current_status` changed, moves between columns |
| `moveCardLocal`       | `(cardId: string, toColumnUid: string) => void`                    | Optimistically moves a card to another column without API call         |
| `setDraggedCardId`    | `(cardId: string \| null) => void`                                | Tracks the currently dragged card                                      |
| `getCardsForColumn`   | `(columnUid: string) => CardEntity[]`                              | Returns card entities for a given column uid                           |

### Notes
- The store is a single `ref<BoardStore>` exported as a module-level singleton.
- `hydrate` is the primary entry point; it reconstructs derived maps from the server snapshot.
- `moveCardLocal` does not update `version` or `updated_at`; it is meant for optimistic UI only.

---

## `components/kanban/BoardView.vue`

Root layout component that renders the full board with all columns horizontally.

### Props
| Prop       | Type   | Required | Description                |
|------------|--------|----------|----------------------------|
| `boardUid` | string | yes      | Board UUID (for API calls) |

### Behavior
- Renders `UPageHeader` with board title and prefix; shows a "Saving..." badge during mutations.
- Renders `UAlert` for transient errors.
- Iterates over `sortedColumns` from `useBoardStore()` and renders a `BoardColumn` for each.
- Handles drag-and-drop move orchestration:
  1. Calls `moveCardLocal(cardId, toColumnUid)` optimistically.
  2. POSTs to `/api/boards/{boardUid}/cards/{cardId}/move`.
  3. On success, calls `updateCard(response.data.card)` to reconcile.
  4. On failure, calls `moveCardLocal(cardId, originalStatus)` to revert and sets `ui.error`.
- Hosts `CreateCardModal` and `EditCardModal`.
- After card creation or edit, calls `refreshSnapshot()` to reload the full board state.

### Events (internal)
| Handler          | Triggered by     | Action                                      |
|------------------|------------------|---------------------------------------------|
| `onCreateCard`   | BoardColumn      | Opens `CreateCardModal` for the column      |
| `onEditCard`     | KanbanCard       | Opens `EditCardModal` with the card         |
| `onDropCard`     | BoardColumn      | Orchestrates optimistic move + API + revert |

### API Calls
| Method | Endpoint                                       | Purpose            |
|--------|------------------------------------------------|--------------------|
| POST   | `/api/boards/{boardUid}/cards/{cardId}/move`   | Persist card move  |
| GET    | `/api/boards/{boardUid}/snapshot`              | Refresh full state |

### Dependencies
- `@repo/shared` — `SnapshotResponse`, `MoveCardRequest`, `MoveCardResponse`, `CardEntity`
- `@nuxt/ui` — `UPageHeader`, `UPageBody`, `UAlert`, `UBadge`

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
- Drop zone background: `bg-gray-50 dark:bg-gray-800/50`.
- Renders a `KanbanCard` for each card in the `cards` prop.
- Shows "Drop cards here" placeholder when empty.
- Implements `dragover` and `drop` handlers for HTML5 drag-and-drop.

### Dependencies
- `@repo/shared` — `BoardEntity`, `CardEntity`
- `@nuxt/ui` — `UButton`

---

## `components/kanban/KanbanCard.vue`

Displays a single card with title, description, badges, and drag support.

### Props
| Prop  | Type        | Required | Description      |
|-------|-------------|----------|------------------|
| `card`| `CardEntity`| yes      | Card data object |

### Events
| Event  | Payload        | Description                     |
|--------|----------------|---------------------------------|
| `edit` | `card: CardEntity` | User clicked the pencil button  |

### Behavior
- Entire card is draggable (`draggable="true"`).
- On `dragstart`, stores the card's `uid` in `dataTransfer` with effect `move`.
- Title is truncated with `truncate`.
- Description is clamped to 2 lines (`line-clamp-2`) when present.
- Displays `display_id` as a subtle badge.
- Displays `processing_state` badge only when not `IDLE` (`ERROR` = red, `PROCESSING` = info).
- Pencil icon button emits `edit` event.

### Styling
- `UCard` with custom `ui` prop for grab cursor and padding.
- `cursor-grab active:cursor-grabbing`

### Dependencies
- `@repo/shared` — `CardEntity`
- `@nuxt/ui` — `UCard`, `UButton`, `UBadge`

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
- On submit, PATCHes to `/api/boards/{boardUid}/cards/{card.uid}` with `title` and `description`.
- Emits `updated` and closes on success.
- Shows error alert inline on failure.

### API Calls
| Method | Endpoint                                       | Purpose       |
|--------|------------------------------------------------|---------------|
| PATCH  | `/api/boards/{boardUid}/cards/{cardId}`        | Update card   |

### Dependencies
- `@repo/shared` — `UpdateCardRequest`, `UpdateCardResponse`, `CardEntity`
- `@nuxt/ui` — `UModal`, `UForm`, `UFormField`, `UInput`, `UTextarea`, `UAlert`, `UButton`
