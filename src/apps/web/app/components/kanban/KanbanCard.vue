<script setup lang="ts">
import { computed } from 'vue';
import type { CardEntity } from '@repo/shared';

const props = defineProps<{
  card: CardEntity;
}>();

const emit = defineEmits<{
  (e: 'edit', card: CardEntity): void;
}>();

const isLocked = computed(() =>
  props.card.processing_state === 'PROCESSING' || props.card.processing_state === 'ERROR'
);

const isTaskCard = computed(() => {
  const payload = props.card.payload as Record<string, unknown> | undefined;
  return Boolean(
    payload &&
      typeof payload.parent_board_uid === 'string' &&
      typeof payload.parent_card_uid === 'string'
  );
});

const cardRootUi = computed(() => {
  const base = 'relative overflow-hidden';
  const cursor = isLocked.value
    ? 'cursor-not-allowed opacity-80'
    : 'cursor-grab active:cursor-grabbing';
  const taskCardStyle = isTaskCard.value
    ? 'border-l-4 border-l-primary/60 bg-primary/5 dark:bg-primary/10'
    : 'bg-white dark:bg-gray-900';

  return {
    root: `${base} ${cursor} ${taskCardStyle}`,
    body: 'p-3',
  };
});

function onDragStart(event: DragEvent) {
  if (isLocked.value) {
    event.preventDefault();
    return;
  }
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', props.card.uid);
    event.dataTransfer.effectAllowed = 'move';
  }
}
</script>

<template>
  <UCard
    :ui="cardRootUi"
    :draggable="!isLocked"
    @dragstart="onDragStart"
  >
    <!-- PROCESSING spinner overlay -->
    <div
      v-if="card.processing_state === 'PROCESSING'"
      class="absolute inset-0 z-10 flex items-center justify-center bg-white/60 dark:bg-gray-900/60 backdrop-blur-[1px]"
    >
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-info" />
    </div>

    <div class="flex items-start justify-between gap-2">
      <div class="flex-1 min-w-0">
        <p class="font-medium text-sm text-default truncate">{{ card.title }}</p>
        <p v-if="card.description" class="text-xs text-muted mt-1 line-clamp-2">{{ card.description }}</p>
      </div>
      <UButton
        v-if="card.is_editable && !isLocked"
        icon="i-lucide-pencil"
        variant="ghost"
        color="neutral"
        size="xs"
        class="shrink-0"
        @click="emit('edit', card)"
      />
    </div>
    <div class="flex flex-wrap items-center gap-2 mt-2">
      <UBadge variant="subtle" size="xs">{{ card.display_id }}</UBadge>
      <UBadge
        v-if="isTaskCard"
        color="primary"
        variant="subtle"
        size="xs"
      >
        Task
      </UBadge>
      <UBadge
        v-if="card.processing_state !== 'IDLE'"
        :color="card.processing_state === 'ERROR' ? 'error' : 'info'"
        variant="subtle"
        size="xs"
      >
        {{ card.processing_state }}
      </UBadge>
    </div>
  </UCard>
</template>
