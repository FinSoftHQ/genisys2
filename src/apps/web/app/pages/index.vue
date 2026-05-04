<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import type { CreateBoardRequest, CreateBoardResponse, CreateBoardSuiteRequest, BoardSuiteResponse } from '@repo/shared';
import { useBoardsList } from '~/composables/useBoardsList';
import { useSuitesList } from '~/composables/useSuitesList';
import { KANBAN_HOME_UI_CONSTRAINTS } from '~/contracts/kanban-home.contract';
import HomeSuiteQuickAccessCard from '~/components/home/HomeSuiteQuickAccessCard.vue';
import HomeBoardQuickAccessCard from '~/components/home/HomeBoardQuickAccessCard.vue';

definePageMeta({ layout: 'default' });

const router = useRouter();
const toast = useToast();

const { boards, isLoading: isLoadingBoards, error: boardsError, refreshBoards } = useBoardsList();
const { suites, isLoading: isLoadingSuites, error: suitesError, refreshSuites } = useSuitesList();

// Create board form state
const createForm = ref({
  title: '',
  prefix: '',
  template: 'default' as 'default' | 'development',
});

// Create suite form state
const createSuiteForm = ref({
  title: '',
  template: 'default' as 'default' | 'development',
});

const isCreating = ref(false);
const isCreatingSuite = ref(false);

// UUID fallback
const uuidFallbackOpen = ref(false);
const uuidBoardId = ref('');

// Browse search
const searchQuery = ref('');

const normalizedSearch = computed(() => searchQuery.value.trim().toLowerCase());

const standaloneBoards = computed(() => boards.value.filter((b) => !b.suite_uid));

const filteredSuites = computed(() => {
  if (!normalizedSearch.value) return suites.value;
  return suites.value.filter((suite) => {
    if (suite.suite.title.toLowerCase().includes(normalizedSearch.value)) return true;
    return suite.boards.some(
      (board) =>
        board.title.toLowerCase().includes(normalizedSearch.value) ||
        board.prefix?.toLowerCase().includes(normalizedSearch.value)
    );
  });
});

const filteredStandaloneBoards = computed(() => {
  if (!normalizedSearch.value) return standaloneBoards.value;
  return standaloneBoards.value.filter(
    (board) =>
      board.title.toLowerCase().includes(normalizedSearch.value) ||
      board.prefix?.toLowerCase().includes(normalizedSearch.value)
  );
});

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

  if (title.length > KANBAN_HOME_UI_CONSTRAINTS.boardTitle.maxLength) {
    toast.add({
      title: 'Title too long',
      description: `Board title must not exceed ${KANBAN_HOME_UI_CONSTRAINTS.boardTitle.maxLength} characters.`,
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
    return;
  }

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

  if (title.length > KANBAN_HOME_UI_CONSTRAINTS.suiteTitle.maxLength) {
    toast.add({
      title: 'Title too long',
      description: `Suite title must not exceed ${KANBAN_HOME_UI_CONSTRAINTS.suiteTitle.maxLength} characters.`,
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
    return;
  }

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

function goToBoard() {
  const id = uuidBoardId.value.trim();
  if (id) {
    router.push(`/boards/${id}`);
  }
}

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
        <!-- Quick Actions -->
        <section aria-label="Quick Actions">
          <UCard>
            <template #header>
              <h2 class="text-lg font-semibold">Quick Actions</h2>
            </template>

            <div class="flex flex-col gap-6">
              <!-- Create Suite -->
              <UForm :state="createSuiteForm" @submit="onCreateSuite" class="flex flex-col gap-4">
                <h3 class="text-sm font-medium">Create Suite</h3>
                <UFormField name="title" label="Title">
                  <UInput v-model="createSuiteForm.title" placeholder="New Suite" :maxlength="KANBAN_HOME_UI_CONSTRAINTS.suiteTitle.maxLength" class="w-full" />
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

                <UButton type="submit" icon="i-lucide-layers" block :loading="isCreatingSuite">
                  Create Suite
                </UButton>
              </UForm>

              <div class="border-t border-default" />

              <!-- Create Board -->
              <UForm :state="createForm" @submit="onCreateBoard" class="flex flex-col gap-4">
                <h3 class="text-sm font-medium">Create Board</h3>
                <UFormField name="title" label="Title">
                  <UInput v-model="createForm.title" placeholder="New Board" :maxlength="KANBAN_HOME_UI_CONSTRAINTS.boardTitle.maxLength" class="w-full" />
                </UFormField>

                <UFormField name="prefix" label="Prefix (optional)">
                  <UInput v-model="createForm.prefix" placeholder="Auto-generated" class="w-full" />
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

                <UButton type="submit" icon="i-lucide-plus" block :loading="isCreating">
                  Create Board
                </UButton>
              </UForm>
            </div>
          </UCard>
        </section>

        <!-- Browse -->
        <section aria-label="Browse">
          <UCard>
            <template #header>
              <h2 class="text-lg font-semibold">Browse</h2>
            </template>

            <div class="flex flex-col gap-4">
              <UInput
                v-model="searchQuery"
                placeholder="Search suites and boards..."
                aria-label="Search"
                class="w-full"
              />

              <div v-if="isLoadingBoards || isLoadingSuites" class="flex items-center justify-center py-8" role="status" aria-label="Loading">
                <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-muted" />
              </div>

              <div v-else-if="boardsError || suitesError" class="text-center py-8 text-error" role="alert">
                {{ boardsError || suitesError }}
              </div>

              <div v-else-if="filteredSuites.length === 0 && filteredStandaloneBoards.length === 0" class="text-center py-8 text-muted">
                No boards yet. Create one above!
              </div>

              <div v-else class="flex flex-col gap-6">
                <!-- Suites -->
                <div v-if="filteredSuites.length > 0">
                  <h3 class="text-sm font-semibold text-muted mb-3 uppercase tracking-wide">Suites</h3>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <HomeSuiteQuickAccessCard
                      v-for="suite in filteredSuites"
                      :key="suite.suite.uid"
                      :suite="suite"
                    />
                  </div>
                </div>

                <!-- Standalone Boards -->
                <div v-if="filteredStandaloneBoards.length > 0">
                  <h3 class="text-sm font-semibold text-muted mb-3 uppercase tracking-wide">Standalone Boards</h3>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <HomeBoardQuickAccessCard
                      v-for="board in filteredStandaloneBoards"
                      :key="board.uid"
                      :board="board"
                    />
                  </div>
                </div>
              </div>
            </div>
          </UCard>
        </section>

        <!-- UUID Fallback -->
        <section aria-label="UUID Fallback">
          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h2 class="text-lg font-semibold">Open Board by UUID</h2>
                <UButton
                  type="button"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-chevron-down"
                  @click="uuidFallbackOpen = !uuidFallbackOpen"
                />
              </div>
            </template>

            <div v-if="uuidFallbackOpen" class="flex flex-col gap-4">
              <UForm :state="{ boardId: uuidBoardId }" @submit="goToBoard" class="flex flex-col gap-4">
                <UFormField name="boardId" label="Board ID" required>
                  <UInput v-model="uuidBoardId" placeholder="Enter board UUID" class="w-full" />
                </UFormField>
                <UButton type="submit" icon="i-lucide-layout-kanban" block>
                  Open Board
                </UButton>
              </UForm>
            </div>
          </UCard>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
