# Prompt: Web UI Updates for Board Suite

## Context

The web app (`src/apps/web/`) is a **Nuxt 4** + Vue 3 + `@nuxt/ui` v4 application. It currently supports creating standalone boards, viewing a single board as a Kanban, and real-time SSE updates.

The backend is being extended with **Board Suite** support:
- A suite is a group of related boards (e.g., `primary` dev board + `tasks` task board)
- Cards can have cross-board parent-child relationships
- A dev board card in `planning` gets cloned to the suite's task board
- The parent card sits in `delegated`; task cards move through `agentic-team` and `done`
- When all task children are `done`, the parent auto-moves to `wrap`

**Backend API changes (assumed ready):**
- `POST /api/board-suites` — create a suite from a template
- `GET /api/board-suites` — list suites
- `GET /api/board-suites/:suiteId` — get suite with its boards
- `GET /api/board-suites/:suiteId/snapshot` — get all boards + cards in the suite
- `GET /api/boards/:boardId/cards/:cardId/family` — returns `{ card, parents, children }`
- Boards now have optional `suite_uid` and `role` fields
- Cards now have `parents` and `children` arrays (family metadata) in their payload

## Goal

Update the web UI to support Board Suite creation, navigation, and visualization. The user should be able to:

1. Create a suite (e.g., "Development Suite") instead of just a single board
2. See suites and their member boards on the home page
3. Navigate between boards within the same suite seamlessly
4. See cross-board parent/child relationships on cards
5. See a card's delegation status ("Delegated to Task Board", "Parent: DEV-12")

## Current UI Structure (for reference)

| File | Purpose |
|------|---------|
| `app/pages/index.vue` | Home page: open board, create board, list boards |
| `app/pages/boards/[boardId].vue` | Single board view with title, breadcrumb, BoardView |
| `app/components/kanban/BoardView.vue` | Kanban columns, drag-and-drop, modals |
| `app/components/kanban/KanbanCard.vue` | Card rendering: title, description, display_id, processing_state |
| `app/components/kanban/BoardColumn.vue` | Column header + card list + create button |
| `app/components/kanban/CreateCardModal.vue` | Create new card modal |
| `app/components/kanban/EditCardModal.vue` | Edit card modal |
| `app/composables/useBoardsList.ts` | Fetch `GET /api/boards` |
| `app/composables/useBoardStore.ts` | Board/column/card state, hydrate from snapshot |

## Specific Requirements

### 1. Home Page (`app/pages/index.vue`)

#### 1a. Create Suite section

Add a new card **below** the existing "Create Board" card called **"Create Suite"**.

- Template: same template buttons (`default`, `development`) but the copy should say "Default Suite" / "Development Suite"
- Title input (same as board)
- On submit: `POST /api/board-suites` with `{ template, title }`
- On success: navigate to the **primary** board of the suite (`/boards/${suite.boards.find(b => b.role === 'primary').uid}`)
- Loading state, error handling same pattern as create board

#### 1b. Boards list → group by suite

The existing "Boards" list should group boards by suite:

```
Suites
  Development Suite
    [Development Board]  [Task Board]
  Another Suite
    [Primary Board]

Standalone Boards
  [My Standalone Board]
  [Another Board]
```

- Use `GET /api/board-suites` to fetch suites and their boards
- Use `GET /api/boards` to fetch standalone boards (filter out boards where `suite_uid != null`)
- Each board card shows: title, prefix, role badge (e.g., "Primary", "Tasks")
- Clicking a board navigates to `/boards/${board.uid}`
- Keep the existing grid layout but group under section headers

### 2. Board Page (`app/pages/boards/[boardId].vue`)

#### 2a. Show suite context in header

When viewing a board that belongs to a suite, show a **suite navigation bar** below the navbar:

```
[Dev Board]  [Task Board]     ← tabs / buttons
     ↑ current board highlighted
```

- If `store.board.suite_uid` exists, fetch the suite (`GET /api/board-suites/${suite_uid}`) or include suite data in the snapshot response
- Show all boards in the suite as clickable tabs/pills
- Current board is highlighted (solid), others are subtle
- Clicking another suite board navigates to it
- If the board is standalone, don't show the suite bar

#### 2b. Board role badge

Show the board's `role` next to the title or in the header:
- `UBadge` with label like "Primary" or "Tasks"
- Color: `primary` for primary, `info` for tasks, `neutral` for others

### 3. Card Component (`app/components/kanban/KanbanCard.vue`)

#### 3a. Show parent/child badges

A card may have `parents` or `children` arrays (from the family enrichment). Display small badges:

```
[DEV-12]  [PROCESSING]
[↑ Parent: DEV-12]      ← if this card has parents
[↓ 3 subtasks]          ← if this card has children
```

- If `card.parents.length > 0`: show a small muted badge "Parent: {display_id}" with a link icon
- If `card.children.length > 0`: show a small muted badge "{n} subtask(s)" with a list icon
- These badges appear below the display_id/processing_state badges
- Badges are **not clickable in v1** (just visual). If easy, clicking the parent badge could navigate to the parent board/card, but this is optional.

#### 3b. Delegated state styling

If a card is in the `delegated` column, give it a subtle visual indicator:
- A small icon (e.g., `i-lucide-git-branch`) in the top-right
- Or a muted border color change

#### 3c. Task card styling

If a card has `parent_board_uid` / `parent_card_uid` in its payload (indicating it's a cloned task card), show a small "Task" badge or icon to distinguish it from standalone cards.

### 4. Edit Card Modal (`app/components/kanban/EditCardModal.vue`)

#### 4a. Family tree section

Add a section in the edit modal showing:
- **Parents**: list of parent cards with display_id, title, status
- **Children**: list of child cards with display_id, title, status

Each entry shows:
- `display_id` (monospace)
- `title` (truncated)
- Small status badge (color based on `current_status`)

If a parent/child is on a **different board**, show a small external-link icon and include the board prefix.

### 5. Composables Updates

#### 5a. `useBoardsList.ts`

- Also fetch suites: `GET /api/board-suites`
- Return both `boards` and `suites` arrays
- Or create a new `useSuitesList.ts` composable

#### 5b. `useBoardStore.ts`

- `hydrate()` should already handle the enriched cards with `parents`/`children` since the snapshot returns `CardEntity` which now includes those fields
- No changes needed unless the snapshot shape changes significantly

### 6. Optional: Suite Overview Page (`app/pages/suites/[suiteId].vue`)

If time permits, add a suite overview page:
- URL: `/suites/:suiteId`
- Shows all boards in the suite as mini-kanban previews side-by-side
- Or tabs to switch between boards
- Uses `GET /api/board-suites/:suiteId/snapshot`

This is **nice to have but not required for v1**.

## Design Notes

- Use existing `@nuxt/ui` components: `UCard`, `UBadge`, `UButton`, `UInput`, `UForm`, `UFormField`, `UTabs` (for suite nav), `UIcon`
- Follow existing patterns for async data fetching, error handling (`parseApiError`), loading states, and toast notifications
- Keep the existing drag-and-drop behavior unchanged
- The SSE stream (`/api/boards/:boardId/stream`) should still work per-board; no need for cross-board streaming in v1
- Card colors/styling: keep existing white/dark card background. Use badges and small icons for new metadata — don't overcrowd the card.

## Definition of Done

1. Home page shows "Create Suite" form and groups boards by suite
2. Board page shows suite navigation tabs when viewing a suite board
3. Cards show parent/child badges when they have family relationships
4. Cards in `delegated` column show a subtle delegation indicator
5. Edit card modal shows a family tree section with parents and children
6. Standalone boards without suites continue to work exactly as before
7. All existing tests pass; new component tests added for suite nav and card badges
