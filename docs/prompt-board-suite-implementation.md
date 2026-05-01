# Prompt: Implement Board Suite with Cross-Board Card Delegation

## Context

We have a Kanban system (`src/apps/api/src/kanban/`) with boards, cards, processors, and a family-tree system for parent-child card relationships. Currently:

- Cards and their parent-child relationships are constrained to the **same board**
- The **development board** template has columns: `backlog` → `todo` → `prep` → `agentic-team` → `wrap` → `done`
- The **agentic-team processor** creates an AI agent room for each card and waits for completion
- We want to decompose work so a parent card on a dev board can spawn child cards on a separate task board, each getting their own focused agent room

## Goal

Implement **Board Suite** — a first-class concept where related boards are created and managed together as a unit. A suite contains multiple boards with assigned **roles** (e.g., `primary`, `tasks`). Cards in one board can have parent-child relationships with cards in another board within the same suite.

## Phase 1: Simplified Implementation (NO AI planning yet)

For this first iteration, the "planning" step is intentionally simple: **clone the parent card 1:1 into the task board**. We are NOT building an AI planner that breaks cards into sub-tasks yet. We are ONLY building the infrastructure for cross-board suites and delegation.

---

## Specific Requirements

### 1. Database Schema Changes (`src/db/schema.ts`)

Add a `board_suites` table and extend existing tables:

```typescript
// NEW table
export const boardSuites = sqliteTable('board_suites', {
  uid: text('uid').primaryKey(),
  title: text('title').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

// EXTEND existing boards table — add suite_uid and role
// suite_uid: nullable (standalone boards don't belong to a suite)
// role: nullable free-form string, conventions: 'primary', 'tasks', 'review', etc.

// EXTEND existing cardRelationships table — add board refs
// parent_board_uid: nullable (null = same-board backward compat)
// child_board_uid: nullable (null = same-board backward compat)
```

Add appropriate indexes:
- `boards_suite_idx` on `(suite_uid)`
- `card_relationships_parent_board_idx` on `(parent_board_uid, parent_card_uid)`
- `card_relationships_child_board_idx` on `(child_board_uid, child_card_uid)`

### 2. Suite Templates and Creation (`src/kanban/repository.ts`)

Add suite templates alongside existing `BOARD_TEMPLATES`:

```typescript
const SUITE_TEMPLATES = {
  default: {
    title: 'New Suite',
    boards: [{ role: 'primary', template: 'default' }],
  },
  development: {
    title: 'Development Suite',
    boards: [
      { role: 'primary', template: 'development', title: 'Development Board' },
      { role: 'tasks', template: 'task', title: 'Task Board' },
    ],
  },
};

const BOARD_TEMPLATES = {
  // ...existing templates...
  task: {
    title: 'Task Board',
    columns: [
      { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'todo' }, order: 0 },
      { uid: 'todo', title: 'TODO', type: 'Normal', processor_id: 'todo', exit_logic: { default: 'agentic-team' }, order: 1 },
      { uid: 'agentic-team', title: 'AI Team', type: 'Processing', processor_id: 'agentic-team', exit_logic: { default: 'done' }, order: 2 },
      { uid: 'done', title: 'Done', type: 'Processing', processor_id: 'done', exit_logic: { default: 'done' }, order: 3 },
    ],
  },
};
```

Implement `createSuite(instance, template, title?)` that:
1. Creates a suite record
2. Creates each board in the suite, assigning `suite_uid` and `role`
3. Returns `{ suite, boards }`

Update `createBoard` to optionally accept `suite_uid` and `role`.

### 3. Cross-Board Family Tree (`src/kanban/family-tree.ts`)

Update `createCardRelationship` to accept cross-board relationships:
- Accept `parentBoardUid` and `childBoardUid` as optional parameters
- Remove the hard same-board check (still validate both cards exist, but allow different boards)
- Store `parent_board_uid` and `child_board_uid` in the relationship row

Update `getCardFamily` and all lookup helpers to use the stored board UIDs when resolving related cards. When `parent_board_uid`/`child_board_uid` is null, fall back to the same board (backward compatibility).

### 4. Board Column Update (`src/kanban/repository.ts` — development template)

Update the development board template to support the new flow:

```
backlog → todo → prep → planning → delegated → wrap → done
```

- `planning`: Processing column, processor_id: `planning`
- `delegated`: Normal column, processor_id: `default-manual`
- `agentic-team`: Remove from dev board (work now happens on the task board)

### 5. Planning Processor (`src/kanban/processor-planning.ts` — NEW FILE)

Implement a new processor at route prefix `/api/kanban-processor/planning`.

**`on-enter` behavior:**
1. Accept the card from the hook payload
2. Find the card's board. If the board belongs to a suite, find the suite's board with `role === 'tasks'`.
3. If no task board exists (board is standalone), fall back to old behavior: callback with `move_to_column: 'agentic-team'` (or error — your choice, but must not break standalone dev boards).
4. **Clone the card to the task board's `todo` column**:
   - Copy `title`, `description`
   - Copy `payload` but add `parent_board_uid` and `parent_card_uid` pointing back to the original card
   - Copy `workspace_path` from parent payload if it exists (tasks share the same workspace)
5. Create a cross-board card relationship: parent = original card (dev board), child = new cloned card (task board), relationship_type = `dependency`
6. Callback with `status: 'success', move_to_column: 'delegated', payload_updates: { delegated: true, task_card_uid: <new_card_uid>, task_board_uid: <task_board_uid> }`

**`can-exit`**: Always allow exit from `planning`.

**`on-exit`**: No-op.

**`on-update` / `on-action`**: Standard passthrough.

### 6. Done Processor Enhancement (`src/kanban/processor-done.ts` — NEW or extend existing)

The task board's `done` column needs a processor that knows how to wake up parent cards.

Implement a processor at route prefix `/api/kanban-processor/done` (or extend the existing done logic).

**When a task card enters `done`:**
1. Check if the card's payload has `parent_board_uid` and `parent_card_uid`
2. If yes, look up the parent card on the dev board
3. Find ALL sibling cards that are children of this parent (via `getCardFamily` on the parent, looking at `children`)
4. Check if ALL children are in a completed state (processing_state === 'IDLE' and current_status === 'done')
5. If all children are done, move the parent card from `delegated` to `wrap`:
   - Use `moveCard(parent_board_uid, parent_card_uid, 'wrap', 'system:task-complete')`
   - Then trigger `startProcessing` on the `wrap` column since it's a Processing column

**If the card has NO parent reference**, treat it as a normal done card (noop or existing behavior).

### 7. API Routes (`src/kanban/routes.ts`)

Add suite endpoints:
- `POST /api/board-suites` — create a suite from a template
- `GET /api/board-suites` — list suites
- `GET /api/board-suites/:suiteId` — get suite with its boards
- `GET /api/board-suites/:suiteId/snapshot` — get suite with all boards and cards

Update board creation:
- `POST /api/boards` should still work standalone
- Optionally support creating via suite: `POST /api/boards?suite=<suite_uid>&role=tasks`

### 8. Update Agentic-Team Processor (`src/kanban/processor-agentic-team.ts`)

The agentic-team processor should continue to work unchanged for task board cards. No modifications needed — task board cards entering `agentic-team` will create agent rooms exactly like before.

However, the `_internal/room-closed` handler currently hardcodes moving to `'wrap'`. Since task boards don't have a `wrap` column, update the handler to:
- Read the current column's `exit_logic.default` to determine the next column
- For task boards (`exit_logic.default === 'done'`), move to `done`
- For dev boards (`exit_logic.default === 'wrap'`), keep existing behavior

### 9. Backward Compatibility

- Standalone boards without `suite_uid` must continue to work exactly as before
- Same-board relationships without `parent_board_uid`/`child_board_uid` must continue to work
- The `development` board template change (adding `planning`/`delegated`) is a template change — existing boards in the DB keep their old schema, only new boards get the new columns
- The agentic-team processor should detect whether it's processing a standalone card or a suite-delegated card and behave accordingly

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/db/schema.ts` | Add `boardSuites` table, extend `boards` and `cardRelationships` |
| `src/kanban/repository.ts` | Add suite templates, `createSuite`, update `createBoard`, update `BOARD_TEMPLATES` with `task` and updated `development` |
| `src/kanban/family-tree.ts` | Cross-board relationship support |
| `src/kanban/processor-planning.ts` | **NEW** — planning processor |
| `src/kanban/processor-done.ts` | **NEW** or extend existing — done processor for task board parent wake-up |
| `src/kanban/processor-agentic-team.ts` | Modify `_internal/room-closed` to use column `exit_logic` instead of hardcoded `wrap` |
| `src/kanban/processor-routes.ts` | Register new processors |
| `src/kanban/routes.ts` | Add suite REST endpoints |
| `src/kanban/processing-orchestrator.ts` | May need updates for cross-board `moveCard` in done processor |

---

## Definition of Done

1. `POST /api/board-suites` with template `development` creates a suite with 2 boards: a dev board (role: primary) and a task board (role: tasks)
2. Creating a card on the dev board and moving it through `prep` → `planning` creates a cloned card on the task board's `todo` column with a cross-board parent-child relationship
3. The parent card moves to `delegated` and waits
4. Moving the task board card through `todo` → `agentic-team` creates an agent room that works on the task
5. When the agent room closes, the task card moves to `done`
6. When the task card hits `done`, the parent card on the dev board auto-moves to `wrap`
7. Standalone boards without suites still work as before
8. All existing tests pass, new tests added for suite creation and cross-board relationships
