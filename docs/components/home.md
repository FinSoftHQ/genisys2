# Home Components — PFRV-1

> **Scope:** Kanban home page polish (Nuxt-only, no backend changes)
> **Status:** Implemented.

---

## `pages/index.vue`

Dashboard home page for the Kanban system. Replaces the previous UUID-only landing page with a three-section layout prioritizing suite creation and browsing.

### Page Sections (in DOM order)

| Section        | `aria-label`      | Priority | Description                                      |
|----------------|-------------------|----------|--------------------------------------------------|
| Quick Actions  | "Quick Actions"   | 1st      | Create Suite (primary) and Create Board forms    |
| Browse         | "Browse"          | 2nd      | Searchable grid of suites and standalone boards  |
| UUID Fallback  | "UUID Fallback"   | 3rd      | Collapsible manual UUID entry (de-emphasized)    |

### Quick Actions — Create Suite

- Form state: `createSuiteForm` (`title`, `template`).
- Title is trimmed before submit; blank/whitespace falls back to `"New Suite"`.
- Client-side validation:
  - Max length: 200 characters (`KANBAN_HOME_UI_CONSTRAINTS.suiteTitle.maxLength`).
  - Exceeding the limit shows a toast (`color: 'error'`, `icon: 'i-lucide-alert-circle'`) and blocks the API call.
- Templates: `default` | `development` (toggle button grid).
- On success, redirects to the suite's **primary** board (falls back to the first board in the suite if no primary exists).

### Quick Actions — Create Board

- Form state: `createForm` (`title`, `prefix`, `template`).
- Title is trimmed before submit; blank/whitespace falls back to `"New Board"`.
- Prefix is optional. If provided, must match `/^[A-Z][A-Z0-9]{0,9}$/`.
- Client-side validation:
  - Title max length: 200 characters.
  - Invalid prefix shows a toast and blocks the API call.
- On `PREFIX_EXISTS` server error, shows a "Prefix taken" toast.
- On success, redirects to `/boards/{newBoardUid}`.

### Browse

- **Loading state:** Spinning `i-lucide-loader-2` icon with `role="status"`.
- **Error state:** Centered error text with `role="alert"`.
- **Empty state:** "No boards yet. Create one above!"
- **Search:** `UInput` with `aria-label="Search"`. Query is normalized (`trim().toLowerCase()`).
- **Filtering logic:**
  - Suites match when the suite title contains the query, or any board within the suite matches by title or prefix.
  - Standalone boards match by title or prefix.
- **Rendering:**
  - Suites rendered first in a responsive grid (`1 col → 2 cols sm → 3 cols lg`) using `HomeSuiteQuickAccessCard`.
  - Standalone boards rendered second in an identical grid using `HomeBoardQuickAccessCard`.

### UUID Fallback

- Collapsed by default (`uuidFallbackOpen = false`).
- Toggled via a chevron button in the card header.
- When expanded, shows a simple form with a "Board ID" input and an "Open Board" submit button.
- On submit, routes to `/boards/{uuidBoardId}`.

### Dependencies

- `@repo/shared` — `CreateBoardRequest`, `CreateBoardResponse`, `CreateBoardSuiteRequest`, `BoardSuiteResponse`, `BoardEntity`, `BoardSuiteWithBoards`
- `@nuxt/ui` — `UDashboardPanel`, `UDashboardNavbar`, `UCard`, `UForm`, `UFormField`, `UInput`, `UButton`, `UIcon`
- `~/composables/useBoardsList` — `boards`, `isLoading`, `error`, `refreshBoards`
- `~/composables/useSuitesList` — `suites`, `isLoading`, `error`, `refreshSuites`
- `~/contracts/kanban-home.contract` — `KANBAN_HOME_UI_CONSTRAINTS`
- `~/components/home/HomeSuiteQuickAccessCard`
- `~/components/home/HomeBoardQuickAccessCard`

---

## `components/home/HomeSuiteQuickAccessCard.vue`

Clickable summary card for a board suite. Navigates to the suite's primary board on click.

### Props

| Prop    | Type                  | Required | Description                        |
|---------|-----------------------|----------|------------------------------------|
| `suite` | `BoardSuiteWithBoards`| yes      | Suite metadata and its board list  |

### Events

| Event      | Payload                  | Description                          |
|------------|--------------------------|--------------------------------------|
| `navigate` | `suite: BoardSuiteWithBoards` | Emitted before router navigation  |

### Behavior

- Renders as a `UCard` with `hover:bg-elevated` background transition and `cursor-pointer`.
- Left side: `i-lucide-layers` icon (color `primary`) + suite title (bold) + board count (muted text).
- Right side: `i-lucide-chevron-right` (muted).
- On click:
  1. Emits `navigate` event.
  2. Looks for a board with `role === 'primary'`.
  3. Falls back to the first board in the suite if no primary exists.
  4. Routes to `/boards/{targetBoardUid}`.

### Dependencies

- `@repo/shared` — `BoardSuiteWithBoards`
- `@nuxt/ui` — `UCard`, `UIcon`
- `vue-router` — `useRouter`

---

## `components/home/HomeBoardQuickAccessCard.vue`

Clickable summary card for a standalone board. Navigates directly to the board on click.

### Props

| Prop    | Type         | Required | Description                        |
|---------|--------------|----------|------------------------------------|
| `board` | `BoardEntity`| yes      | Standalone board entity            |

### Events

| Event      | Payload              | Description                          |
|------------|----------------------|--------------------------------------|
| `navigate` | `board: BoardEntity` | Emitted before router navigation     |

### Behavior

- Renders as a `UCard` with `hover:bg-elevated` background transition and `cursor-pointer`.
- Left side: `i-lucide-layout-kanban` icon (color `primary`) + board title (bold) + prefix and column count (muted text).
- Right side: `i-lucide-chevron-right` (muted).
- On click:
  1. Emits `navigate` event.
  2. Routes to `/boards/{board.uid}`.

### Dependencies

- `@repo/shared` — `BoardEntity`
- `@nuxt/ui` — `UCard`, `UIcon`
- `vue-router` — `useRouter`

---

## `contracts/kanban-home.contract.ts`

Central contract for home page UI constraints, types, and state shape.

### Constants

#### `KANBAN_HOME_SECTION_ORDER`

Readonly array defining the visual priority of home page sections:
```ts
['quick-actions', 'browse', 'uuid-fallback'] as const
```

#### `KANBAN_HOME_UI_CONSTRAINTS`

| Key           | Field        | Value | Description                                      |
|---------------|--------------|-------|--------------------------------------------------|
| `boardTitle`  | `maxLength`  | `200` | Hard ceiling for board title input and validation|
| `boardTitle`  | `fallback`   | `"New Board"` | Default title when input is blank/whitespace |
| `suiteTitle`  | `maxLength`  | `200` | Hard ceiling for suite title input and validation|
| `suiteTitle`  | `fallback`   | `"New Suite"` | Default title when input is blank/whitespace |
| `boardPrefix` | `pattern`    | `/^[A-Z][A-Z0-9]{0,9}$/` | Valid prefix regex |
| `boardPrefix` | `optional`   | `true`| Prefix is not required                           |
| `search`      | `normalize`  | `"trim-lowercase"` | Search query normalization strategy        |
| `uuidFallback`| `defaultOpen`| `false`| UUID section is collapsed by default            |
| `uuidFallback`| `placement`  | `"last-section"` | UUID section always rendered last             |

### Types

| Type                        | Description                                          |
|-----------------------------|------------------------------------------------------|
| `HomeSectionId`             | `'quick-actions' \| 'browse' \| 'uuid-fallback'`      |
| `HomeBoardTemplateOption`   | `'default' \| 'development'`                         |
| `HomeSuiteTemplateOption`   | `'default' \| 'development'`                         |
| `HomeCreateBoardFormState`  | `{ title, prefix, template }`                        |
| `HomeCreateSuiteFormState`  | `{ title, template }`                                |
| `HomeQuickActionsState`     | `{ suite, board, isCreatingSuite, isCreatingBoard }` |
| `HomeBrowseDataState`       | `{ suites, standaloneBoards, allBoards }`            |
| `HomeBrowseUiState`         | `{ searchQuery, isLoading, error }`                  |
| `HomeUuidFallbackState`     | `{ isOpen, boardIdInput }`                           |
| `KanbanHomePageState`       | Complete page state aggregating all sub-states       |
