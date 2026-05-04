<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import type { CreateBoardRequest, CreateBoardResponse, CreateBoardSuiteRequest, BoardSuiteResponse } from '@repo/shared';
import { useBoardsList } from '~/composables/useBoardsList';
import { useSuitesList } from '~/composables/useSuitesList';

definePageMeta({ layout: 'default' });

const router = useRouter();
const toast = useToast();

const boardId = ref('');
const isCreating = ref(false);
const isCreatingSuite = ref(false);
const { boards, isLoading: isLoadingBoards, refreshBoards } = useBoardsList();
const { suites, isLoading: isLoadingSuites, refreshSuites } = useSuitesList();

// Create board form state
const createForm = ref<{
  title: string;
  prefix: string;
  template: 'default' | 'development';
}>({
  title: '',
  prefix: '',
  template: 'default',
});

// Create suite form state
const createSuiteForm = ref<{
  title: string;
  template: 'default' | 'development';
}>({
  title: '',
  template: 'default',
});

function goToBoard() {
  const id = boardId.value.trim();
  if (id) {
    router.push(`/boards/${id}`);
  }
}

function resetCreateForm() {
  createForm.value = { title: '', prefix: '', template: 'default' };
}

function resetCreateSuiteForm() {
  createSuiteForm.value = { title: '', template: 'default' };
}

const prefixRegex = /^[A-Z][A-Z0-9]{0,9}$/;

async function onCreateBoard() {
  const title = createForm.value.title.trim() || 'New Board';
  const prefix = createForm.value.prefix.trim() || undefined;

  if (prefix && !prefixRegex.test(prefix)) {
    toast.add({
      title: 'Invalid prefix',
      description: 'Prefix must be 1–10 uppercase letters/numbers starting with a letter.',
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
    return;
  }

  isCreating.value = true;
  try {
    const body: CreateBoardRequest = {
      template: createForm.value.template,
      title,
      prefix,
    };
    const response = await $fetch<CreateBoardResponse>('/api/boards', {
      method: 'POST',
      body,
    });
    resetCreateForm();
    await router.push(`/boards/${response.data.board.uid}`);
  } catch (err: any) {
    const code = err?.data?.error?.code;
    const message = err?.data?.error?.message || 'Failed to create board';
    toast.add({
      title: code === 'PREFIX_EXISTS' ? 'Prefix taken' : 'Error',
      description: message,
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
  } finally {
    isCreating.value = false;
  }
}

async function onCreateSuite() {
  const title = createSuiteForm.value.title.trim() || 'New Suite';

  isCreatingSuite.value = true;
  try {
    const body: CreateBoardSuiteRequest = {
      template: createSuiteForm.value.template,
      title,
    };
    const response = await $fetch<BoardSuiteResponse>('/api/board-suites', {
      method: 'POST',
      body,
    });
    resetCreateSuiteForm();
    const primaryBoard = response.data.boards.find((b) => b.role === 'primary');
    const targetBoardId = primaryBoard?.uid ?? response.data.boards[0]?.uid;
    if (targetBoardId) {
      await router.push(`/boards/${targetBoardId}`);
    }
  } catch (err: any) {
    const message = err?.data?.error?.message || 'Failed to create suite';
    toast.add({
      title: 'Error',
      description: message,
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
  } finally {
    isCreatingSuite.value = false;
  }
}

const standaloneBoards = computed(() => boards.value.filter((b) => !b.suite_uid));

onMounted(() => {
  refreshBoards();
  refreshSuites();
});
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
          <UForm :state="createForm" @submit="onCreateBoard" class="flex flex-col gap-4">
            <UFormField name="title" label="Title">
              <UInput
                v-model="createForm.title"
                placeholder="New Board"
                class="w-full"
              />
            </UFormField>

            <UFormField name="prefix" label="Prefix (optional)">
              <UInput
                v-model="createForm.prefix"
                placeholder="Auto-generated"
                class="w-full"
              />
              <template #hint>
                <span class="text-xs text-muted">1–10 uppercase letters/numbers, starting with a letter</span>
              </template>
            </UFormField>

            <UFormField name="template" label="Template">
              <div class="grid grid-cols-2 gap-2">
                <UButton
                  type="button"
                  :variant="createForm.template === 'default' ? 'solid' : 'subtle'"
                  color="neutral"
                  block
                  @click="createForm.template = 'default'"
                >
                  Default
                </UButton>
                <UButton
                  type="button"
                  :variant="createForm.template === 'development' ? 'solid' : 'subtle'"
                  color="neutral"
                  block
                  @click="createForm.template = 'development'"
                >
                  Development
                </UButton>
              </div>
            </UFormField>

            <UButton
              type="submit"
              icon="i-lucide-plus"
              block
              :loading="isCreating"
            >
              Create Board
            </UButton>
          </UForm>
        </UCard>

        <!-- Create Suite -->
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold">Create Suite</h2>
          </template>
          <UForm :state="createSuiteForm" @submit="onCreateSuite" class="flex flex-col gap-4">
            <UFormField name="title" label="Title">
              <UInput
                v-model="createSuiteForm.title"
                placeholder="New Suite"
                class="w-full"
              />
            </UFormField>

            <UFormField name="template" label="Template">
              <div class="grid grid-cols-2 gap-2">
                <UButton
                  type="button"
                  :variant="createSuiteForm.template === 'default' ? 'solid' : 'subtle'"
                  color="neutral"
                  block
                  @click="createSuiteForm.template = 'default'"
                >
                  Default Suite
                </UButton>
                <UButton
                  type="button"
                  :variant="createSuiteForm.template === 'development' ? 'solid' : 'subtle'"
                  color="neutral"
                  block
                  @click="createSuiteForm.template = 'development'"
                >
                  Development Suite
                </UButton>
              </div>
            </UFormField>

            <UButton
              type="submit"
              icon="i-lucide-layers"
              block
              :loading="isCreatingSuite"
            >
              Create Suite
            </UButton>
          </UForm>
        </UCard>

        <!-- Boards List -->
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold">Boards</h2>
          </template>

          <div v-if="isLoadingBoards || isLoadingSuites" class="flex items-center justify-center py-8">
            <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-muted" />
          </div>

          <div v-else-if="suites.length === 0 && standaloneBoards.length === 0" class="text-center py-8 text-muted">
            No boards yet. Create one above!
          </div>

          <div v-else class="flex flex-col gap-6">
            <!-- Suites -->
            <div v-if="suites.length > 0">
              <h3 class="text-sm font-semibold text-muted mb-3 uppercase tracking-wide">Suites</h3>
              <div class="flex flex-col gap-4">
                <div v-for="suite in suites" :key="suite.suite.uid">
                  <p class="font-medium text-sm mb-2">{{ suite.suite.title }}</p>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <NuxtLink
                      v-for="board in suite.boards"
                      :key="board.uid"
                      :to="`/boards/${board.uid}`"
                      class="group"
                    >
                      <UCard class="hover:bg-elevated transition-colors">
                        <div class="flex items-center justify-between">
                          <div class="flex items-center gap-3">
                            <UIcon name="i-lucide-layout-kanban" class="size-5 text-primary" />
                            <div>
                              <div class="flex items-center gap-2">
                                <p class="font-semibold">{{ board.title }}</p>
                                <UBadge
                                  v-if="board.role"
                                  :color="board.role === 'primary' ? 'primary' : board.role === 'tasks' ? 'info' : 'neutral'"
                                  variant="subtle"
                                  size="xs"
                                >
                                  {{ board.role }}
                                </UBadge>
                              </div>
                              <p class="text-xs text-muted">{{ board.prefix }} &middot; {{ board.schema.columns.length }} columns</p>
                            </div>
                          </div>
                          <UIcon name="i-lucide-chevron-right" class="size-4 text-muted group-hover:text-default transition-colors" />
                        </div>
                      </UCard>
                    </NuxtLink>
                  </div>
                </div>
              </div>
            </div>

            <!-- Standalone Boards -->
            <div v-if="standaloneBoards.length > 0">
              <h3 class="text-sm font-semibold text-muted mb-3 uppercase tracking-wide">Standalone Boards</h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <NuxtLink
                  v-for="board in standaloneBoards"
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
            </div>
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
