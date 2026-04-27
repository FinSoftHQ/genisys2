import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { CardEntity } from '@repo/shared';
import KanbanCard from './KanbanCard.vue';

const UCardStub = defineComponent({
  name: 'UCard',
  props: ['ui', 'draggable'],
  setup(props, { slots, attrs }) {
    return () =>
      h('div', { 'data-testid': 'u-card', draggable: props.draggable ?? attrs.draggable }, slots.default?.());
  },
});

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

const UIconStub = defineComponent({
  name: 'UIcon',
  props: ['name', 'class'],
  setup() {
    return () => h('span', { 'data-testid': 'u-icon' });
  },
});

const baseCard: CardEntity = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'TST-1',
  title: 'Test Card',
  description: null,
  version: 1,
  processing_state: 'IDLE',
  is_editable: true,
  payload: {},
  current_status: 'backlog',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

function mountCard(card: CardEntity) {
  return mount(KanbanCard, {
    props: { card },
    global: {
      stubs: {
        UCard: UCardStub,
        UButton: UButtonStub,
        UBadge: UBadgeStub,
        UIcon: UIconStub,
      },
    },
  });
}

describe('KanbanCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PROCESSING spinner overlay', () => {
    it('renders spinner overlay when processing_state is PROCESSING', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'PROCESSING', is_editable: false });
      expect(wrapper.find('[data-testid="u-icon"]').exists()).toBe(true);
    });

    it('does not render spinner overlay when processing_state is IDLE', () => {
      const wrapper = mountCard(baseCard);
      expect(wrapper.find('[data-testid="u-icon"]').exists()).toBe(false);
    });

    it('does not render spinner overlay when processing_state is ERROR', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'ERROR', is_editable: false });
      expect(wrapper.find('[data-testid="u-icon"]').exists()).toBe(false);
    });
  });

  describe('drag lock for PROCESSING and ERROR', () => {
    it('sets draggable to false when PROCESSING', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'PROCESSING', is_editable: false });
      const card = wrapper.find('[data-testid="u-card"]');
      expect(card.attributes('draggable')).toBe('false');
    });

    it('sets draggable to false when ERROR', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'ERROR', is_editable: false });
      const card = wrapper.find('[data-testid="u-card"]');
      expect(card.attributes('draggable')).toBe('false');
    });

    it('sets draggable to true when IDLE', () => {
      const wrapper = mountCard(baseCard);
      const card = wrapper.find('[data-testid="u-card"]');
      expect(card.attributes('draggable')).toBe('true');
    });

    it('prevents dragstart event when locked', async () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'PROCESSING', is_editable: false });
      const card = wrapper.find('[data-testid="u-card"]');
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      await card.element.dispatchEvent(event);
      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  describe('edit lock', () => {
    it('shows edit button when card is editable and not locked', () => {
      const wrapper = mountCard(baseCard);
      expect(wrapper.find('[data-testid="u-button"]').exists()).toBe(true);
    });

    it('hides edit button when card is PROCESSING', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'PROCESSING', is_editable: false });
      expect(wrapper.find('[data-testid="u-button"]').exists()).toBe(false);
    });

    it('hides edit button when card is ERROR', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'ERROR', is_editable: false });
      expect(wrapper.find('[data-testid="u-button"]').exists()).toBe(false);
    });

    it('hides edit button when card is not editable even if IDLE', () => {
      const wrapper = mountCard({ ...baseCard, is_editable: false });
      expect(wrapper.find('[data-testid="u-button"]').exists()).toBe(false);
    });
  });

  describe('state badges', () => {
    it('shows PROCESSING state badge when processing_state is PROCESSING', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'PROCESSING', is_editable: false });
      const badges = wrapper.findAll('[data-testid="u-badge"]');
      const stateBadge = badges.find((b) => b.text() === 'PROCESSING');
      expect(stateBadge).toBeDefined();
    });

    it('shows ERROR state badge when processing_state is ERROR', () => {
      const wrapper = mountCard({ ...baseCard, processing_state: 'ERROR', is_editable: false });
      const badges = wrapper.findAll('[data-testid="u-badge"]');
      const stateBadge = badges.find((b) => b.text() === 'ERROR');
      expect(stateBadge).toBeDefined();
    });

    it('does not show state badge when processing_state is IDLE', () => {
      const wrapper = mountCard(baseCard);
      const badges = wrapper.findAll('[data-testid="u-badge"]');
      const stateBadge = badges.find((b) => b.text() === 'IDLE');
      expect(stateBadge).toBeUndefined();
    });
  });

  describe('edit emission', () => {
    it('emits edit event when edit button clicked', async () => {
      const wrapper = mountCard(baseCard);
      const btn = wrapper.find('[data-testid="u-button"]');
      await btn.trigger('click');
      expect(wrapper.emitted('edit')).toHaveLength(1);
      expect((wrapper.emitted('edit')![0] as CardEntity[])[0].uid).toBe(baseCard.uid);
    });
  });
});
