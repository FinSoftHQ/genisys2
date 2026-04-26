<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { CreateBoardResponse } from '@repo/shared';

const router = useRouter();
const boardId = ref('');
const isCreating = ref(false);

function goToBoard() {
  const id = boardId.value.trim();
  if (id) {
    router.push(`/boards/${id}`);
  }
}

async function createNewBoard() {
  isCreating.value = true;
  try {
    const response = await $fetch<CreateBoardResponse>('/api/boards', { method: 'POST' });
    router.push(`/boards/${response.data.board.uid}`);
  } catch {
    // Optionally: show error toast here
  } finally {
    isCreating.value = false;
  }
}
</script>

<template>
  <UContainer class="flex flex-col items-center justify-center min-h-screen gap-8">
    <UPageHeader
      title="Hello Board"
      description="A simple kanban board built with Nuxt UI"
      class="text-center"
    />

    <UForm :state="{ boardId }" @submit="goToBoard" class="w-full max-w-sm flex flex-col gap-4">
      <UFormField name="boardId" label="Board ID" required>
        <UInput v-model="boardId" placeholder="Enter board UUID" class="w-full" />
      </UFormField>
      <UButton type="submit" icon="i-lucide-layout-kanban" block>
        Open Board
      </UButton>
    </UForm>

    <USeparator class="w-full max-w-sm" label="or" />

    <UButton
      color="neutral"
      variant="subtle"
      icon="i-lucide-plus"
      class="w-full max-w-sm"
      block
      :loading="isCreating"
      @click="createNewBoard"
    >
      Create New Board
    </UButton>
  </UContainer>
</template>
