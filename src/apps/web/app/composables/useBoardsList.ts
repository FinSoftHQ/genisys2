import { ref } from 'vue';
import type { BoardEntity } from '@repo/shared';

const boards = ref<BoardEntity[]>([]);
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

  return {
    boards,
    isLoading,
    error,
    refreshBoards,
  };
}
