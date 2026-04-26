<script setup lang="ts">
import type { CardEntity } from '@repo/shared';

const props = defineProps<{
  card: CardEntity;
}>();

const emit = defineEmits<{
  (e: 'edit', card: CardEntity): void;
}>();

function onDragStart(event: DragEvent) {
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', props.card.uid);
    event.dataTransfer.effectAllowed = 'move';
  }
}
</script>

<template>
  <UCard
    :ui="{ root: 'cursor-grab active:cursor-grabbing bg-white dark:bg-gray-900', body: 'p-3' }"
    draggable="true"
    @dragstart="onDragStart"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="flex-1 min-w-0">
        <p class="font-medium text-sm text-default truncate">{{ card.title }}</p>
        <p v-if="card.description" class="text-xs text-muted mt-1 line-clamp-2">{{ card.description }}</p>
      </div>
      <UButton
        v-if="card.is_editable"
        icon="i-lucide-pencil"
        variant="ghost"
        color="neutral"
        size="xs"
        class="shrink-0"
        @click="emit('edit', card)"
      />
    </div>
    <div class="flex items-center gap-2 mt-2">
      <UBadge variant="subtle" size="xs">{{ card.display_id }}</UBadge>
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
