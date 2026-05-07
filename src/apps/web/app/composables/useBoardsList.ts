import { ref } from 'vue';
import type { BoardEntity, ListBoardsResponse } from '@repo/shared';

const boards = ref<BoardEntity[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

export function useBoardsList() {
  const getErrorMessage = (err: unknown): string | null => {
    if (typeof err !== 'object' || err === null || !('data' in err)) return null;
    const data = (err as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null || !('error' in data)) return null;
    const errorValue = (data as { error?: unknown }).error;
    if (typeof errorValue !== 'object' || errorValue === null || !('message' in errorValue)) return null;
    const message = (errorValue as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  };

  async function refreshBoards() {
    isLoading.value = true;
    error.value = null;
    try {
      const response = await $fetch<ListBoardsResponse>('/api/boards');
      boards.value = response.data.boards;
    } catch (err: unknown) {
      error.value = getErrorMessage(err) ?? 'Failed to load boards';
      console.warn('Failed to fetch boards list:', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  return {
    boards,
    isLoading,
    error,
    refreshBoards,
  };
}
