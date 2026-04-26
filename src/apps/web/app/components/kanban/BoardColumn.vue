<script setup lang="ts">
import type { BoardEntity, CardEntity } from '@repo/shared';
import KanbanCard from './KanbanCard.vue';

const props = defineProps<{
  column: BoardEntity['schema']['columns'][number];
  cards: CardEntity[];
  boardUid: string;
}>();

const emit = defineEmits<{
  (e: 'create', columnUid: string): void;
  (e: 'edit', card: CardEntity): void;
  (e: 'drop-card', payload: { cardId: string; toColumnUid: string }): void;
}>();

function onDragOver(event: DragEvent) {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  const cardId = event.dataTransfer?.getData('text/plain');
  if (cardId) {
    emit('drop-card', { cardId, toColumnUid: props.column.uid });
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-3 min-w-[280px] w-[280px] shrink-0"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div class="flex items-center justify-between px-1">
      <h3 class="font-semibold text-sm text-default">{{ column.title }}</h3>
      <UButton
        icon="i-lucide-plus"
        variant="ghost"
        color="neutral"
        size="xs"
        @click="emit('create', column.uid)"
      />
    </div>

    <div class="flex flex-col gap-2 min-h-[120px] rounded-lg p-2 bg-gray-50 dark:bg-gray-800/50">
      <KanbanCard
        v-for="card in cards"
        :key="card.uid"
        :card="card"
        @edit="emit('edit', $event)"
      />
      <p
        v-if="cards.length === 0"
        class="text-xs text-muted text-center py-8"
      >
        Drop cards here
      </p>
    </div>
  </div>
</template>
