import { ref, computed } from 'vue';
import type { BoardEntity, CardEntity, ColumnUidSchema } from '@repo/shared';
import type { z } from 'zod';

type ColumnUid = z.infer<typeof ColumnUidSchema>;

interface BoardStore {
  board: BoardEntity | null;
  cardsById: Map<string, CardEntity>;
  columnCardIds: Map<string, string[]>;
  ui: {
    isLoading: boolean;
    isSaving: boolean;
    error: string | null;
    draggedCardId: string | null;
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
  },
});

export function useBoardStore() {
  const sortedColumns = computed(() => {
    if (!store.value.board) return [];
    return [...store.value.board.schema.columns].sort((a, b) => a.order - b.order);
  });

  function resetStore() {
    store.value = {
      board: null,
      cardsById: new Map(),
      columnCardIds: new Map(),
      ui: {
        isLoading: false,
        isSaving: false,
        error: null,
        draggedCardId: null,
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
    store.value.cardsById.set(card.uid, card);
    const list = store.value.columnCardIds.get(card.current_status) ?? [];
    list.push(card.uid);
    store.value.columnCardIds.set(card.current_status, list);
  }

  function updateCard(card: CardEntity) {
    const existing = store.value.cardsById.get(card.uid);
    store.value.cardsById.set(card.uid, card);

    if (existing && existing.current_status !== card.current_status) {
      const oldList = store.value.columnCardIds.get(existing.current_status) ?? [];
      const newOldList = oldList.filter((id) => id !== card.uid);
      store.value.columnCardIds.set(existing.current_status, newOldList);

      const newList = store.value.columnCardIds.get(card.current_status) ?? [];
      newList.push(card.uid);
      store.value.columnCardIds.set(card.current_status, newList);
    }
  }

  function moveCardLocal(cardId: string, toColumnUid: string) {
    const card = store.value.cardsById.get(cardId);
    if (!card) return;
    if (card.current_status === toColumnUid) return;

    const oldList = store.value.columnCardIds.get(card.current_status) ?? [];
    const newOldList = oldList.filter((id) => id !== cardId);
    store.value.columnCardIds.set(card.current_status, newOldList);

    const newList = store.value.columnCardIds.get(toColumnUid) ?? [];
    newList.push(cardId);
    store.value.columnCardIds.set(toColumnUid, newList);

    store.value.cardsById.set(cardId, { ...card, current_status: toColumnUid as ColumnUid });
  }

  function setDraggedCardId(cardId: string | null) {
    store.value.ui.draggedCardId = cardId;
  }

  function getCardsForColumn(columnUid: string): CardEntity[] {
    const ids = store.value.columnCardIds.get(columnUid) ?? [];
    return ids.map((id) => store.value.cardsById.get(id)).filter(Boolean) as CardEntity[];
  }

  return {
    store,
    sortedColumns,
    resetStore,
    setLoading,
    setSaving,
    setError,
    hydrate,
    addCard,
    updateCard,
    moveCardLocal,
    setDraggedCardId,
    getCardsForColumn,
  };
}
