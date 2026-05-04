import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { BoardSuiteWithBoardsSchema } from '@repo/shared';
import type { BoardSuiteWithBoards } from '@repo/shared';

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

// Lazy-load the component under test (may not exist yet)
let HomeSuiteQuickAccessCard: any;
let loadError: any;

beforeAll(async () => {
  try {
    const mod = await import('./HomeSuiteQuickAccessCard.vue');
    HomeSuiteQuickAccessCard = mod.default;
  } catch (err) {
    loadError = err;
  }
});

function createMockSuite(overrides?: Partial<BoardSuiteWithBoards>): BoardSuiteWithBoards {
  return BoardSuiteWithBoardsSchema.parse({
    suite: {
      uid: '660e8400-e29b-41d4-a716-446655440001',
      title: 'Test Suite',
      created_at: '2026-04-26T08:30:00.000Z',
      updated_at: '2026-04-26T08:30:00.000Z',
    },
    boards: [
      {
        uid: '550e8400-e29b-41d4-a716-446655440001',
        title: 'Primary Board',
        prefix: 'PRM',
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
        suite_uid: '660e8400-e29b-41d4-a716-446655440001',
        role: 'primary',
      },
    ],
    ...overrides,
  });
}

function mountCard(suite: BoardSuiteWithBoards) {
  return mount(HomeSuiteQuickAccessCard, {
    props: { suite },
    global: {
      stubs: {
        UCard: UCardStub,
        UButton: UButtonStub,
        UIcon: UIconStub,
      },
    },
  });
}

describe('HomeSuiteQuickAccessCard', () => {
  if (!HomeSuiteQuickAccessCard) {
    it('component file must exist at HomeSuiteQuickAccessCard.vue', () => {
      throw new Error(
        'HomeSuiteQuickAccessCard.vue does not exist yet. The Nuxt Developer must create this component.'
      );
    });
    return;
  }

  beforeAll(() => {
    vi.clearAllMocks();
  });

  it('renders the suite title', async () => {
    const suite = createMockSuite();
    const wrapper = mountCard(suite);
    await flushPromises();

    expect(wrapper.text()).toContain('Test Suite');
  });

  it('navigates to the primary board on click', async () => {
    const suite = createMockSuite();
    const wrapper = mountCard(suite);
    await flushPromises();

    const clickable = wrapper.find('article') || wrapper.find('button') || wrapper.find('[role="button"]');
    expect(clickable.exists()).toBe(true);

    await clickable.trigger('click');
    await flushPromises();

    expect(pushMock).toHaveBeenCalledWith('/boards/550e8400-e29b-41d4-a716-446655440001');
  });

  it('navigates to the first board when no primary board exists', async () => {
    const suite = createMockSuite({
      boards: [
        {
          uid: '550e8400-e29b-41d4-a716-446655440002',
          title: 'First Board',
          prefix: 'FST',
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
          suite_uid: '660e8400-e29b-41d4-a716-446655440001',
          role: 'tasks',
        },
      ],
    });

    const wrapper = mountCard(suite);
    await flushPromises();

    const clickable = wrapper.find('article') || wrapper.find('button') || wrapper.find('[role="button"]');
    await clickable.trigger('click');
    await flushPromises();

    expect(pushMock).toHaveBeenCalledWith('/boards/550e8400-e29b-41d4-a716-446655440002');
  });

  it('validates mocked suite data against Zod schema', async () => {
    const suite = createMockSuite();
    const wrapper = mountCard(suite);
    await flushPromises();

    expect(wrapper.exists()).toBe(true);
  });
});
