import { ref } from 'vue';
import type { BoardEntity, BoardSuiteWithBoards } from '@repo/shared';

const boards = ref<BoardEntity[]>([]);
const suites = ref<BoardSuiteWithBoards[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

export function useBoardsList() {
  async function refreshBoards() {
    isLoading.value = true;
    error.value = null;
    try {
      const response = await $fetch<{ data: { boards: BoardEntity[] } }>('/api/boards');
      boards.value = response.data.boards;
    } catch (err: any) {
      error.value = err?.data?.error?.message || 'Failed to load boards';
      // eslint-disable-next-line no-console
      console.warn('Failed to fetch boards list:', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function refreshSuites() {
    isLoading.value = true;
    error.value = null;
    try {
      const response = await $fetch<{ data: { suites: BoardSuiteWithBoards[] } }>('/api/board-suites');
      suites.value = response.data.suites;
    } catch (err: any) {
      error.value = err?.data?.error?.message || 'Failed to load suites';
      // eslint-disable-next-line no-console
      console.warn('Failed to fetch suites list:', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  return {
    boards,
    suites,
    isLoading,
    error,
    refreshBoards,
    refreshSuites,
  };
}
