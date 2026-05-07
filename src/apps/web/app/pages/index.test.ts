import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h, nextTick } from 'vue';
import type { BoardEntity, BoardSuiteWithBoards } from '@repo/shared';
import {
  BoardEntitySchema,
  BoardSuiteWithBoardsSchema,
  CreateBoardRequestSchema,
  CreateBoardSuiteRequestSchema,
  CreateBoardResponseSchema,
  BoardSuiteResponseSchema,
} from '@repo/shared';

import HomePage from '~/pages/index.vue';

// ------------------------------------------------------------------
// Globals & module mocks
// ------------------------------------------------------------------
const pushMock = vi.fn();
const fetchMock = vi.fn();
const toastAddMock = vi.fn();

vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
vi.stubGlobal('definePageMeta', vi.fn());

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return {
    ...actual,
    useRouter: vi.fn(() => ({
      push: pushMock,
    })),
  };
});

let boardsListState: {
  boards: ReturnType<typeof ref<BoardEntity[]>>;
  isLoading: ReturnType<typeof ref<boolean>>;
  error: ReturnType<typeof ref<string | null>>;
  refreshBoards: ReturnType<typeof vi.fn>;
};
let suitesListState: {
  suites: ReturnType<typeof ref<BoardSuiteWithBoards[]>>;
  isLoading: ReturnType<typeof ref<boolean>>;
  error: ReturnType<typeof ref<string | null>>;
  refreshSuites: ReturnType<typeof vi.fn>;
};

vi.mock('~/composables/useBoardsList', () => ({
  useBoardsList: vi.fn(() => boardsListState),
}));

vi.mock('~/composables/useSuitesList', () => ({
  useSuitesList: vi.fn(() => suitesListState),
}));

// ------------------------------------------------------------------
// Nuxt UI stubs (semantic, no CSS assertions)
// ------------------------------------------------------------------
const UDashboardPanelStub = defineComponent({
  name: 'UDashboardPanel',
  setup(_props, { slots }) {
    return () => h('div', { 'data-testid': 'u-dashboard-panel' }, [slots.header?.(), slots.body?.()]);
  },
});

const UDashboardNavbarStub = defineComponent({
  name: 'UDashboardNavbar',
  props: ['title'],
  setup(props) {
    return () => h('nav', {}, props.title);
  },
});

const UCardStub = defineComponent({
  name: 'UCard',
  setup(_props, { slots }) {
    return () => h('article', {}, [slots.header?.(), slots.default?.()]);
  },
});

const UButtonStub = defineComponent({
  name: 'UButton',
  props: ['type', 'loading', 'disabled', 'variant', 'color'],
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

const UInputStub = defineComponent({
  name: 'UInput',
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        value: props.modelValue,
        placeholder: props.placeholder,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      });
  },
});

const UFormStub = defineComponent({
  name: 'UForm',
  props: ['state'],
  emits: ['submit'],
  setup(_props, { slots, emit }) {
    return () =>
      h(
        'form',
        {
          onSubmit: (e: Event) => {
            e.preventDefault();
            emit('submit');
          },
        },
        slots.default?.()
      );
  },
});

const UFormFieldStub = defineComponent({
  name: 'UFormField',
  props: ['name', 'label'],
  setup(props, { slots }) {
    return () => h('div', {}, [h('label', {}, props.label), slots.default?.()]);
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

const HomeSuiteQuickAccessCardStub = defineComponent({
  name: 'HomeSuiteQuickAccessCard',
  props: ['suite'],
  emits: ['navigate'],
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        {
          'data-testid': 'suite-quick-access-card',
          'data-suite-uid': props.suite?.suite?.uid,
          onClick: () => {
            emit('navigate', props.suite);
            const primary = props.suite?.boards?.find((b: any) => b.role === 'primary');
            const target = primary?.uid ?? props.suite?.boards?.[0]?.uid;
            if (target) pushMock(`/boards/${target}`);
          },
        },
        props.suite?.suite?.title
      );
  },
});

const HomeBoardQuickAccessCardStub = defineComponent({
  name: 'HomeBoardQuickAccessCard',
  props: ['board'],
  emits: ['navigate'],
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        {
          'data-testid': 'board-quick-access-card',
          'data-board-uid': props.board?.uid,
          onClick: () => {
            emit('navigate', props.board);
            pushMock(`/boards/${props.board?.uid}`);
          },
        },
        props.board?.title
      );
  },
});

const NuxtLinkStub = defineComponent({
  name: 'NuxtLink',
  props: ['to'],
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.());
  },
});

const stubs = {
  UDashboardPanel: UDashboardPanelStub,
  UDashboardNavbar: UDashboardNavbarStub,
  UCard: UCardStub,
  UButton: UButtonStub,
  UInput: UInputStub,
  UForm: UFormStub,
  UFormField: UFormFieldStub,
  UIcon: UIconStub,
  UBadge: UBadgeStub,
  HomeSuiteQuickAccessCard: HomeSuiteQuickAccessCardStub,
  HomeBoardQuickAccessCard: HomeBoardQuickAccessCardStub,
  NuxtLink: NuxtLinkStub,
};

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------
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

function createMockSuite(overrides?: Partial<BoardSuiteWithBoards>): BoardSuiteWithBoards {
  return BoardSuiteWithBoardsSchema.parse({
    suite: {
      uid: '660e8400-e29b-41d4-a716-446655440001',
      title: 'Test Suite',
      created_at: '2026-04-26T08:30:00.000Z',
      updated_at: '2026-04-26T08:30:00.000Z',
    },
    boards: [
      createMockBoard({
        uid: '550e8400-e29b-41d4-a716-446655440001',
        suite_uid: '660e8400-e29b-41d4-a716-446655440001' as unknown as BoardEntity['suite_uid'],
        role: 'primary',
        title: 'Suite Primary Board',
        prefix: 'SPB',
      }),
    ],
    ...overrides,
  });
}

function mountHomePage() {
  return mount(HomePage, {
    global: { stubs },
  });
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
describe('Home Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardsListState = {
      boards: ref([]),
      isLoading: ref(false),
      error: ref(null),
      refreshBoards: vi.fn(),
    };
    suitesListState = {
      suites: ref([]),
      isLoading: ref(false),
      error: ref(null),
      refreshSuites: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----------------------------------------------------------------
  // Section hierarchy
  // ----------------------------------------------------------------
  describe('section hierarchy', () => {
    it('renders quick-actions, browse, and uuid-fallback sections in exact order', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const browse = wrapper.find('[aria-label="Browse"]');
      const uuidFallback = wrapper.find('[aria-label="UUID Fallback"]');

      expect(quickActions.exists()).toBe(true);
      expect(browse.exists()).toBe(true);
      expect(uuidFallback.exists()).toBe(true);

      // DOM order assertion
      const html = wrapper.html();
      expect(html.indexOf('aria-label="Quick Actions"')).toBeLessThan(html.indexOf('aria-label="Browse"'));
      expect(html.indexOf('aria-label="Browse"')).toBeLessThan(html.indexOf('aria-label="UUID Fallback"'));
    });

    it('renders Create Suite before Create Board and as the primary CTA', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      expect(quickActions.exists()).toBe(true);

      const buttons = quickActions.findAll('button');
      const texts = buttons.map((b) => b.text());
      const suiteIdx = texts.findIndex((t) => t.includes('Create Suite'));
      const boardIdx = texts.findIndex((t) => t.includes('Create Board'));

      expect(suiteIdx).toBeGreaterThanOrEqual(0);
      expect(boardIdx).toBeGreaterThanOrEqual(0);
      expect(suiteIdx).toBeLessThan(boardIdx);
    });
  });

  // ----------------------------------------------------------------
  // Create Suite
  // ----------------------------------------------------------------
  describe('create suite', () => {
    it('falls back to "New Suite" when title is blank or whitespace', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const suiteTitleInput = inputs.find((input) => input.attributes('placeholder') === 'New Suite');
      expect(suiteTitleInput).toBeDefined();

      await suiteTitleInput!.setValue('   ');
      await flushPromises();

      const suiteForm = quickActions.findAll('form').find((f) => {
        const submitBtn = f.find('button[type="submit"]');
        return submitBtn.exists() && submitBtn.text().includes('Create Suite');
      });
      expect(suiteForm).toBeDefined();

      fetchMock.mockResolvedValue(
        BoardSuiteResponseSchema.parse({
          data: createMockSuite({
            suite: {
              uid: '660e8400-e29b-41d4-a716-446655440002',
              title: 'New Suite',
              created_at: '2026-04-26T08:30:00.000Z',
              updated_at: '2026-04-26T08:30:00.000Z',
            },
            boards: [
              createMockBoard({
                uid: '550e8400-e29b-41d4-a716-446655440002',
                suite_uid: '660e8400-e29b-41d4-a716-446655440002' as unknown as BoardEntity['suite_uid'],
                role: 'primary',
                title: 'Primary Board',
                prefix: 'PRM',
              }),
            ],
          }),
        })
      );

      await suiteForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = fetchMock.mock.calls[0][1].body;
      const parsed = CreateBoardSuiteRequestSchema.parse(requestBody);
      expect(parsed.title).toBe('New Suite');
    });

    it('redirects to the primary board after suite creation', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const suiteForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Suite');
      });
      expect(suiteForm).toBeDefined();

      const primaryUid = '550e8400-e29b-41d4-a716-446655440010';
      fetchMock.mockResolvedValue(
        BoardSuiteResponseSchema.parse({
          data: createMockSuite({
            boards: [
              createMockBoard({
                uid: primaryUid,
                suite_uid: '660e8400-e29b-41d4-a716-446655440010' as unknown as BoardEntity['suite_uid'],
                role: 'primary',
                title: 'Primary',
                prefix: 'PRI',
              }),
            ],
          }),
        })
      );

      await suiteForm!.trigger('submit');
      await flushPromises();

      expect(pushMock).toHaveBeenCalledWith(`/boards/${primaryUid}`);
    });

    it('redirects to the first board when no primary board exists', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const suiteForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Suite');
      });
      expect(suiteForm).toBeDefined();

      const firstUid = '550e8400-e29b-41d4-a716-446655440020';
      fetchMock.mockResolvedValue(
        BoardSuiteResponseSchema.parse({
          data: createMockSuite({
            boards: [
              createMockBoard({
                uid: firstUid,
                suite_uid: '660e8400-e29b-41d4-a716-446655440020' as unknown as BoardEntity['suite_uid'],
                role: 'tasks',
                title: 'Tasks Board',
                prefix: 'TSK',
              }),
            ],
          }),
        })
      );

      await suiteForm!.trigger('submit');
      await flushPromises();

      expect(pushMock).toHaveBeenCalledWith(`/boards/${firstUid}`);
    });

    it('limits templates to default and development only', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const buttons = quickActions.findAll('button');
      const templateLabels = buttons.map((b) => b.text());

      const hasDefault = templateLabels.some((t) => /default/i.test(t));
      const hasDevelopment = templateLabels.some((t) => /development/i.test(t));
      const hasOther = templateLabels.some((t) => /task/i.test(t) && !/development/i.test(t));

      expect(hasDefault).toBe(true);
      expect(hasDevelopment).toBe(true);
      expect(hasOther).toBe(false);
    });

    it('rejects suite title longer than 200 characters with toast and no API call', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const suiteTitleInput = inputs.find((input) => input.attributes('placeholder') === 'New Suite');
      expect(suiteTitleInput).toBeDefined();

      const longTitle = 'A'.repeat(201);
      await suiteTitleInput!.setValue(longTitle);
      await flushPromises();

      const suiteForm = quickActions.findAll('form').find((f) => {
        const submitBtn = f.find('button[type="submit"]');
        return submitBtn.exists() && submitBtn.text().includes('Create Suite');
      });
      expect(suiteForm).toBeDefined();

      await suiteForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Title too long',
          color: 'error',
        })
      );
    });

    it('accepts suite title exactly at 200 characters', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const suiteTitleInput = inputs.find((input) => input.attributes('placeholder') === 'New Suite');
      expect(suiteTitleInput).toBeDefined();

      const exactTitle = 'A'.repeat(200);
      await suiteTitleInput!.setValue(exactTitle);
      await flushPromises();

      const suiteForm = quickActions.findAll('form').find((f) => {
        const submitBtn = f.find('button[type="submit"]');
        return submitBtn.exists() && submitBtn.text().includes('Create Suite');
      });
      expect(suiteForm).toBeDefined();

      fetchMock.mockResolvedValue(
        BoardSuiteResponseSchema.parse({
          data: createMockSuite({
            suite: {
              uid: '660e8400-e29b-41d4-a716-446655440080',
              title: exactTitle,
              created_at: '2026-04-26T08:30:00.000Z',
              updated_at: '2026-04-26T08:30:00.000Z',
            },
            boards: [
              createMockBoard({
                uid: '550e8400-e29b-41d4-a716-446655440080',
                suite_uid: '660e8400-e29b-41d4-a716-446655440080' as unknown as BoardEntity['suite_uid'],
                role: 'primary',
                title: 'Primary Board',
                prefix: 'PRM',
              }),
            ],
          }),
        })
      );

      await suiteForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = fetchMock.mock.calls[0][1].body;
      const parsed = CreateBoardSuiteRequestSchema.parse(requestBody);
      expect(parsed.title).toBe(exactTitle);
    });
  });

  // ----------------------------------------------------------------
  // Create Board
  // ----------------------------------------------------------------
  describe('create board', () => {
    it('falls back to "New Board" when title is blank or whitespace', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const boardTitleInput = inputs.find((input) => input.attributes('placeholder') === 'New Board');
      expect(boardTitleInput).toBeDefined();

      await boardTitleInput!.setValue('   ');
      await flushPromises();

      const boardForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Board');
      });
      expect(boardForm).toBeDefined();

      const newUid = '550e8400-e29b-41d4-a716-446655440030';
      fetchMock.mockResolvedValue(
        CreateBoardResponseSchema.parse({
          data: {
            board: createMockBoard({ uid: newUid, title: 'New Board', prefix: 'NWB' }),
          },
        })
      );

      await boardForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = fetchMock.mock.calls[0][1].body;
      const parsed = CreateBoardRequestSchema.parse(requestBody);
      expect(parsed.title).toBe('New Board');
    });

    it('redirects to the newly created board', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const boardForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Board');
      });
      expect(boardForm).toBeDefined();

      const newUid = '550e8400-e29b-41d4-a716-446655440031';
      fetchMock.mockResolvedValue(
        CreateBoardResponseSchema.parse({
          data: {
            board: createMockBoard({ uid: newUid, title: 'My Board', prefix: 'MYB' }),
          },
        })
      );

      await boardForm!.trigger('submit');
      await flushPromises();

      expect(pushMock).toHaveBeenCalledWith(`/boards/${newUid}`);
    });

    it('trims prefix and treats empty/whitespace as optional', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const prefixInput = inputs.find((input) => input.attributes('placeholder')?.toLowerCase().includes('prefix') || input.attributes('placeholder')?.toLowerCase().includes('auto'));
      expect(prefixInput).toBeDefined();

      await prefixInput!.setValue('  ');
      await flushPromises();

      const boardForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Board');
      });
      expect(boardForm).toBeDefined();

      fetchMock.mockResolvedValue(
        CreateBoardResponseSchema.parse({
          data: {
            board: createMockBoard({ uid: '550e8400-e29b-41d4-a716-446655440032', title: 'Board', prefix: 'BOD' }),
          },
        })
      );

      await boardForm!.trigger('submit');
      await flushPromises();

      const requestBody = fetchMock.mock.calls[0][1].body;
      const parsed = CreateBoardRequestSchema.parse(requestBody);
      expect(parsed.prefix).toBeUndefined();
    });

    it('shows toast error for invalid prefix format', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const titleInput = inputs.find((input) => input.attributes('placeholder') === 'New Board');
      const prefixInput = inputs.find((input) => input.attributes('placeholder')?.toLowerCase().includes('prefix') || input.attributes('placeholder')?.toLowerCase().includes('auto'));

      expect(titleInput).toBeDefined();
      expect(prefixInput).toBeDefined();

      await titleInput!.setValue('My Board');
      await prefixInput!.setValue('lowercase');
      await flushPromises();

      const boardForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Board');
      });

      await boardForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Invalid prefix',
          color: 'error',
        })
      );
    });

    it('shows toast error for PREFIX_EXISTS server error', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const titleInput = inputs.find((input) => input.attributes('placeholder') === 'New Board');
      const prefixInput = inputs.find((input) => input.attributes('placeholder')?.toLowerCase().includes('prefix') || input.attributes('placeholder')?.toLowerCase().includes('auto'));

      await titleInput!.setValue('My Board');
      await prefixInput!.setValue('ABC');
      await flushPromises();

      fetchMock.mockRejectedValue({
        data: {
          error: { code: 'PREFIX_EXISTS', message: 'Prefix already in use' },
        },
      });

      const boardForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Board');
      });

      await boardForm!.trigger('submit');
      await flushPromises();

      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Prefix taken',
          color: 'error',
        })
      );
    });

    it('rejects board title longer than 200 characters with toast and no API call', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const boardTitleInput = inputs.find((input) => input.attributes('placeholder') === 'New Board');
      expect(boardTitleInput).toBeDefined();

      const longTitle = 'B'.repeat(201);
      await boardTitleInput!.setValue(longTitle);
      await flushPromises();

      const boardForm = quickActions.findAll('form').find((f) => {
        const submitBtn = f.find('button[type="submit"]');
        return submitBtn.exists() && submitBtn.text().includes('Create Board');
      });
      expect(boardForm).toBeDefined();

      await boardForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Title too long',
          color: 'error',
        })
      );
    });

    it('accepts board title exactly at 200 characters', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const quickActions = wrapper.find('[aria-label="Quick Actions"]');
      const inputs = quickActions.findAll('input');
      const boardTitleInput = inputs.find((input) => input.attributes('placeholder') === 'New Board');
      expect(boardTitleInput).toBeDefined();

      const exactTitle = 'B'.repeat(200);
      await boardTitleInput!.setValue(exactTitle);
      await flushPromises();

      const boardForm = quickActions.findAll('form').find((f) => {
        const btn = f.find('button[type="submit"]');
        return btn.exists() && btn.text().includes('Create Board');
      });
      expect(boardForm).toBeDefined();

      fetchMock.mockResolvedValue(
        CreateBoardResponseSchema.parse({
          data: {
            board: createMockBoard({ uid: '550e8400-e29b-41d4-a716-446655440090', title: exactTitle, prefix: 'NWB' }),
          },
        })
      );

      await boardForm!.trigger('submit');
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = fetchMock.mock.calls[0][1].body;
      const parsed = CreateBoardRequestSchema.parse(requestBody);
      expect(parsed.title).toBe(exactTitle);
    });
  });

  // ----------------------------------------------------------------
  // UUID Fallback
  // ----------------------------------------------------------------
  describe('uuid fallback', () => {
    it('is collapsed by default', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const uuidFallback = wrapper.find('[aria-label="UUID Fallback"]');
      expect(uuidFallback.exists()).toBe(true);

      const input = uuidFallback.find('input');
      expect(input.exists()).toBe(false);
    });

    it('expands on toggle interaction', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const uuidFallback = wrapper.find('[aria-label="UUID Fallback"]');
      const toggleBtn = uuidFallback.find('button');
      expect(toggleBtn.exists()).toBe(true);

      await toggleBtn.trigger('click');
      await nextTick();

      const input = uuidFallback.find('input');
      expect(input.exists()).toBe(true);
    });

    it('navigates to /boards/:uuid on submit', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const uuidFallback = wrapper.find('[aria-label="UUID Fallback"]');
      const toggleBtn = uuidFallback.find('button');
      await toggleBtn.trigger('click');
      await nextTick();

      const input = uuidFallback.find('input');
      await input.setValue('550e8400-e29b-41d4-a716-446655440099');
      await flushPromises();

      const form = uuidFallback.find('form');
      await form.trigger('submit');
      await flushPromises();

      expect(pushMock).toHaveBeenCalledWith('/boards/550e8400-e29b-41d4-a716-446655440099');
    });
  });

  // ----------------------------------------------------------------
  // Browse section
  // ----------------------------------------------------------------
  describe('browse section', () => {
    it('renders suites before standalone boards', async () => {
      const suite = createMockSuite();
      const standalone = createMockBoard({
        uid: '550e8400-e29b-41d4-a716-446655440050',
        title: 'Standalone Board',
        prefix: 'STB',
      });

      suitesListState.suites.value = [suite];
      boardsListState.boards.value = [standalone, ...suite.boards];

      const wrapper = mountHomePage();
      await flushPromises();

      const browse = wrapper.find('[aria-label="Browse"]');
      expect(browse.exists()).toBe(true);

      const suiteCards = browse.findAll('[data-testid="suite-quick-access-card"]');
      const boardCards = browse.findAll('[data-testid="board-quick-access-card"]');

      expect(suiteCards.length).toBeGreaterThan(0);
      expect(boardCards.length).toBeGreaterThan(0);

      const html = browse.html();
      expect(html.indexOf('suite-quick-access-card')).toBeLessThan(html.indexOf('board-quick-access-card'));
    });

    it('shows loading state', async () => {
      boardsListState.isLoading.value = true;
      suitesListState.isLoading.value = true;

      const wrapper = mountHomePage();
      await flushPromises();

      const browse = wrapper.find('[aria-label="Browse"]');
      const loader = browse.find('[aria-label="Loading"]');
      expect(loader.exists()).toBe(true);
    });

    it('shows error state', async () => {
      boardsListState.error.value = 'Network error';

      const wrapper = mountHomePage();
      await flushPromises();

      const browse = wrapper.find('[aria-label="Browse"]');
      expect(browse.text().toLowerCase()).toContain('error');
    });

    it('shows empty state when no suites or boards exist', async () => {
      const wrapper = mountHomePage();
      await flushPromises();

      const browse = wrapper.find('[aria-label="Browse"]');
      expect(browse.text().toLowerCase()).toContain('no boards');
    });
  });

  // ----------------------------------------------------------------
  // Search
  // ----------------------------------------------------------------
  describe('search', () => {
    it('trims input and filters case-insensitively across suite title, board title, and board prefix', async () => {
      const suite = createMockSuite({
        suite: {
          uid: '660e8400-e29b-41d4-a716-446655440060',
          title: 'Alpha Suite',
          created_at: '2026-04-26T08:30:00.000Z',
          updated_at: '2026-04-26T08:30:00.000Z',
        },
        boards: [
          createMockBoard({
            uid: '550e8400-e29b-41d4-a716-446655440060',
            suite_uid: '660e8400-e29b-41d4-a716-446655440060' as unknown as BoardEntity['suite_uid'],
            role: 'primary',
            title: 'Alpha Board',
            prefix: 'ALP',
          }),
        ],
      });
      const standalone = createMockBoard({
        uid: '550e8400-e29b-41d4-a716-446655440061',
        title: 'Beta Board',
        prefix: 'BET',
      });

      suitesListState.suites.value = [suite];
      boardsListState.boards.value = [standalone, ...suite.boards];

      const wrapper = mountHomePage();
      await flushPromises();

      const browse = wrapper.find('[aria-label="Browse"]');
      const searchInput = browse.find('input[aria-label="Search"]') || browse.find('input[type="search"]') || browse.find('input');
      expect(searchInput.exists()).toBe(true);

      // Search for suite title with whitespace and mixed case
      await searchInput.setValue('  alpha  ');
      await nextTick();

      let suiteCards = browse.findAll('[data-testid="suite-quick-access-card"]');
      let boardCards = browse.findAll('[data-testid="board-quick-access-card"]');
      expect(suiteCards.length).toBe(1);
      expect(boardCards.length).toBe(0);

      // Search for board prefix
      await searchInput.setValue('bet');
      await nextTick();

      suiteCards = browse.findAll('[data-testid="suite-quick-access-card"]');
      boardCards = browse.findAll('[data-testid="board-quick-access-card"]');
      expect(suiteCards.length).toBe(0);
      expect(boardCards.length).toBe(1);

      // Search for board title inside suite
      await searchInput.setValue('ALP');
      await nextTick();

      suiteCards = browse.findAll('[data-testid="suite-quick-access-card"]');
      boardCards = browse.findAll('[data-testid="board-quick-access-card"]');
      expect(suiteCards.length).toBe(1);
      expect(boardCards.length).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // Quick-access navigation
  // ----------------------------------------------------------------
  describe('quick-access navigation', () => {
    it('suite card navigates to the primary board when available', async () => {
      const primaryUid = '550e8400-e29b-41d4-a716-446655440070';
      const suite = createMockSuite({
        boards: [
          createMockBoard({
            uid: primaryUid,
            suite_uid: '660e8400-e29b-41d4-a716-446655440070' as unknown as BoardEntity['suite_uid'],
            role: 'primary',
            title: 'Primary',
            prefix: 'PRI',
          }),
        ],
      });

      suitesListState.suites.value = [suite];
      boardsListState.boards.value = suite.boards;

      const wrapper = mountHomePage();
      await flushPromises();

      const suiteCard = wrapper.find('[data-testid="suite-quick-access-card"]');
      expect(suiteCard.exists()).toBe(true);

      await suiteCard.trigger('click');
      await flushPromises();

      expect(pushMock).toHaveBeenCalledWith(`/boards/${primaryUid}`);
    });

    it('board card navigates directly to that board', async () => {
      const boardUid = '550e8400-e29b-41d4-a716-446655440071';
      const standalone = createMockBoard({
        uid: boardUid,
        title: 'Standalone',
        prefix: 'STN',
      });

      boardsListState.boards.value = [standalone];

      const wrapper = mountHomePage();
      await flushPromises();

      const boardCard = wrapper.find('[data-testid="board-quick-access-card"]');
      expect(boardCard.exists()).toBe(true);

      await boardCard.trigger('click');
      await flushPromises();

      expect(pushMock).toHaveBeenCalledWith(`/boards/${boardUid}`);
    });
  });
});
