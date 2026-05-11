import { ref, computed } from 'vue';
import type { BoardEntity, CardEntity } from '@repo/shared';

interface BoardStore {
  board: BoardEntity | null;
  cardsById: Map<string, CardEntity>;
  columnCardIds: Map<string, string[]>;
  ui: {
    isLoading: boolean;
    isSaving: boolean;
    error: string | null;
    draggedCardId: string | null;
    pollIntervalId: ReturnType<typeof setInterval> | null;
  };
}

const store = ref<BoardStore>({
  board: null,
  cardsById: new Map(),
  columnCardIds: new Map(),
  ui: {
    isLoading: false,
    isSaving: false,
    error: null,
    draggedCardId: null,
    pollIntervalId: null,
  },
});

export function useBoardStore() {
  const sortedColumns = computed(() => {
    if (!store.value.board) return [];
    return [...store.value.board.schema.columns].sort((a, b) => a.order - b.order);
  });

  const hasProcessingCards = computed(() => {
    if (!store.value.cardsById.size) return false;
    return Array.from(store.value.cardsById.values()).some(
      (c) => c.processing_state === 'PROCESSING'
    );
  });

  function resetStore() {
    if (store.value.ui.pollIntervalId) {
      clearInterval(store.value.ui.pollIntervalId);
    }
    store.value = {
      board: null,
      cardsById: new Map(),
      columnCardIds: new Map(),
      ui: {
        isLoading: false,
        isSaving: false,
        error: null,
        draggedCardId: null,
        pollIntervalId: null,
      },
    };
  }

  function setLoading(value: boolean) {
    store.value.ui.isLoading = value;
  }

  function setSaving(value: boolean) {
    store.value.ui.isSaving = value;
  }

  function setError(error: string | null) {
    store.value.ui.error = error;
  }

  function hydrate(snapshot: { board: BoardEntity; cards: CardEntity[] }) {
    store.value.board = snapshot.board;
    store.value.cardsById = new Map(snapshot.cards.map((c) => [c.uid, c]));

    const colMap = new Map<string, string[]>();
    for (const col of snapshot.board.schema.columns) {
      colMap.set(col.uid, []);
    }
    for (const card of snapshot.cards) {
      const list = colMap.get(card.current_status) ?? [];
      list.push(card.uid);
      colMap.set(card.current_status, list);
    }
    store.value.columnCardIds = colMap;
    store.value.ui.error = null;
  }

  function addCard(card: CardEntity) {
    const nextCards = new Map(store.value.cardsById);
    nextCards.set(card.uid, card);
    store.value.cardsById = nextCards;

    const nextColumns = new Map(store.value.columnCardIds);
    const list = nextColumns.get(card.current_status) ?? [];
    if (!list.includes(card.uid)) {
      list.push(card.uid);
      nextColumns.set(card.current_status, list);
      store.value.columnCardIds = nextColumns;
    }
  }

  function updateCard(card: CardEntity) {
    const existing = store.value.cardsById.get(card.uid);
    if (existing && card.version < existing.version) {
      return;
    }

    const nextCards = new Map(store.value.cardsById);
    nextCards.set(card.uid, card);
    store.value.cardsById = nextCards;

    if (!existing) {
      const nextColumns = new Map(store.value.columnCardIds);
      const list = nextColumns.get(card.current_status) ?? [];
      if (!list.includes(card.uid)) {
        list.push(card.uid);
        nextColumns.set(card.current_status, list);
      }
      store.value.columnCardIds = nextColumns;
    } else if (existing.current_status !== card.current_status) {
      const nextColumns = new Map(store.value.columnCardIds);

      const oldList = nextColumns.get(existing.current_status) ?? [];
      nextColumns.set(existing.current_status, oldList.filter((id) => id !== card.uid));

      const newList = nextColumns.get(card.current_status) ?? [];
      if (!newList.includes(card.uid)) {
        newList.push(card.uid);
      }
      nextColumns.set(card.current_status, newList);

      store.value.columnCardIds = nextColumns;
    }
  }

  function removeCard(cardId: string) {
    const card = store.value.cardsById.get(cardId);
    if (!card) return;

    const nextCards = new Map(store.value.cardsById);
    nextCards.delete(cardId);
    store.value.cardsById = nextCards;

    const nextColumns = new Map(store.value.columnCardIds);
    const list = nextColumns.get(card.current_status) ?? [];
    nextColumns.set(card.current_status, list.filter((id) => id !== cardId));
    store.value.columnCardIds = nextColumns;
  }

  function moveCardLocal(cardId: string, toColumnUid: string) {
    const card = store.value.cardsById.get(cardId);
    if (!card) return;
    if (card.current_status === toColumnUid) return;

    const nextColumns = new Map(store.value.columnCardIds);
    const oldList = nextColumns.get(card.current_status) ?? [];
    nextColumns.set(card.current_status, oldList.filter((id) => id !== cardId));

    const newList = nextColumns.get(toColumnUid) ?? [];
    newList.push(cardId);
    nextColumns.set(toColumnUid, newList);
    store.value.columnCardIds = nextColumns;

    const nextCards = new Map(store.value.cardsById);
    nextCards.set(cardId, { ...card, current_status: toColumnUid });
    store.value.cardsById = nextCards;
  }

  function setDraggedCardId(cardId: string | null) {
    store.value.ui.draggedCardId = cardId;
  }

  function startPolling(refresh: () => Promise<void>, intervalMs = 2000) {
    if (store.value.ui.pollIntervalId) return;
    store.value.ui.pollIntervalId = setInterval(() => {
      refresh().catch(() => {});
    }, intervalMs);
  }

  function stopPolling() {
    if (store.value.ui.pollIntervalId) {
      clearInterval(store.value.ui.pollIntervalId);
      store.value.ui.pollIntervalId = null;
    }
  }

  function getCardById(cardId: string): CardEntity | undefined {
    return store.value.cardsById.get(cardId);
  }

  function getCardsForColumn(columnUid: string): CardEntity[] {
    const ids = store.value.columnCardIds.get(columnUid) ?? [];
    return ids.map((id) => store.value.cardsById.get(id)).filter(Boolean) as CardEntity[];
  }

  return {
    store,
    sortedColumns,
    hasProcessingCards,
    resetStore,
    setLoading,
    setSaving,
    setError,
    hydrate,
    addCard,
    updateCard,
    removeCard,
    moveCardLocal,
    setDraggedCardId,
    startPolling,
    stopPolling,
    getCardById,
    getCardsForColumn,
  };
}
