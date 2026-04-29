<script setup lang="ts">
import { onMounted, computed, ref, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import type { SnapshotResponse, UpdateBoardResponse } from '@repo/shared';
import { useBoardStore } from '~/composables/useBoardStore';
import { useBoardsList } from '~/composables/useBoardsList';
import BoardView from '~/components/kanban/BoardView.vue';

definePageMeta({ layout: 'default' });

const route = useRoute();
const boardId = route.params.boardId as string;
const toast = useToast();

const { store, setLoading, setError, hydrate, resetStore } = useBoardStore();
const { refreshBoards } = useBoardsList();

const isEditingTitle = ref(false);
const editTitle = ref('');
const titleInputRef = ref<HTMLInputElement | null>(null);

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

function startEditingTitle() {
  if (!store.value.board) return;
  editTitle.value = store.value.board.title;
  isEditingTitle.value = true;
  nextTick(() => {
    titleInputRef.value?.focus();
  });
}

async function saveTitle() {
  if (!isEditingTitle.value || !store.value.board) return;
  const newTitle = editTitle.value.trim();
  isEditingTitle.value = false;

  if (!newTitle || newTitle === store.value.board.title) return;

  try {
    const response = await $fetch<UpdateBoardResponse>(`/api/boards/${boardId}`, {
      method: 'PATCH',
      body: { title: newTitle },
    });
    store.value.board = response.data.board;
    await refreshBoards();
  } catch (err: any) {
    toast.add({
      title: 'Failed to rename',
      description: err?.data?.error?.message || 'Could not update board title',
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
  }
}

function onTitleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    saveTitle();
  } else if (e.key === 'Escape') {
    isEditingTitle.value = false;
  }
}

onMounted(() => {
  loadSnapshot();
});
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar>
        <template #left>
          <UBreadcrumb
            :items="[
              { label: 'Home', to: '/', icon: 'i-lucide-home' },
              { label: boardTitle },
            ]"
          />
        </template>
        <template #default>
          <div v-if="isEditingTitle" class="flex items-center gap-2">
            <UInput
              ref="titleInputRef"
              v-model="editTitle"
              size="lg"
              class="w-64"
              @blur="saveTitle"
              @keydown="onTitleKeydown"
            />
          </div>
          <h1
            v-else
            class="text-lg font-semibold cursor-pointer hover:text-primary transition-colors"
            :title="'Click to rename'"
            @click="startEditingTitle"
          >
            {{ boardTitle }}
            <UIcon name="i-lucide-pencil" class="size-3.5 ml-1 text-muted inline" />
          </h1>
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
