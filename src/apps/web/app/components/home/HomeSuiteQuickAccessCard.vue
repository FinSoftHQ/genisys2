<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { BoardSuiteWithBoards } from '@repo/shared';

const props = defineProps<{
  suite: BoardSuiteWithBoards;
}>();

const emit = defineEmits<{
  navigate: [suite: BoardSuiteWithBoards];
}>();

const router = useRouter();

function handleClick() {
  emit('navigate', props.suite);
  const primaryBoard = props.suite.boards.find((b) => b.role === 'primary');
  const targetBoardId = primaryBoard?.uid ?? props.suite.boards[0]?.uid;
  if (targetBoardId) {
    router.push(`/boards/${targetBoardId}`);
  }
}
</script>

<template>
  <UCard class="hover:bg-elevated transition-colors cursor-pointer" @click="handleClick">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-layers" class="size-5 text-primary" />
        <div>
          <p class="font-semibold">{{ suite.suite.title }}</p>
          <p class="text-xs text-muted">{{ suite.boards.length }} boards</p>
        </div>
      </div>
      <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
    </div>
  </UCard>
</template>
