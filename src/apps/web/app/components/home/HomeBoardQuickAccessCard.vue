<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { BoardEntity } from '@repo/shared';

const props = defineProps<{
  board: BoardEntity;
}>();

const emit = defineEmits<{
  navigate: [board: BoardEntity];
}>();

const router = useRouter();

function handleClick() {
  emit('navigate', props.board);
  router.push(`/boards/${props.board.uid}`);
}
</script>

<template>
  <UCard class="hover:bg-elevated transition-colors cursor-pointer" @click="handleClick">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-layout-kanban" class="size-5 text-primary" />
        <div>
          <p class="font-semibold">{{ board.title }}</p>
          <p class="text-xs text-muted">{{ board.prefix }} · {{ board.schema.columns.length }} columns</p>
        </div>
      </div>
      <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
    </div>
  </UCard>
</template>
