<script setup lang="ts">
import { reactive, computed, watch, ref } from 'vue';
import { z } from 'zod';
import type { CardEntity, UpdateCardRequest, UpdateCardResponse } from '@repo/shared';

const props = defineProps<{
  open: boolean;
  card: CardEntity | null;
  boardUid: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'updated'): void;
}>();

const schema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Max 200 characters'),
  description: z.string().max(5000, 'Max 5000 characters').optional(),
});

type Schema = z.output<typeof schema>;

const state = reactive<Partial<Schema>>({
  title: '',
  description: '',
});

const isOpen = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
});

const isSaving = ref(false);
const errorMsg = ref('');

watch(
  () => props.card,
  (card) => {
    if (card) {
      state.title = card.title;
      state.description = card.description ?? undefined;
    }
  },
  { immediate: true }
);

async function onSubmit() {
  if (!props.card) return;
  isSaving.value = true;
  errorMsg.value = '';
  try {
    await $fetch<UpdateCardResponse>(`/api/boards/${props.boardUid}/cards/${props.card.uid}`, {
      method: 'PATCH',
      body: {
        title: state.title,
        description: state.description || null,
      } satisfies UpdateCardRequest,
    });
    emit('updated');
    isOpen.value = false;
  } catch (err: any) {
    errorMsg.value = err?.data?.error?.message || 'Failed to update card';
  } finally {
    isSaving.value = false;
  }
}

function onClose() {
  errorMsg.value = '';
  isOpen.value = false;
}
</script>

<template>
  <UModal v-model:open="isOpen" title="Edit Card" :description="card?.display_id">
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
          <UButton type="submit" :loading="isSaving">Save</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
