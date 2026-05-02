<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { SnapshotResponse, UpdateBoardResponse, BoardSuiteWithBoards } from '@repo/shared';
import { useBoardStore } from '~/composables/useBoardStore';
import { useBoardsList } from '~/composables/useBoardsList';
import BoardView from '~/components/kanban/BoardView.vue';

definePageMeta({ layout: 'default' });

const route = useRoute();
const toast = useToast();

const boardId = computed(() => route.params.boardId as string);

const { store, setLoading, setError, hydrate, resetStore } = useBoardStore();
const { refreshBoards } = useBoardsList();

const isEditingTitle = ref(false);
const editTitle = ref('');
const titleInputRef = ref<HTMLInputElement | null>(null);

const suite = ref<BoardSuiteWithBoards | null>(null);
const isLoadingSuite = ref(false);

const boardTitle = computed(() => store.value.board?.title ?? 'Board');
const boardRole = computed(() => store.value.board?.role);
const boardRoleColor = computed(() => {
  const role = boardRole.value;
  if (role === 'primary') return 'primary';
  if (role === 'tasks') return 'info';
  return 'neutral';
});

function formatRoleLabel(role?: string | null) {
  if (!role) return '';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

async function loadSnapshot() {
  resetStore();
  suite.value = null;
  setLoading(true);
  setError(null);
  try {
    const response = await $fetch<SnapshotResponse>(`/api/boards/${boardId.value}/snapshot`);
    hydrate(response.data);
  } catch (err: any) {
    setError(err?.data?.error?.message || 'Failed to load board');
  } finally {
    setLoading(false);
  }
}

async function loadSuite() {
  const suiteUid = store.value.board?.suite_uid;
  if (!suiteUid) {
    suite.value = null;
    return;
  }
  isLoadingSuite.value = true;
  try {
    const response = await $fetch<{ data: BoardSuiteWithBoards }>(`/api/board-suites/${suiteUid}`);
    suite.value = response.data;
  } catch (_err) {
    // Silently fail — suite nav is optional enhancement
    suite.value = null;
  } finally {
    isLoadingSuite.value = false;
  }
}

watch(
  () => route.params.boardId,
  () => {
    loadSnapshot();
  },
  { immediate: true }
);

watch(
  () => store.value.board?.suite_uid,
  () => {
    loadSuite();
  }
);

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
    const response = await $fetch<UpdateBoardResponse>(`/api/boards/${boardId.value}`, {
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
          <div class="flex items-center gap-2">
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
            <UBadge
              v-if="boardRole"
              :color="boardRoleColor"
              variant="subtle"
              size="sm"
            >
              {{ formatRoleLabel(boardRole) }}
            </UBadge>
          </div>
        </template>
      </UDashboardNavbar>

      <!-- Suite Navigation Bar -->
      <div
        v-if="suite && suite.boards.length > 0"
        class="px-4 py-2 border-b border-default/10 bg-elevated/50"
      >
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-layers" class="size-4 text-muted" />
          <span class="text-xs text-muted font-medium">Suite:</span>
          <div class="flex items-center gap-1.5">
            <UButton
              v-for="sb in suite.boards"
              :key="sb.uid"
              :to="`/boards/${sb.uid}`"
              :variant="sb.uid === boardId ? 'solid' : 'ghost'"
              :color="sb.uid === boardId ? 'primary' : 'neutral'"
              size="xs"
            >
              {{ sb.title }}
            </UButton>
          </div>
        </div>
      </div>
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
nel>
</template>
