<script setup lang="ts">
import { computed } from 'vue';
import type { CardEntity } from '@repo/shared';

const props = defineProps<{
  card: CardEntity;
}>();

const emit = defineEmits<{
  (e: 'edit', card: CardEntity): void;
  (e: 'delete', card: CardEntity): void;
  (e: 'view-room', card: CardEntity): void;
}>();

const isLocked = computed(() =>
  props.card.processing_state === 'PROCESSING' || props.card.processing_state === 'ERROR'
);

const isDelegated = computed(() => props.card.current_status === 'delegated');

const isTaskCard = computed(() => {
  const payload = props.card.payload;
  return payload && typeof payload.parent_card_uid === 'string';
});

const roomStatus = computed(() => {
  const payload = props.card.payload;
  if (!props.card.room_id) return null;
  const status = payload?.room_status || payload?._room_status || 'running';
  return String(status);
});

const roomBadgeColor = computed(() => {
  const status = roomStatus.value;
  if (!status) return 'neutral';
  if (status === 'completed') return 'success';
  if (status === 'error') return 'error';
  if (status === 'manual' || status === 'expired') return 'warning';
  return 'info';
});

const cardRootUi = computed(() => {
  const base = 'relative overflow-hidden';
  const cursor = isLocked.value
    ? 'cursor-not-allowed opacity-80'
    : 'cursor-grab active:cursor-grabbing';
  return {
    root: `${base} ${cursor} bg-white dark:bg-gray-900`,
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

    <!-- Delegated indicator -->
    <div
      v-if="isDelegated"
      class="absolute top-2 right-2 z-[5]"
      title="Delegated"
    >
      <UIcon name="i-lucide-git-branch" class="size-4 text-muted" />
    </div>

    <div class="flex items-start justify-between gap-2">
      <div class="flex-1 min-w-0">
        <p class="font-medium text-sm text-default truncate">{{ card.title }}</p>
        <p v-if="card.description" class="text-xs text-muted mt-1 line-clamp-2">{{ card.description }}</p>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <UButton
          v-if="card.is_editable && !isLocked"
          icon="i-lucide-pencil"
          variant="ghost"
          color="neutral"
          size="xs"
          @click="emit('edit', card)"
        />
        <UButton
          v-if="card.is_editable && !isLocked"
          icon="i-lucide-trash-2"
          variant="ghost"
          color="error"
          size="xs"
          @click="emit('delete', card)"
        />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 mt-2">
      <UBadge variant="subtle" size="xs">{{ card.display_id }}</UBadge>
      <UBadge
        v-if="card.processing_state !== 'IDLE'"
        :color="card.processing_state === 'ERROR' ? 'error' : 'info'"
        variant="subtle"
        size="xs"
      >
        {{ card.processing_state }}
      </UBadge>
      <UBadge
        v-if="isTaskCard"
        color="warning"
        variant="subtle"
        size="xs"
      >
        Task
      </UBadge>
      <UBadge
        v-if="card.room_id"
        :color="roomBadgeColor"
        variant="soft"
        size="xs"
        class="cursor-pointer"
        @click.stop="emit('view-room', card)"
      >
        <UIcon name="i-lucide-bot" class="size-3 mr-1" />
        {{ roomStatus }}
      </UBadge>
    </div>

    <!-- Family badges -->
    <div v-if="card.parents?.length || card.children?.length" class="flex flex-wrap items-center gap-2 mt-2">
      <UBadge
        v-if="card.parents?.length"
        color="neutral"
        variant="soft"
        size="xs"
        class="gap-1"
      >
        <UIcon name="i-lucide-arrow-up" class="size-3" />
        Parent: {{ card.parents?.[0]?.display_id }}
      </UBadge>
      <UBadge
        v-if="card.children?.length"
        color="neutral"
        variant="soft"
        size="xs"
        class="gap-1"
      >
        <UIcon name="i-lucide-arrow-down" class="size-3" />
        {{ card.children.length }} subtask{{ card.children.length === 1 ? '' : 's' }}
      </UBadge>
    </div>
  </UCard>
</template>
