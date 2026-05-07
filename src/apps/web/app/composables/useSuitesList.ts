import { ref } from 'vue';
import type { BoardSuiteWithBoards, ListBoardSuitesResponse } from '@repo/shared';

const suites = ref<BoardSuiteWithBoards[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

export function useSuitesList() {
  const getErrorMessage = (err: unknown): string | null => {
    if (typeof err !== 'object' || err === null || !('data' in err)) return null;
    const data = (err as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null || !('error' in data)) return null;
    const errorValue = (data as { error?: unknown }).error;
    if (typeof errorValue !== 'object' || errorValue === null || !('message' in errorValue)) return null;
    const message = (errorValue as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  };

  async function refreshSuites() {
    isLoading.value = true;
    error.value = null;
    try {
      const response = await $fetch<ListBoardSuitesResponse>('/api/board-suites');
      suites.value = response.data.suites;
    } catch (err: unknown) {
      error.value = getErrorMessage(err) ?? 'Failed to load suites';
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
