<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { CreateBoardRequest, CreateBoardResponse } from '@repo/shared';
import { useBoardsList } from '~/composables/useBoardsList';

definePageMeta({ layout: 'default' });

const router = useRouter();
const boardId = ref('');
const isCreating = ref(false);
const { boards, isLoading: isLoadingBoards } = useBoardsList();

function goToBoard() {
  const id = boardId.value.trim();
  if (id) {
    router.push(`/boards/${id}`);
  }
}

async function createBoard(template: 'default' | 'development') {
  isCreating.value = true;
  try {
    const body: CreateBoardRequest = { template };
    const response = await $fetch<CreateBoardResponse>('/api/boards', {
      method: 'POST',
      body,
    });
    await router.push(`/boards/${response.data.board.uid}`);
  } catch {
    // Optionally: show error toast here
  } finally {
    isCreating.value = false;
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Home" />
    </template>

    <template #body>
      <div class="flex flex-col gap-8 p-4">
        <!-- Open Board -->
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold">Open Board</h2>
          </template>
          <UForm :state="{ boardId }" @submit="goToBoard" class="flex flex-col gap-4">
            <UFormField name="boardId" label="Board ID" required>
              <UInput v-model="boardId" placeholder="Enter board UUID" class="w-full" />
            </UFormField>
            <UButton type="submit" icon="i-lucide-layout-kanban" block>
              Open Board
            </UButton>
          </UForm>
        </UCard>

        <!-- Create Board -->
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold">Create New Board</h2>
          </template>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UButton
              color="neutral"
              variant="subtle"
              icon="i-lucide-plus"
              class="h-24 flex-col gap-2"
              block
              :loading="isCreating"
              @click="createBoard('default')"
            >
              <span class="font-semibold">Default</span>
              <span class="text-xs text-muted">Backlog → TODO → In Progress → Done</span>
            </UButton>
            <UButton
              color="neutral"
              variant="subtle"
              icon="i-lucide-code"
              class="h-24 flex-col gap-2"
              block
              :loading="isCreating"
              @click="createBoard('development')"
            >
              <span class="font-semibold">Development</span>
              <span class="text-xs text-muted">Backlog → TODO → In Progress → Review → Done</span>
            </UButton>
          </div>
        </UCard>

        <!-- Recent Boards -->
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold">Boards</h2>
          </template>

          <div v-if="isLoadingBoards" class="flex items-center justify-center py-8">
            <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-muted" />
          </div>

          <div v-else-if="boards.length === 0" class="text-center py-8 text-muted">
            No boards yet. Create one above!
          </div>

          <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <NuxtLink
              v-for="board in boards"
              :key="board.uid"
              :to="`/boards/${board.uid}`"
              class="group"
            >
              <UCard class="hover:bg-elevated transition-colors">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <UIcon name="i-lucide-layout-kanban" class="size-5 text-primary" />
                    <div>
                      <p class="font-semibold">{{ board.title }}</p>
                      <p class="text-xs text-muted">{{ board.prefix }} &middot; {{ board.schema.columns.length }} columns</p>
                    </div>
                  </div>
                  <UIcon name="i-lucide-chevron-right" class="size-4 text-muted group-hover:text-default transition-colors" />
                </div>
              </UCard>
            </NuxtLink>
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
