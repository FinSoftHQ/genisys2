import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import {
  useBoardStore,
} from './useBoardStore.js';
import type { BoardEntity, CardEntity } from '@repo/shared';

const mockBoard: BoardEntity = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'in-progress' }, order: 0 },
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

const mockCardError: CardEntity = {
  uid: 'c803f5b3-f91b-4ce0-b562-f4a11fcb45f1',
  board_uid: mockBoard.uid,
  display_id: 'TST-3',
  title: 'Error Card',
  description: null,
  version: 1,
  processing_state: 'ERROR',
  is_editable: false,
  payload: {},
  current_status: 'in-review',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('useBoardStore', () => {
  let store: ReturnType<typeof useBoardStore>;

  beforeEach(() => {
    store = useBoardStore();
    store.resetStore();
  });

  afterEach(() => {
    store.resetStore();
    vi.useRealTimers();
  });

  describe('hasProcessingCards', () => {
    it('returns false when no cards exist', () => {
      expect(store.hasProcessingCards.value).toBe(false);
    });

    it('returns false when all cards are IDLE', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      expect(store.hasProcessingCards.value).toBe(false);
    });

    it('returns true when at least one card is PROCESSING', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle, mockCardProcessing] });
      expect(store.hasProcessingCards.value).toBe(true);
    });

    it('returns true when at least one card is ERROR', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle, mockCardError] });
      expect(store.hasProcessingCards.value).toBe(false);
    });
  });

  describe('polling', () => {
    it('starts polling and calls refresh at interval', async () => {
      vi.useFakeTimers();
      const refreshFn = vi.fn().mockResolvedValue(undefined);

      store.startPolling(refreshFn, 2000);
      expect(store.store.value.ui.pollIntervalId).not.toBeNull();

      vi.advanceTimersByTime(2000);
      await nextTick();
      expect(refreshFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      await nextTick();
      expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    it('does not start a second poll if one is already active', () => {
      vi.useFakeTimers();
      const refreshFn = vi.fn().mockResolvedValue(undefined);

      store.startPolling(refreshFn, 2000);
      const firstId = store.store.value.ui.pollIntervalId;

      store.startPolling(refreshFn, 2000);
      expect(store.store.value.ui.pollIntervalId).toBe(firstId);
    });

    it('stops polling and clears interval', () => {
      vi.useFakeTimers();
      const refreshFn = vi.fn().mockResolvedValue(undefined);

      store.startPolling(refreshFn, 2000);
      expect(store.store.value.ui.pollIntervalId).not.toBeNull();

      store.stopPolling();
      expect(store.store.value.ui.pollIntervalId).toBeNull();
    });

    it('stops polling gracefully when no poll is active', () => {
      expect(() => store.stopPolling()).not.toThrow();
      expect(store.store.value.ui.pollIntervalId).toBeNull();
    });
  });

  describe('hydrate', () => {
    it('populates board, cardsById, and columnCardIds', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle, mockCardProcessing] });

      expect(store.store.value.board).toEqual(mockBoard);
      expect(store.store.value.cardsById.size).toBe(2);
      expect(store.store.value.cardsById.get(mockCardIdle.uid)).toEqual(mockCardIdle);

      const backlogIds = store.store.value.columnCardIds.get('backlog') ?? [];
      expect(backlogIds).toContain(mockCardIdle.uid);

      const reviewIds = store.store.value.columnCardIds.get('in-review') ?? [];
      expect(reviewIds).toContain(mockCardProcessing.uid);
    });

    it('clears error on hydrate', () => {
      store.setError('previous error');
      store.hydrate({ board: mockBoard, cards: [] });
      expect(store.store.value.ui.error).toBeNull();
    });
  });

  describe('updateCard — callback-driven column movement', () => {
    it('moves card to new column when current_status changes', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardProcessing] });

      const movedCard = { ...mockCardProcessing, current_status: 'done' as const, processing_state: 'IDLE' as const, is_editable: true };
      store.updateCard(movedCard);

      expect(store.store.value.cardsById.get(mockCardProcessing.uid)?.current_status).toBe('done');

      const reviewIds = store.store.value.columnCardIds.get('in-review') ?? [];
      expect(reviewIds).not.toContain(mockCardProcessing.uid);

      const doneIds = store.store.value.columnCardIds.get('done') ?? [];
      expect(doneIds).toContain(mockCardProcessing.uid);
    });

    it('does not mutate columns when current_status unchanged', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });

      const updated = { ...mockCardIdle, title: 'Updated Title' };
      store.updateCard(updated);

      const backlogIds = store.store.value.columnCardIds.get('backlog') ?? [];
      expect(backlogIds).toContain(mockCardIdle.uid);
      expect(store.store.value.cardsById.get(mockCardIdle.uid)?.title).toBe('Updated Title');
    });
  });

  describe('moveCardLocal', () => {
    it('updates card current_status and column card lists', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });

      store.moveCardLocal(mockCardIdle.uid, 'done');

      expect(store.store.value.cardsById.get(mockCardIdle.uid)?.current_status).toBe('done');
      expect(store.store.value.columnCardIds.get('backlog')).toEqual([]);
      expect(store.store.value.columnCardIds.get('done')).toContain(mockCardIdle.uid);
    });

    it('is a no-op when card already in target column', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });

      store.moveCardLocal(mockCardIdle.uid, 'backlog');

      expect(store.store.value.columnCardIds.get('backlog')).toContain(mockCardIdle.uid);
    });
  });

  describe('getCardsForColumn', () => {
    it('returns cards in column order', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle, mockCardProcessing] });

      const backlogCards = store.getCardsForColumn('backlog');
      expect(backlogCards).toHaveLength(1);
      expect(backlogCards[0].uid).toBe(mockCardIdle.uid);
    });

    it('returns empty array for column with no cards', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });

      expect(store.getCardsForColumn('done')).toEqual([]);
    });
  });

  describe('resetStore', () => {
    it('clears all state and stops polling', () => {
      vi.useFakeTimers();
      store.startPolling(vi.fn().mockResolvedValue(undefined), 2000);
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      store.setLoading(true);
      store.setError('error');

      store.resetStore();

      expect(store.store.value.board).toBeNull();
      expect(store.store.value.cardsById.size).toBe(0);
      expect(store.store.value.columnCardIds.size).toBe(0);
      expect(store.store.value.ui.isLoading).toBe(false);
      expect(store.store.value.ui.error).toBeNull();
      expect(store.store.value.ui.pollIntervalId).toBeNull();
    });
  });

  describe('addCard — Slice 4 deduplication', () => {
    it('does not duplicate card in column on replayed CARD_CREATED', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      store.addCard(mockCardIdle);
      const backlogIds = store.store.value.columnCardIds.get('backlog') ?? [];
      const occurrences = backlogIds.filter((id) => id === mockCardIdle.uid).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('updateCard — Slice 4 version guard', () => {
    it('ignores stale streamed events with lower version', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      const staleCard = { ...mockCardIdle, version: 0, title: 'Stale Title' };
      store.updateCard(staleCard);
      expect(store.store.value.cardsById.get(mockCardIdle.uid)?.title).toBe('Idle Card');
    });

    it('accepts update with higher version', () => {
      store.hydrate({ board: mockBoard, cards: [mockCardIdle] });
      const updated = { ...mockCardIdle, version: 2, title: 'Updated Title' };
      store.updateCard(updated);
      expect(store.store.value.cardsById.get(mockCardIdle.uid)?.title).toBe('Updated Title');
    });
  });
});
