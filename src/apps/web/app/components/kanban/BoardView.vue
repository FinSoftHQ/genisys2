<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { CardEntity, SnapshotResponse, MoveCardRequest, MoveCardResponse } from '@repo/shared';
import { useBoardStore } from '~/composables/useBoardStore';
import { parseApiError, parseMoveBlockedError } from '~/utils/api-error';
import BoardColumn from './BoardColumn.vue';
import CreateCardModal from './CreateCardModal.vue';
import EditCardModal from './EditCardModal.vue';

const props = defineProps<{
  boardUid: string;
}>();

const {
  store,
  sortedColumns,
  setSaving,
  setError,
  updateCard,
  moveCardLocal,
  getCardsForColumn,
  getCardById,
  hydrate,
  startPolling,
  stopPolling,
} = useBoardStore();

const toast = useToast();

const createModalOpen = ref(false);
const createColumnUid = ref('');

const editModalOpen = ref(false);
const editingCardId = ref<string | null>(null);
const editingCard = computed<CardEntity | null>(() => {
  if (!editingCardId.value) return null;
  return getCardById(editingCardId.value) ?? null;
});

function onCreateCard(columnUid: string) {
  createColumnUid.value = columnUid;
  createModalOpen.value = true;
}

function onEditCard(card: CardEntity) {
  editingCardId.value = card.uid;
  editModalOpen.value = true;
}

async function onDropCard({ cardId, toColumnUid }: { cardId: string; toColumnUid: string }) {
  const originalCard = store.value.cardsById.get(cardId);
  if (!originalCard || originalCard.current_status === toColumnUid) return;

  // Optimistic local update
  moveCardLocal(cardId, toColumnUid);
  setSaving(true);
  setError(null);

  try {
    const response = await $fetch<MoveCardResponse>(`/api/boards/${props.boardUid}/cards/${cardId}/move`, {
      method: 'POST',
      body: { to_column_uid: toColumnUid } satisfies MoveCardRequest,
    });
    updateCard(response.data.card);
  } catch (err: unknown) {
    const blocked = parseMoveBlockedError(err);
    if (blocked) {
      toast.add({
        title: 'Move blocked',
        description: blocked.error.message,
        color: 'error',
        icon: 'i-lucide-ban',
      });
    } else {
      const apiErr = parseApiError(err);
      setError(apiErr?.error.message || 'Failed to move card');
    }

    // Revert on failure
    if (originalCard) {
      moveCardLocal(cardId, originalCard.current_status);
    }
  } finally {
    setSaving(false);
  }
}

async function refreshSnapshot() {
  setSaving(true);
  try {
    const response = await $fetch<SnapshotResponse>(`/api/boards/${props.boardUid}/snapshot`);
    hydrate(response.data);
  } catch (err: unknown) {
    const apiErr = parseApiError(err);
    setError(apiErr?.error.message || 'Failed to refresh board');
  } finally {
    setSaving(false);
  }
}

const POLL_INTERVAL_MS = 2000;

watch(
  () => Array.from(store.value.cardsById.values()).some((c) => c.processing_state === 'PROCESSING'),
  (hasProcessing) => {
    if (hasProcessing) {
      startPolling(refreshSnapshot, POLL_INTERVAL_MS);
    } else {
      stopPolling();
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  stopPolling();
});
</script>

<template>
  <div class="flex flex-col h-full">
    <UPageHeader
      v-if="store.board"
      :title="store.board.title"
      :description="`Prefix: ${store.board.prefix}`"
      class="px-4 py-4 shrink-0"
    >
      <template #right>
        <UBadge
          v-if="store.ui.isSaving"
          color="info"
          variant="soft"
          class="animate-pulse"
        >
          Saving...
        </UBadge>
      </template>
    </UPageHeader>

    <UAlert
      v-if="store.ui.error"
      icon="i-lucide-alert-circle"
      color="error"
      variant="soft"
      class="mx-4 mb-4 shrink-0"
      :title="store.ui.error"
    />

    <UPageBody class="flex-1 overflow-x-auto overflow-y-hidden px-4 pb-4">
      <div class="flex gap-6 h-full">
        <BoardColumn
          v-for="column in sortedColumns"
          :key="column.uid"
          :column="column"
          :cards="getCardsForColumn(column.uid)"
          :board-uid="boardUid"
          @create="onCreateCard"
          @edit="onEditCard"
          @drop-card="onDropCard"
        />
      </div>
    </UPageBody>

    <CreateCardModal
      v-model:open="createModalOpen"
      :column-uid="createColumnUid"
      :board-uid="boardUid"
      @created="refreshSnapshot"
    />

    <EditCardModal
      v-model:open="editModalOpen"
      :card="editingCard"
      :board-uid="boardUid"
      @updated="refreshSnapshot"
    />
  </div>
</template>
