import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { BoardEntitySchema } from '@repo/shared';
import type { BoardEntity } from '@repo/shared';
import HomeBoardQuickAccessCard from './HomeBoardQuickAccessCard.vue';

const pushMock = vi.fn();

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return {
    ...actual,
    useRouter: vi.fn(() => ({
      push: pushMock,
    })),
  };
});

// Nuxt UI stubs
const UCardStub = defineComponent({
  name: 'UCard',
  setup(_props, { slots }) {
    return () => h('article', {}, [slots.header?.(), slots.default?.()]);
  },
});

const UButtonStub = defineComponent({
  name: 'UButton',
  props: ['type', 'loading', 'disabled'],
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        'button',
        {
          type: props.type,
          disabled: props.disabled,
          onClick: () => emit('click'),
        },
        slots.default?.()
      );
  },
});

const UIconStub = defineComponent({
  name: 'UIcon',
  props: ['name'],
  setup() {
    return () => h('span');
  },
});

const UBadgeStub = defineComponent({
  name: 'UBadge',
  props: ['color', 'variant', 'size'],
  setup(_props, { slots }) {
    return () => h('span', {}, slots.default?.());
  },
});

function createMockBoard(overrides?: Partial<BoardEntity>): BoardEntity {
  return BoardEntitySchema.parse({
    uid: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Test Board',
    prefix: 'TST',
    schema: {
      columns: [
        {
          uid: 'col-1',
          title: 'Backlog',
          type: 'Normal',
          processor_id: 'default-manual',
          exit_logic: {},
          order: 0,
        },
      ],
    },
    permissions: { read: [], write: [] },
    created_at: '2026-04-26T08:30:00.000Z',
    updated_at: '2026-04-26T08:30:00.000Z',
    ...overrides,
  });
}

function mountCard(board: BoardEntity) {
  return mount(HomeBoardQuickAccessCard, {
    props: { board },
    global: {
      stubs: {
        UCard: UCardStub,
        UButton: UButtonStub,
        UIcon: UIconStub,
        UBadge: UBadgeStub,
      },
    },
  });
}

describe('HomeBoardQuickAccessCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the board title and prefix', async () => {
    const board = createMockBoard();
    const wrapper = mountCard(board);
    await flushPromises();

    expect(wrapper.text()).toContain('Test Board');
    expect(wrapper.text()).toContain('TST');
  });

  it('navigates directly to the board on click', async () => {
    const board = createMockBoard();
    const wrapper = mountCard(board);
    await flushPromises();

    const clickable = wrapper.find('article') || wrapper.find('button') || wrapper.find('[role="button"]');
    expect(clickable.exists()).toBe(true);

    await clickable.trigger('click');
    await flushPromises();

    expect(pushMock).toHaveBeenCalledWith('/boards/550e8400-e29b-41d4-a716-446655440000');
  });

  it('validates mocked board data against Zod schema', async () => {
    const board = createMockBoard();
    const wrapper = mountCard(board);
    await flushPromises();

    expect(wrapper.exists()).toBe(true);
  });
});
