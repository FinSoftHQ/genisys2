import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { BoardEntity, CardEntity } from '@repo/shared';
import BoardColumn from './BoardColumn.vue';

const UButtonStub = defineComponent({
  name: 'UButton',
  props: ['icon', 'variant', 'color', 'size', 'loading', 'disabled'],
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () =>
      h('button', { 'data-testid': 'u-button', disabled: props.disabled, onClick: () => emit('click') }, slots.default?.());
  },
});

const UBadgeStub = defineComponent({
  name: 'UBadge',
  props: ['color', 'variant', 'size'],
  setup(props, { slots }) {
    return () => h('span', { 'data-testid': 'u-badge' }, slots.default?.());
  },
});

const KanbanCardStub = defineComponent({
  name: 'KanbanCard',
  props: ['card'],
  emits: ['edit'],
  setup(props, { emit }) {
    return () => h('div', { 'data-testid': 'kanban-card', 'data-card-id': props.card.uid }, props.card.title);
  },
});

const normalColumn: BoardEntity['schema']['columns'][number] = {
  uid: 'backlog',
  title: 'Backlog',
  type: 'Normal',
  processor_id: 'default-manual',
  exit_logic: { default: 'in-progress' },
  order: 0,
};

const processingColumn: BoardEntity['schema']['columns'][number] = {
  uid: 'in-review',
  title: 'In Review',
  type: 'Processing',
  processor_id: 'manager-approval',
  exit_logic: { approved: 'done', rejected: 'backlog' },
  order: 1,
};

const mockCard: CardEntity = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'TST-1',
  title: 'Card One',
  description: null,
  version: 1,
  processing_state: 'IDLE',
  is_editable: true,
  payload: {},
  current_status: 'backlog',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

function mountColumn(column: typeof normalColumn, cards: CardEntity[] = []) {
  return mount(BoardColumn, {
    props: { column, cards, boardUid: '550e8400-e29b-41d4-a716-446655440000' },
    global: {
      stubs: {
        UButton: UButtonStub,
        UBadge: UBadgeStub,
        KanbanCard: KanbanCardStub,
      },
    },
  });
}

describe('BoardColumn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Processing column badge visibility', () => {
    it('shows Processing badge when column type is Processing', () => {
      const wrapper = mountColumn(processingColumn);
      const badges = wrapper.findAll('[data-testid="u-badge"]');
      const processingBadge = badges.find((b) => b.text().includes('Processing'));
      expect(processingBadge).toBeDefined();
    });

    it('does not show Processing badge when column type is Normal', () => {
      const wrapper = mountColumn(normalColumn);
      const badges = wrapper.findAll('[data-testid="u-badge"]');
      const processingBadge = badges.find((b) => b.text().includes('Processing'));
      expect(processingBadge).toBeUndefined();
    });
  });

  describe('card rendering', () => {
    it('renders cards in the provided order', () => {
      const cards = [
        { ...mockCard, uid: 'card-1', title: 'First' },
        { ...mockCard, uid: 'card-2', title: 'Second' },
      ];
      const wrapper = mountColumn(normalColumn, cards);
      const rendered = wrapper.findAll('[data-testid="kanban-card"]');
      expect(rendered).toHaveLength(2);
      expect(rendered[0].text()).toBe('First');
      expect(rendered[1].text()).toBe('Second');
    });

    it('shows empty state when no cards', () => {
      const wrapper = mountColumn(normalColumn, []);
      expect(wrapper.text()).toContain('Drop cards here');
    });
  });

  describe('drag and drop', () => {
    it('emits drop-card with cardId and column uid on drop', async () => {
      const wrapper = mountColumn(processingColumn, []);

      const dataTransfer = { getData: (format: string) => (format === 'text/plain' ? 'dropped-card-123' : '') } as DataTransfer;

      await wrapper.trigger('drop', { dataTransfer });
      await flushPromises();

      expect(wrapper.emitted('drop-card')).toHaveLength(1);
      const payload = (wrapper.emitted('drop-card')![0] as { cardId: string; toColumnUid: string }[])[0];
      expect(payload.cardId).toBe('dropped-card-123');
      expect(payload.toColumnUid).toBe('in-review');
    });

    it('allows dragover by preventing default', async () => {
      const wrapper = mountColumn(normalColumn, []);
      const dropZone = wrapper.element;
      const event = new DragEvent('dragover', { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      await dropZone.dispatchEvent(event);
      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  describe('create card', () => {
    it('emits create event with column uid when plus button clicked', async () => {
      const wrapper = mountColumn(normalColumn, []);
      const btn = wrapper.find('[data-testid="u-button"]');
      await btn.trigger('click');

      expect(wrapper.emitted('create')).toHaveLength(1);
      expect((wrapper.emitted('create')![0] as string[])[0]).toBe('backlog');
    });
  });
});
