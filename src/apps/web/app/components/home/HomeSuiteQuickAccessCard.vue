<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { BoardSuiteWithBoards } from '@repo/shared';

const props = withDefaults(
  defineProps<{
    suite: BoardSuiteWithBoards;
    navigateOnClick?: boolean;
  }>(),
  {
    navigateOnClick: true,
  },
);

const emit = defineEmits<{
  navigate: [suite: BoardSuiteWithBoards];
}>();

const router = useRouter();

const primaryBoard = computed(
  () => props.suite.boards.find((board) => board.role === 'primary') ?? props.suite.boards[0] ?? null,
);

const boardCount = computed(() => props.suite.boards.length);
const primaryBoardLabel = computed(() => primaryBoard.value?.title ?? 'first board');

async function openSuite() {
  emit('navigate', props.suite);

  if (!props.navigateOnClick || !primaryBoard.value) {
    return;
  }

  await router.push(`/boards/${primaryBoard.value.uid}`);
}
</script>

<template>
  <UCard
    class="group h-full cursor-pointer border border-default/70 bg-elevated/70 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    role="button"
    tabindex="0"
    :aria-label="`Open suite ${suite.suite.title}`"
    @click="openSuite"
    @keydown.enter.prevent="openSuite"
    @keydown.space.prevent="openSuite"
  >
    <div class="flex h-full items-start justify-between gap-4 p-4">
      <div class="min-w-0 space-y-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-layers-3" class="size-5 text-primary" />
          <UBadge color="primary" variant="soft" size="xs">
            {{ boardCount }} boards
          </UBadge>
        </div>

        <div class="min-w-0">
          <h3 class="truncate text-base font-semibold text-default">
            {{ suite.suite.title }}
          </h3>
          <p class="mt-1 text-sm text-muted">
            Opens <span class="font-medium text-default">{{ primaryBoardLabel }}</span>
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
