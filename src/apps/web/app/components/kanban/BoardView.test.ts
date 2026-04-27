import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import type { BoardEntity, CardEntity } from '@repo/shared';
import BoardView from './BoardView.vue';
import { useBoardStore } from '~/composables/useBoardStore.js';

// ---- Stubs for Nuxt UI and child components ----
const UPageHeaderStub = defineComponent({
  name: 'UPageHeader',
  props: ['title', 'description'],
  setup(props, { slots }) {
    return () => h('div', { 'data-testid': 'u-page-header' }, [props.title, slots.right?.()]);
  },
});

const UAlertStub = defineComponent({
  name: 'UAlert',
  props: ['icon', 'color', 'variant', 'title'],
  setup(props) {
    return () => h('div', { 'data-testid': 'u-alert', 'data-color': props.color }, props.title);
  },
});

const UPageBodyStub = defineComponent({
  name: 'UPageBody',
  setup(props, { slots }) {
    return () => h('div', { 'data-testid': 'u-page-body' }, slots.default?.());
  },
});

const UBadgeStub = defineComponent({
  name: 'UBadge',
  props: ['color', 'variant', 'class'],
  setup(props, { slots }) {
    return () => h('span', { 'data-testid': 'u-badge' }, slots.default?.());
  },
});

const BoardColumnStub = defineComponent({
  name: 'BoardColumn',
  props: ['column', 'cards', 'boardUid'],
  emits: ['create', 'edit', 'drop-card'],
  setup(props, { emit }) {
    return () =>
      h('div', { 'data-testid': 'board-column', 'data-column': props.column.uid }, [
        h('span', props.column.title),
        h(
          'button',
          { onClick: () => emit('create', props.column.uid) },
          'Create'
        ),
        ...(props.cards as CardEntity[]).map((c: CardEntity) =>
          h('div', { 'data-testid': 'column-card', 'data-card': c.uid, onClick: () => emit('edit', c) }, c.title)
        ),
        h('div', {
          'data-testid': 'drop-zone',
          onDrop: (e: DragEvent) => {
            const cardId = (e.dataTransfer ?? { getData: () => '' }).getData('text/plain');
            emit('drop-card', { cardId, toColumnUid: props.column.uid });
          },
        }),
      ]);
  },
});

const CreateCardModalStub = defineComponent({
  name: 'CreateCardModal',
  props: ['open', 'columnUid', 'boardUid'],
  emits: ['update:open', 'created'],
  setup() {
    return () => h('div', { 'data-testid': 'create-card-modal' });
  },
});

const EditCardModalStub = defineComponent({
  name: 'EditCardModal',
  props: ['open', 'card', 'boardUid'],
  emits: ['update:open', 'updated'],
  setup() {
    return () => h('div', { 'data-testid': 'edit-card-modal' });
  },
});

// ---- Mock globals ----
const fetchMock = vi.fn();
const toastAddMock = vi.fn();

vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

// ---- Fixtures ----
const mockBoard: BoardEntity = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'in-review' }, order: 0 },
      { uid: 'in-review', title: 'In Review', type: 'Processing', processor_id: 'manager-approval', exit_logic: { approved: 'done' }, order: 1 },
      { uid: 'done', title: 'Done', type: 'Normal', processor_id: 'default-manual', exit_logic: {}, order: 2 },
    ],
  },
  permissions: { read: [], write: [] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockCardIdle: CardEntity = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: mockBoard.uid,
  display_id: 'TST-1',
  title: 'Idle Card',
  description: null,
  version: 1,
  processing_state: 'IDLE',
  is_editable: true,
  payload: {},
  current_status: 'backlog',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockCardProcessing: CardEntity = {
  uid: 'b702f5b3-f91b-4ce0-b562-f4a11fcb45f0',
  board_uid: mockBoard.uid,
  display_id: 'TST-2',
  title: 'Processing Card',
  description: null,
  version: 1,
  processing_state: 'PROCESSING',
  is_editable: false,
  payload: {},
  current_status: 'in-review',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

function mountView() {
  return mount(BoardView, {
    props: { boardUid: mockBoard.uid },
    global: {
      stubs: {
        UPageHeader: UPageHeaderStub,
        UAlert: UAlertStub,
        UPageBody: UPageBodyStub,
        UBadge: UBadgeStub,
        BoardColumn: BoardColumnStub,
        CreateCardModal: CreateCardModalStub,
        EditCardModal: EditCardModalStub,
      },
    },
  });
}

describe('BoardView', () => {
  let store: ReturnType<typeof useBoardStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = useBoardStore();
    store.resetStore();
  });

  afterEach(() => {
    store.resetStore();
    vi.useRealTimers();
  });

  describe('polling while any card is PROCESSING', () => {
    it('starts polling when a card is in PROCESSING state on mount', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue({ data: { board: mockBoard, cards: [mockCardProcessing] } });

      store.hydrate({ board: mockBoard, cards: [mockCardProcessing] });
      mountView();
      await flushPromises();

      expect(store.store.value.ui.pollIntervalId).not.toBeNull();
    });

    it('calls $fetch for snapshot refresh at poll interval', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue({ data: { board: mockBoard, cards: [mockCardProcessing] } });

      store.hydrate({ board: mockBoard, cards: [mockCardProcessing] });
      mountView();
      await flushPromises();

      vi.advanceTimersByTime(2000);
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledWith(`/api/boards/${mockBoard.uid}/snapshot`);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      await flushPromises();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops polling when no cards are PROCESSING', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue({ data: { board: mockBoard, cards: [mockCardProcessing] } });

      store.hydrate({ board: mockBoard, cards: [mockCardProcessing] });
      mountView();
      await flushPromises();

      expect(store.store.value.ui.pollIntervalId).not.toBeNull();

      // Simulate callback updating card to IDLE
      fetchMock.mockResolvedValue({ data: { board: mockBoard, cards: [{ ...mockCardProcessing, processing_state: 'IDLE', is_editable: true }] } });
      vi.advanceTimersByTime(2000);
      await flushPromises();

      expect(store.store.value.ui.pollIntervalId).toBeNull();
    });

    it('does not start polling when all cards are IDLE on mount', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue({ data: { board: mockBoard, cards: [mockCardIdle] } });

      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      mountView();
      await flushPromises();

      expect(store.store.value.ui.pollIntervalId).toBeNull();
    });
  });

  describe('saving indicator', () => {
    it('shows saving badge when isSaving is true', async () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      store.setSaving(true);

      const wrapper = mountView();
      await flushPromises();

      const badge = wrapper.find('[data-testid="u-badge"]');
      expect(badge.exists()).toBe(true);
      expect(badge.text()).toContain('Saving');
    });

    it('does not show saving badge when isSaving is false', async () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      store.setSaving(false);

      const wrapper = mountView();
      await flushPromises();

      const savingBadge = wrapper.findAll('[data-testid="u-badge"]').find((b) => b.text().includes('Saving'));
      expect(savingBadge).toBeUndefined();
    });
  });

  describe('error alert', () => {
    it('shows error alert when error is set', async () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      store.setError('Network failure');

      const wrapper = mountView();
      await flushPromises();

      const alert = wrapper.find('[data-testid="u-alert"]');
      expect(alert.exists()).toBe(true);
      expect(alert.text()).toContain('Network failure');
    });

    it('does not show error alert when error is null', async () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      store.setError(null);

      const wrapper = mountView();
      await flushPromises();

      const alert = wrapper.find('[data-testid="u-alert"]');
      expect(alert.exists()).toBe(false);
    });
  });

  describe('column rendering', () => {
    it('renders all board columns', async () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle, mockCardProcessing] });

      const wrapper = mountView();
      await flushPromises();

      const columns = wrapper.findAll('[data-testid="board-column"]');
      expect(columns).toHaveLength(3);
      expect(columns[0].attributes('data-column')).toBe('backlog');
      expect(columns[1].attributes('data-column')).toBe('in-review');
      expect(columns[2].attributes('data-column')).toBe('done');
    });
  });

  describe('callback-driven column movement animation', () => {
    it('updates card column in store when snapshot refresh returns moved card', async () => {
      vi.useFakeTimers();
      const refreshedCard = { ...mockCardProcessing, current_status: 'done' as const, processing_state: 'IDLE' as const, is_editable: true };
      fetchMock.mockResolvedValue({ data: { board: mockBoard, cards: [mockCardIdle, refreshedCard] } });

      store.hydrate({ board: mockBoard, cards: [mockCardIdle, mockCardProcessing] });
      mountView();
      await flushPromises();

      vi.advanceTimersByTime(2000);
      await flushPromises();

      const moved = store.store.value.cardsById.get(mockCardProcessing.uid);
      expect(moved?.current_status).toBe('done');
      expect(moved?.processing_state).toBe('IDLE');

      const doneColumnCards = store.getCardsForColumn('done');
      expect(doneColumnCards.map((c) => c.uid)).toContain(mockCardProcessing.uid);
    });
  });
});
