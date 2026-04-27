import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { EventLogRow } from '@repo/shared';
import AuditLogPanel from './AuditLogPanel.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);

const validEventId = '550e8400-e29b-41d4-a716-446655440001';
const validCardId = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';

const USlideoverStub = defineComponent({
  name: 'USlideover',
  props: ['open', 'title', 'side'],
  emits: ['update:open'],
  setup(props, { slots }) {
    return () => h('div', { 'data-testid': 'u-slideover' }, [
      h('div', { 'data-testid': 'slideover-title' }, props.title),
      slots.body?.(),
    ]);
  },
});

const UAlertStub = defineComponent({
  name: 'UAlert',
  props: ['icon', 'color', 'variant', 'title'],
  setup(props) {
    return () => h('div', { 'data-testid': 'u-alert', 'data-color': props.color }, props.title);
  },
});

const USkeletonStub = defineComponent({
  name: 'USkeleton',
  props: ['class'],
  setup() {
    return () => h('div', { 'data-testid': 'u-skeleton' });
  },
});

const UIconStub = defineComponent({
  name: 'UIcon',
  props: ['name'],
  setup() {
    return () => h('span', { 'data-testid': 'u-icon' });
  },
});

const UCardStub = defineComponent({
  name: 'UCard',
  props: ['ui'],
  setup(props, { slots }) {
    return () => h('div', { 'data-testid': 'u-card' }, slots.default?.());
  },
});

const UButtonStub = defineComponent({
  name: 'UButton',
  props: ['icon', 'variant', 'color', 'size', 'loading', 'block'],
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () =>
      h('button', { 'data-testid': 'u-button', onClick: () => emit('click') }, slots.default?.());
  },
});

const UBadgeStub = defineComponent({
  name: 'UBadge',
  props: ['color', 'variant', 'size'],
  setup(props, { slots }) {
    return () => h('span', { 'data-testid': 'u-badge' }, slots.default?.());
  },
});

const boardId = '550e8400-e29b-41d4-a716-446655440000';

const mockEventMoved: EventLogRow = {
  event_id: validEventId,
  card_uid: validCardId,
  board_uid: boardId,
  timestamp: '2026-04-27T00:00:00.000Z',
  actor: 'alice',
  action: 'CARD_MOVED',
  category: 'user_action',
  lifecycle_event: null,
  from_column: 'backlog',
  to_column: 'done',
};

const mockEventLifecycle: EventLogRow = {
  event_id: '550e8400-e29b-41d4-a716-446655440002',
  card_uid: validCardId,
  board_uid: boardId,
  timestamp: '2026-04-27T00:01:00.000Z',
  actor: 'system',
  action: 'PROCESSING_STARTED',
  category: 'lifecycle',
  lifecycle_event: 'PROCESSING_STARTED',
  from_column: null,
  to_column: null,
};

function mountPanel(props: { open?: boolean } = {}) {
  return mount(AuditLogPanel, {
    props: { boardId, open: true, ...props },
    global: {
      stubs: {
        USlideover: USlideoverStub,
        UAlert: UAlertStub,
        USkeleton: USkeletonStub,
        UIcon: UIconStub,
        UCard: UCardStub,
        UButton: UButtonStub,
        UBadge: UBadgeStub,
      },
    },
  });
}

describe('AuditLogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches audit log when opened', async () => {
    fetchMock.mockResolvedValue({
      data: { events: [mockEventMoved], next_cursor: null },
    });

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/boards\/.*\/audit-log\?limit=50/),
    );
  });

  it('renders event action, actor, timestamp, and column transition', async () => {
    fetchMock.mockResolvedValue({
      data: { events: [mockEventMoved], next_cursor: null },
    });

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.text()).toContain('CARD_MOVED');
    expect(wrapper.text()).toContain('alice');
    expect(wrapper.text()).toContain('backlog');
    expect(wrapper.text()).toContain('done');
  });

  it('renders lifecycle badge for lifecycle events', async () => {
    fetchMock.mockResolvedValue({
      data: { events: [mockEventLifecycle], next_cursor: null },
    });

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.text()).toContain('PROCESSING_STARTED');
    expect(wrapper.text()).toContain('system');
  });

  it('shows empty state when no events', async () => {
    fetchMock.mockResolvedValue({
      data: { events: [], next_cursor: null },
    });

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.text()).toContain('No audit events yet');
  });

  it('shows skeletons while loading', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    const skeletons = wrapper.findAll('[data-testid="u-skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('appends older events on load more', async () => {
    fetchMock
      .mockResolvedValueOnce({
        data: { events: [mockEventMoved], next_cursor: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        data: { events: [mockEventLifecycle], next_cursor: null },
      });

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    const loadMoreBtn = wrapper
      .findAll('[data-testid="u-button"]')
      .find((b) => b.text().includes('Load more'));
    expect(loadMoreBtn).toBeDefined();

    await loadMoreBtn!.trigger('click');
    await flushPromises();

    const cards = wrapper.findAll('[data-testid="u-card"]');
    expect(cards).toHaveLength(2);
  });

  it('shows UAlert when fetch fails', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject({ data: { error: { message: 'Server error' } } }),
    );

    const wrapper = mountPanel({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    const alert = wrapper.find('[data-testid="u-alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Server error');
  });
});
