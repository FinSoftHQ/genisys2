<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { BoardEntity } from '@repo/shared';

const props = withDefaults(
  defineProps<{
    board: BoardEntity;
    navigateOnClick?: boolean;
  }>(),
  {
    navigateOnClick: true,
  },
);

const emit = defineEmits<{
  navigate: [board: BoardEntity];
}>();

const router = useRouter();

const columnCount = computed(() => props.board.schema.columns.length);
const roleLabel = computed(() => props.board.role ?? 'board');
const roleColor = computed(() => {
  if (props.board.role === 'primary') return 'primary';
  if (props.board.role === 'tasks') return 'info';
  return 'neutral';
});

async function openBoard() {
  emit('navigate', props.board);

  if (!props.navigateOnClick) {
    return;
  }

  await router.push(`/boards/${props.board.uid}`);
}
</script>

<template>
  <UCard
    class="group h-full cursor-pointer border border-default/70 bg-elevated/70 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    role="button"
    tabindex="0"
    :aria-label="`Open board ${board.title}`"
    @click="openBoard"
    @keydown.enter.prevent="openBoard"
    @keydown.space.prevent="openBoard"
  >
    <div class="flex h-full items-start justify-between gap-4 p-4">
      <div class="min-w-0 space-y-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-layout-kanban" class="size-5 text-primary" />
          <UBadge :color="roleColor" variant="soft" size="xs" class="capitalize">
            {{ roleLabel }}
          </UBadge>
        </div>

        <div class="min-w-0">
          <h3 class="truncate text-base font-semibold text-default">
            {{ board.title }}
          </h3>
          <p class="mt-1 text-sm text-muted">
            {{ board.prefix }} · {{ columnCount }} columns
          </p>
        </div>
      </div>

      <UIcon
        name="i-lucide-arrow-right"
        class="mt-1 size-4 shrink-0 text-muted transition group-hover:text-default"
      />
    </div>
  </UCard>
</template>
