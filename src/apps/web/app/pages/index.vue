<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type {
  BoardEntity,
  BoardSuiteResponse,
  BoardSuiteWithBoards,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateBoardSuiteRequest,
} from '@repo/shared';
import { useBoardsList } from '~/composables/useBoardsList';
import { useSuitesList } from '~/composables/useSuitesList';
import { KANBAN_HOME_UI_CONSTRAINTS } from '~/contracts/kanban-home.contract';
import HomeSuiteQuickAccessCard from '~/components/home/HomeSuiteQuickAccessCard.vue';
import HomeBoardQuickAccessCard from '~/components/home/HomeBoardQuickAccessCard.vue';

definePageMeta({ layout: 'default' });

const router = useRouter();
const toast = useToast();

const boardId = ref('');
const searchQuery = ref('');
const isUuidFallbackOpen = ref(false);
const isCreating = ref(false);
const isCreatingSuite = ref(false);

const { boards, isLoading: isLoadingBoards, error: boardsError, refreshBoards } = useBoardsList();
const { suites, isLoading: isLoadingSuites, error: suitesError, refreshSuites } = useSuitesList();

const createForm = ref<{
  title: string;
  prefix: string;
  template: 'default' | 'development';
}>({
  title: '',
  prefix: '',
  template: 'default' as 'default' | 'development',
});

const createSuiteForm = ref<{
  title: string;
  template: 'default' | 'development';
}>({
  title: '',
  template: 'default' as 'default' | 'development',
});

const normalizedSearch = computed(() => searchQuery.value.trim().toLowerCase());
const standaloneBoards = computed(() => boards.value.filter((board) => !board.suite_uid));
const browseLoading = computed(() => isLoadingBoards.value || isLoadingSuites.value);
const browseError = computed(() => boardsError.value ?? suitesError.value);
const suiteCount = computed(() => suites.value.length);
const boardCount = computed(() => boards.value.length);

function matchesSearch(board: BoardEntity, query: string) {
  if (!query) return true;
  return board.title.toLowerCase().includes(query) || board.prefix.toLowerCase().includes(query);
}

function matchesSuiteSearch(suite: BoardSuiteWithBoards, query: string) {
  if (!query) return true;
  if (suite.suite.title.toLowerCase().includes(query)) return true;
  return suite.boards.some((board) => matchesSearch(board, query));
}

const visibleSuites = computed(() => suites.value.filter((suite) => matchesSuiteSearch(suite, normalizedSearch.value)));
const visibleStandaloneBoards = computed(() => standaloneBoards.value.filter((board) => matchesSearch(board, normalizedSearch.value)));

function resolveSuiteTargetBoardUid(suite: BoardSuiteWithBoards) {
  return suite.boards.find((board) => board.role === 'primary')?.uid ?? suite.boards[0]?.uid ?? null;
}

async function navigateToSuite(suite: BoardSuiteWithBoards) {
  const targetBoardId = resolveSuiteTargetBoardUid(suite);
  if (!targetBoardId) return;
  await router.push(`/boards/${targetBoardId}`);
}

async function navigateToBoard(board: BoardEntity) {
  await router.push(`/boards/${board.uid}`);
}

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
      description: 'Prefix must be 1–10 uppercase letters/numbers, starting with a letter.',
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
    const primaryBoard = response.data.boards.find((board) => board.role === 'primary');
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
      <div class="mx-auto flex max-w-7xl flex-col gap-6 p-4 lg:p-6">
        <!-- Hero -->
        <UCard class="overflow-hidden border border-default/70 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent shadow-sm">
          <div class="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-6">
            <div class="space-y-4">
              <div class="flex flex-wrap items-center gap-2">
                <UBadge color="primary" variant="soft" size="sm">
                  Kanban Suite
                </UBadge>
                <UBadge color="neutral" variant="soft" size="sm">
                  {{ suiteCount }} suites
                </UBadge>
                <UBadge color="neutral" variant="soft" size="sm">
                  {{ boardCount }} boards
                </UBadge>
              </div>

              <div class="space-y-2">
                <h1 class="text-3xl font-semibold tracking-tight text-default sm:text-4xl">
                  Start fast, open faster.
                </h1>
                <p class="max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Create a suite or a board from the top of the page, then jump back into recent work without scrolling or UUID hunting.
                </p>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <div class="rounded-2xl border border-default/70 bg-elevated/80 p-4">
                <p class="text-xs font-medium uppercase tracking-wide text-muted">Primary flow</p>
                <p class="mt-2 text-sm font-semibold text-default">Create suite first</p>
                <p class="mt-1 text-sm text-muted">Most common workspace setup surfaced above the fold.</p>
              </div>
              <div class="rounded-2xl border border-default/70 bg-elevated/80 p-4">
                <p class="text-xs font-medium uppercase tracking-wide text-muted">Fast access</p>
                <p class="mt-2 text-sm font-semibold text-default">Browse boards by name</p>
                <p class="mt-1 text-sm text-muted">Search by suite title, board title, or prefix.</p>
              </div>
              <div class="rounded-2xl border border-default/70 bg-elevated/80 p-4">
                <p class="text-xs font-medium uppercase tracking-wide text-muted">Fallback</p>
                <p class="mt-2 text-sm font-semibold text-default">UUID input stays tucked away</p>
                <p class="mt-1 text-sm text-muted">Only use direct IDs when you already have one.</p>
              </div>
            </div>
          </div>
        </UCard>

        <!-- Quick Actions -->
        <section aria-label="Quick Actions" class="space-y-4">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-default">Quick Actions</h2>
              <p class="text-sm text-muted">Create the suite flow first, then create a standalone board if needed.</p>
            </div>

            <UBadge color="primary" variant="soft" size="sm">
              Suite creation is the primary CTA
            </UBadge>
          </div>

          <div class="grid gap-4 xl:grid-cols-2">
            <UCard class="border border-default/70 bg-elevated/80 shadow-sm">
              <template #header>
                <div class="flex items-start gap-3 p-5 pb-0">
                  <div class="rounded-xl bg-primary/10 p-2 text-primary">
                    <UIcon name="i-lucide-layers-3" class="size-5" />
                  </div>
                  <div>
                    <h3 class="text-base font-semibold text-default">Create Suite</h3>
                    <p class="text-sm text-muted">Spin up the suite flow first so related boards stay grouped together.</p>
                  </div>
                </div>
              </template>

              <UForm :state="createSuiteForm" @submit="onCreateSuite" class="space-y-4 p-5 pt-4">
                <UFormField name="title" label="Title">
                  <UInput v-model="createSuiteForm.title" placeholder="New Suite" class="w-full" />
                </UFormField>

                <UFormField name="template" label="Template">
                  <div class="grid grid-cols-2 gap-2">
                    <UButton
                      type="button"
                      :variant="createSuiteForm.template === 'default' ? 'solid' : 'soft'"
                      color="primary"
                      block
                      @click="createSuiteForm.template = 'default'"
                    >
                      Default Suite
                    </UButton>
                    <UButton
                      type="button"
                      :variant="createSuiteForm.template === 'development' ? 'solid' : 'soft'"
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
                  icon="i-lucide-layers-3"
                  color="primary"
                  block
                  :loading="isCreatingSuite"
                >
                  Create Suite
                </UButton>
              </UForm>
            </UCard>

            <UCard class="border border-default/70 bg-elevated/80 shadow-sm">
              <template #header>
                <div class="flex items-start gap-3 p-5 pb-0">
                  <div class="rounded-xl bg-default/5 p-2 text-default">
                    <UIcon name="i-lucide-plus" class="size-5" />
                  </div>
                  <div>
                    <h3 class="text-base font-semibold text-default">Create Board</h3>
                    <p class="text-sm text-muted">Start a standalone board when you do not need a suite yet.</p>
                  </div>
                </div>
              </template>

              <UForm :state="createForm" @submit="onCreateBoard" class="space-y-4 p-5 pt-4">
                <UFormField name="title" label="Title">
                  <UInput v-model="createForm.title" placeholder="New Board" class="w-full" />
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
                      :variant="createForm.template === 'default' ? 'solid' : 'soft'"
                      color="neutral"
                      block
                      @click="createForm.template = 'default'"
                    >
                      Default
                    </UButton>
                    <UButton
                      type="button"
                      :variant="createForm.template === 'development' ? 'solid' : 'soft'"
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
                  icon="i-lucide-layout-kanban"
                  color="neutral"
                  variant="soft"
                  block
                  :loading="isCreating"
                >
                  Create Board
                </UButton>
              </UForm>
            </UCard>
          </div>
        </section>

        <!-- Browse -->
        <section aria-label="Browse" class="space-y-4">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-default">Browse</h2>
              <p class="text-sm text-muted">Search by suite title, board title, or board prefix.</p>
            </div>

            <div class="min-w-72 max-w-full">
              <UInput
                v-model="searchQuery"
                aria-label="Search"
                type="search"
                icon="i-lucide-search"
                placeholder="Search suites or boards"
                class="w-full"
              />
            </div>
          </div>

          <div v-if="browseLoading" aria-label="Loading" class="rounded-2xl border border-default/70 bg-elevated/70 px-6 py-10 text-center text-muted">
            <UIcon name="i-lucide-loader-2" class="mx-auto mb-3 size-6 animate-spin text-primary" />
            Loading boards and suites...
          </div>

          <div v-else-if="browseError" class="rounded-2xl border border-error/30 bg-error/5 px-6 py-5 text-sm text-error">
            <div class="font-semibold">Error loading boards</div>
            <p class="mt-1">{{ browseError }}</p>
          </div>

          <div v-else-if="visibleSuites.length === 0 && visibleStandaloneBoards.length === 0" class="rounded-2xl border border-dashed border-default/70 bg-elevated/40 px-6 py-10 text-center text-muted">
            No boards yet. Create one above or adjust your search.
          </div>

          <div v-else class="space-y-6">
            <div v-if="visibleSuites.length" class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">Suites</h3>
                <span class="text-xs text-muted">{{ visibleSuites.length }} visible</span>
              </div>
              <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <HomeSuiteQuickAccessCard
                  v-for="suite in visibleSuites"
                  :key="suite.suite.uid"
                  :suite="suite"
                  :navigate-on-click="false"
                  @navigate="navigateToSuite"
                />
              </div>
            </div>

            <div v-if="visibleStandaloneBoards.length" class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">Standalone Boards</h3>
                <span class="text-xs text-muted">{{ visibleStandaloneBoards.length }} visible</span>
              </div>
              <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <HomeBoardQuickAccessCard
                  v-for="board in visibleStandaloneBoards"
                  :key="board.uid"
                  :board="board"
                  :navigate-on-click="false"
                  @navigate="navigateToBoard"
                />
              </div>
            </div>
          </div>
        </section>

        <!-- UUID Fallback -->
        <section aria-label="UUID Fallback" class="space-y-4">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-default">UUID Fallback</h2>
              <p class="text-sm text-muted">Keep this hidden unless you already have a board UUID.</p>
            </div>

            <UButton
              type="button"
              color="neutral"
              variant="soft"
              :icon="isUuidFallbackOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              @click="isUuidFallbackOpen = !isUuidFallbackOpen"
            >
              {{ isUuidFallbackOpen ? 'Hide UUID entry' : 'Open UUID entry' }}
            </UButton>
          </div>

          <UCard v-if="isUuidFallbackOpen" class="border border-default/70 bg-elevated/70 shadow-sm">
            <UForm :state="{ boardId }" @submit="goToBoard" class="space-y-4 p-5">
              <UFormField name="boardId" label="Board ID" required>
                <UInput v-model="boardId" placeholder="Enter board UUID" class="w-full" />
              </UFormField>
              <UButton type="submit" icon="i-lucide-layout-kanban" color="primary" block>
                Open Board
              </UButton>
            </UForm>
          </UCard>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
