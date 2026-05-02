import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useBoardRealtime } from './useBoardRealtime.js';
import { useBoardStore } from './useBoardStore.js';
import type { CardEntity } from '@repo/shared';

const encoder = new TextEncoder();

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let streamControllers: Array<{ push(chunk: Uint8Array): void; close(): void }> = [];

function createMockFetch() {
  fetchCalls = [];
  streamControllers = [];

  return vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    const chunks: Uint8Array[] = [];
    let closed = false;
    let resolveNext: (() => void) | null = null;

    const reader = {
      async read() {
        while (true) {
          if (chunks.length > 0) return { done: false, value: chunks.shift()! };
          if (closed) return { done: true, value: undefined };
          await new Promise<void>((r) => { resolveNext = r; });
        }
      },
      releaseLock() {},
    };

    const stream = {
      getReader: () => reader,
    };

    streamControllers.push({
      push(chunk: Uint8Array) { chunks.push(chunk); resolveNext?.(); },
      close() { closed = true; resolveNext?.(); },
    });

    return {
      ok: true,
      body: stream,
    } as unknown as Response;
  });
}

vi.stubGlobal('fetch', createMockFetch());

const mockBoardId = '550e8400-e29b-41d4-a716-446655440000';

const mockCard: CardEntity = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: mockBoardId,
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

function sseChunk(id: string, event: string, data: unknown) {
  return encoder.encode(
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

describe('useBoardRealtime', () => {
  let store: ReturnType<typeof useBoardStore>;
  let realtime: ReturnType<typeof useBoardRealtime>;

  beforeEach(() => {
    store = useBoardStore();
    store.resetStore();
    realtime = useBoardRealtime(mockBoardId);
    fetchCalls = [];
    streamControllers = [];
    vi.mocked(fetch).mockImplementation(createMockFetch());
  });

  afterEach(() => {
    realtime.disconnect();
    store.resetStore();
    vi.useRealTimers();
  });

  describe('connection lifecycle', () => {
    it('starts with idle status', () => {
      expect(realtime.status.value).toBe('idle');
    });

    it('connect calls fetch with correct URL', async () => {
      void realtime.connect();
      await flushPromises();

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain(`/api/boards/${mockBoardId}/stream`);
    });

    it('status changes to connecting then connected', async () => {
      void realtime.connect();
      await flushPromises();
      expect(realtime.status.value).toBe('connected');
    });

    it('status becomes disconnected after stream closes', async () => {
      void realtime.connect();
      await flushPromises();
      expect(realtime.status.value).toBe('connected');

      streamControllers[0].close();
      await flushPromises();
      expect(realtime.status.value).toBe('disconnected');
    });

    it('disconnect resets status to idle', async () => {
      void realtime.connect();
      await flushPromises();
      realtime.disconnect();
      expect(realtime.status.value).toBe('idle');
    });
  });

  describe('event application', () => {
    beforeEach(() => {
      store.hydrate({
        board: {
          uid: mockBoardId,
          title: 'Test Board',
          prefix: 'TST',
          schema: {
            columns: [
              { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: {}, order: 0 },
              { uid: 'done', title: 'Done', type: 'Normal', processor_id: 'default-manual', exit_logic: {}, order: 1 },
            ],
          },
          permissions: { read: [], write: [] },
          created_at: '2026-04-26T08:30:00.000Z',
          updated_at: '2026-04-26T08:30:00.000Z',
        },
        cards: [mockCard],
      });
    });

    it('applies CARD_CREATED by adding card to store', async () => {
      void realtime.connect();
      await flushPromises();

      const newCard = { ...mockCard, uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45fa', current_status: 'done' as const };
      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440001', 'CARD_CREATED', {
          event_id: '550e8400-e29b-41d4-a716-446655440001',
          board_uid: mockBoardId,
          actor: 'alice',
          timestamp: '2026-04-27T00:00:00.000Z',
          card: newCard,
        }),
      );
      await flushPromises();

      expect(store.store.value.cardsById.has('a601f5b3-f91b-4ce0-b562-f4a11fcb45fa')).toBe(true);
      const doneIds = store.store.value.columnCardIds.get('done') ?? [];
      expect(doneIds).toContain('a601f5b3-f91b-4ce0-b562-f4a11fcb45fa');
    });

    it('applies CARD_UPDATED by updating existing card', async () => {
      void realtime.connect();
      await flushPromises();

      const updatedCard = { ...mockCard, title: 'Updated Title' };
      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440002', 'CARD_UPDATED', {
          event_id: '550e8400-e29b-41d4-a716-446655440002',
          board_uid: mockBoardId,
          actor: 'alice',
          timestamp: '2026-04-27T00:00:00.000Z',
          card: updatedCard,
          changed_fields: ['title'],
        }),
      );
      await flushPromises();

      expect(store.store.value.cardsById.get(mockCard.uid)?.title).toBe('Updated Title');
    });

    it('applies CARD_MOVED by moving card between columns', async () => {
      void realtime.connect();
      await flushPromises();

      const movedCard = { ...mockCard, current_status: 'done' as const };
      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440003', 'CARD_MOVED', {
          event_id: '550e8400-e29b-41d4-a716-446655440003',
          board_uid: mockBoardId,
          actor: 'alice',
          timestamp: '2026-04-27T00:00:00.000Z',
          card: movedCard,
          from_column: 'backlog',
          to_column: 'done',
        }),
      );
      await flushPromises();

      expect(store.store.value.cardsById.get(mockCard.uid)?.current_status).toBe('done');
      const backlogIds = store.store.value.columnCardIds.get('backlog') ?? [];
      expect(backlogIds).not.toContain(mockCard.uid);
      const doneIds = store.store.value.columnCardIds.get('done') ?? [];
      expect(doneIds).toContain(mockCard.uid);
    });

    it('does not duplicate cards on replayed CARD_CREATED', async () => {
      void realtime.connect();
      await flushPromises();

      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440004', 'CARD_CREATED', {
          event_id: '550e8400-e29b-41d4-a716-446655440004',
          board_uid: mockBoardId,
          actor: 'alice',
          timestamp: '2026-04-27T00:00:00.000Z',
          card: mockCard,
        }),
      );
      await flushPromises();

      const backlogIds = store.store.value.columnCardIds.get('backlog') ?? [];
      const occurrences = backlogIds.filter((id) => id === mockCard.uid).length;
      expect(occurrences).toBe(1);
    });

    it('ignores stale streamed events with lower version', async () => {
      void realtime.connect();
      await flushPromises();

      const staleCard = { ...mockCard, version: 0, title: 'Stale Title' };
      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440005', 'CARD_UPDATED', {
          event_id: '550e8400-e29b-41d4-a716-446655440005',
          board_uid: mockBoardId,
          actor: 'alice',
          timestamp: '2026-04-27T00:00:00.000Z',
          card: staleCard,
          changed_fields: ['title'],
        }),
      );
      await flushPromises();

      expect(store.store.value.cardsById.get(mockCard.uid)?.title).toBe('Test Card');
    });
  });

  describe('BOARD_RELOAD', () => {
    it('triggers onReload callback', async () => {
      const onReload = vi.fn();
      const rt = useBoardRealtime(mockBoardId, { onReload });
      void rt.connect();
      await flushPromises();

      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440006', 'BOARD_RELOAD', {
          event_id: '550e8400-e29b-41d4-a716-446655440006',
          board_uid: mockBoardId,
          reason: 'BUFFER_MISS',
          timestamp: '2026-04-27T00:00:00.000Z',
        }),
      );
      await flushPromises();

      expect(onReload).toHaveBeenCalled();
      rt.disconnect();
    });

    it('triggers onReload callback for ROLLUP_CHANGED events', async () => {
      const onReload = vi.fn();
      const rt = useBoardRealtime(mockBoardId, { onReload });
      void rt.connect();
      await flushPromises();

      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440007', 'ROLLUP_CHANGED', {
          event_id: '550e8400-e29b-41d4-a716-446655440007',
          board_uid: mockBoardId,
          actor: 'system:relationship',
          timestamp: '2026-04-27T00:03:00.000Z',
          parent_card_uid: mockCard.uid,
          parent_card: {
            uid: mockCard.uid,
            board_uid: mockBoardId,
            display_id: 'TST-1',
            status: 'backlog',
            title: 'Test Card',
          },
          completed_children: 2,
          total_children: 4,
          health_score: 50,
        }),
      );
      await flushPromises();

      expect(onReload).toHaveBeenCalled();
      rt.disconnect();
    });
  });

  describe('reconnect behavior', () => {
    it('preserves lastEventId in reconnect headers', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      void realtime.connect();
      await flushPromises();

      streamControllers[0].push(
        sseChunk('550e8400-e29b-41d4-a716-446655440007', 'CARD_CREATED', {
          event_id: '550e8400-e29b-41d4-a716-446655440007',
          board_uid: mockBoardId,
          actor: 'alice',
          timestamp: '2026-04-27T00:00:00.000Z',
          card: mockCard,
        }),
      );
      await flushPromises();

      expect(realtime.lastEventId.value).toBe('550e8400-e29b-41d4-a716-446655440007');

      streamControllers[0].close();
      await flushPromises();

      vi.advanceTimersByTime(1100);
      await flushPromises();

      expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
      const lastInit = fetchCalls[fetchCalls.length - 1].init;
      expect(lastInit?.headers).toMatchObject({
        'Last-Event-ID': '550e8400-e29b-41d4-a716-446655440007',
      });
    });

    it('uses exponential backoff with capped delay', async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

      void realtime.connect();
      await flushPromises();
      expect(realtime.status.value).toBe('disconnected');
      expect(realtime.reconnectAttempt.value).toBe(1);

      vi.advanceTimersByTime(1100);
      await flushPromises();
      expect(realtime.reconnectAttempt.value).toBe(2);

      vi.advanceTimersByTime(2100);
      await flushPromises();
      expect(realtime.reconnectAttempt.value).toBe(3);

      vi.advanceTimersByTime(4100);
      await flushPromises();
      expect(realtime.reconnectAttempt.value).toBe(4);

      vi.advanceTimersByTime(8100);
      await flushPromises();
      expect(realtime.reconnectAttempt.value).toBe(5);
    });
  });
});
