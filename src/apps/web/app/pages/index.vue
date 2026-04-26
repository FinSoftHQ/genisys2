<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const boardId = ref('');

function goToBoard() {
  const id = boardId.value.trim();
  if (id) {
    router.push(`/boards/${id}`);
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
  </UContainer>
</template>
