<script setup lang="ts">
import { reactive, computed, ref } from 'vue';
import { z } from 'zod';
import type { CreateCardRequest, CreateCardResponse } from '@repo/shared';
const props = defineProps<{
  open: boolean;
  columnUid: string;
  boardUid: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'created'): void;
}>();

const schema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Max 200 characters'),
  description: z.string().max(5000, 'Max 5000 characters').optional(),
});

type Schema = z.output<typeof schema>;

const state = reactive<Schema>({
  title: '',
  description: undefined,
});

const isOpen = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
});

const isSaving = ref(false);
const errorMsg = ref('');

async function onSubmit() {
  isSaving.value = true;
  errorMsg.value = '';
  try {
    await $fetch<CreateCardResponse>(`/api/boards/${props.boardUid}/cards`, {
      method: 'POST',
      body: {
        title: state.title,
        description: state.description || undefined,
        current_status: props.columnUid,
      } satisfies CreateCardRequest,
    });
    state.title = '';
    state.description = '';
    emit('created');
    isOpen.value = false;
  } catch (err: any) {
    errorMsg.value = err?.data?.error?.message || 'Failed to create card';
  } finally {
    isSaving.value = false;
  }
}

function onClose() {
  state.title = '';
  state.description = '';
  errorMsg.value = '';
  isOpen.value = false;
}
</script>

<template>
  <UModal v-model:open="isOpen" title="Create Card" description="Add a new card to this column">
    <template #body>
      <UForm :schema="schema" :state="state" @submit="onSubmit">
        <UFormField name="title" label="Title" required class="mb-4">
          <UInput v-model="state.title" placeholder="Card title" />
        </UFormField>

        <UFormField name="description" label="Description" class="mb-4">
          <UTextarea v-model="state.description" placeholder="Optional description" :rows="3" />
        </UFormField>

        <UAlert
          v-if="errorMsg"
          icon="i-lucide-alert-circle"
          color="error"
          variant="soft"
          class="mb-4"
          :title="errorMsg"
        />

        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="onClose">Cancel</UButton>
          <UButton type="submit" :loading="isSaving">Create</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
