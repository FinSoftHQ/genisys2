import { ref } from 'vue';
import type { BoardSuiteWithBoards } from '@repo/shared';

const suites = ref<BoardSuiteWithBoards[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

export function useSuitesList() {
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
    suites,
    isLoading,
    error,
    refreshSuites,
  };
}
