<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { NavigationMenuItem } from '@nuxt/ui';
import { useBoardsList } from '~/composables/useBoardsList';

const route = useRoute();
const { boards, isLoading: isLoadingBoards, refreshBoards } = useBoardsList();

// Refresh boards whenever the route changes so the sidebar stays in sync
watch(
  () => route.path,
  () => refreshBoards(),
  { immediate: true }
);

const navItems = computed<NavigationMenuItem[][]>(() => {
  const top: NavigationMenuItem[] = [
    {
      label: 'Home',
      icon: 'i-lucide-home',
      to: '/',
      active: route.path === '/',
    },
  ];

  const boardItems: NavigationMenuItem[] = [];
  for (const board of boards.value) {
    boardItems.push({
      label: board.title,
      icon: 'i-lucide-layout-kanban',
      to: `/boards/${board.uid}`,
      active: route.params.boardId === board.uid,
    });
  }

  const bottom: NavigationMenuItem[] = [
    {
      label: 'New Board',
      icon: 'i-lucide-plus',
      to: '/',
      active: false,
    },
  ];

  return [top, boardItems, bottom].filter((group) => group.length > 0);
});
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible resizable>
      <template #header="{ collapsed }">
        <NuxtLink
          to="/"
          class="flex items-center gap-2 font-semibold text-lg"
          :class="collapsed ? 'justify-center' : ''"
        >
          <UIcon name="i-lucide-layout-kanban" class="size-6 text-primary" />
          <span v-if="!collapsed">Hello Board</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <div v-if="isLoadingBoards" class="flex items-center justify-center py-4">
          <UIcon name="i-lucide-loader-2" class="size-5 animate-spin text-muted" />
        </div>
        <UNavigationMenu
          v-else
          :items="navItems"
          orientation="vertical"
          :ui="{ link: collapsed ? 'justify-center' : undefined }"
        />
      </template>

      <template #footer="{ collapsed }">
        <UDashboardSidebarCollapse :collapsed="collapsed" />
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
