<script setup lang="ts">
import { onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import type { SnapshotResponse } from '@repo/shared';
import { useBoardStore } from '~/composables/useBoardStore';
import BoardView from '~/components/kanban/BoardView.vue';

definePageMeta({ layout: 'default' });

const route = useRoute();
const boardId = route.params.boardId as string;

const { store, setLoading, setError, hydrate, resetStore } = useBoardStore();

const boardTitle = computed(() => store.value.board?.title ?? 'Board');

async function loadSnapshot() {
  resetStore();
  setLoading(true);
  setError(null);
  try {
    const response = await $fetch<SnapshotResponse>(`/api/boards/${boardId}/snapshot`);
    hydrate(response.data);
  } catch (err: any) {
    setError(err?.data?.error?.message || 'Failed to load board');
  } finally {
    setLoading(false);
  }
}

onMounted(() => {
  loadSnapshot();
});
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="boardTitle">
        <template #left>
          <UBreadcrumb
            :items="[
              { label: 'Home', to: '/', icon: 'i-lucide-home' },
              { label: boardTitle },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="store.ui.isLoading" class="flex items-center justify-center h-full">
        <UIcon name="i-lucide-loader-2" class="size-8 animate-spin text-muted" />
      </div>

      <UAlert
        v-else-if="store.ui.error && !store.board"
        icon="i-lucide-alert-triangle"
        color="error"
        variant="soft"
        class="m-8"
        title="Error"
        :description="store.ui.error"
      >
        <template #actions>
          <UButton variant="outline" @click="loadSnapshot">Retry</UButton>
        </template>
      </UAlert>

      <BoardView
        v-else-if="store.board"
        :board-uid="boardId"
      />
    </template>
  </UDashboardPanel>
</template>
