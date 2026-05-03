<script setup lang="ts">
import { reactive, computed, watch, ref } from 'vue';
import { z } from 'zod';
import type { CardEntity, UpdateCardRequest, UpdateCardResponse, CardFamilyMetadata } from '@repo/shared';
import { useBoardStore } from '~/composables/useBoardStore';
import { parseApiError, parseConflictError } from '~/utils/api-error';

const props = defineProps<{
  open: boolean;
  card: CardEntity | null;
  boardUid: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'updated'): void;
}>();

const { updateCard } = useBoardStore();

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
const conflictServerCard = ref<CardEntity | null>(null);

const isLocked = computed(() => {
  if (!props.card) return false;
  return props.card.processing_state === 'PROCESSING' || props.card.processing_state === 'ERROR';
});

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
  if (isLocked.value) {
    errorMsg.value = 'This card is currently locked and cannot be edited.';
    return;
  }
  isSaving.value = true;
  errorMsg.value = '';
  try {
    await $fetch<UpdateCardResponse>(`/api/boards/${props.boardUid}/cards/${props.card.uid}`, {
      method: 'PATCH',
      body: {
        version: props.card.version,
        title: state.title,
        description: state.description || null,
      } satisfies UpdateCardRequest,
    });
    conflictServerCard.value = null;
    emit('updated');
    isOpen.value = false;
  } catch (err: unknown) {
    const conflict = parseConflictError(err);
    if (conflict) {
      conflictServerCard.value = conflict.error.details.card;
    } else {
      const apiErr = parseApiError(err);
      errorMsg.value = apiErr?.error.message || 'Failed to update card';
    }
  } finally {
    isSaving.value = false;
  }
}

function onRefreshConflict() {
  if (conflictServerCard.value) {
    updateCard(conflictServerCard.value);
  }
  conflictServerCard.value = null;
}

function onClose() {
  errorMsg.value = '';
  conflictServerCard.value = null;
  isOpen.value = false;
}

function statusColor(status: string): string {
  if (status === 'done') return 'success';
  if (status === 'error') return 'error';
  if (status === 'processing' || status === 'agentic-team') return 'info';
  return 'neutral';
}

function familyItemLabel(item: CardFamilyMetadata): string {
  const parts = [item.display_id];
  if (item.title) {
    const truncated = item.title.length > 40 ? item.title.slice(0, 40) + '…' : item.title;
    parts.push(truncated);
  }
  return parts.join(' — ');
}

function isExternal(item: CardFamilyMetadata): boolean {
  return item.board_uid !== props.boardUid;
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

        <!-- Family Tree Section -->
        <div v-if="card && (card.parents?.length || card.children?.length)" class="mb-4">
          <UCard variant="subtle" :ui="{ body: 'p-3' }">
            <h4 class="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Family</h4>

            <div v-if="card.parents?.length" class="mb-2">
              <p class="text-xs text-muted mb-1">Parents</p>
              <div class="flex flex-col gap-1">
                <div
                  v-for="parent in card.parents"
                  :key="parent.uid"
                  class="flex items-center gap-2 text-sm"
                >
                  <UBadge variant="subtle" size="xs" color="neutral" class="font-mono">
                    {{ parent.display_id }}
                  </UBadge>
                  <span class="truncate text-default">{{ parent.title }}</span>
                  <UBadge :color="statusColor(parent.status)" variant="subtle" size="xs">
                    {{ parent.status }}
                  </UBadge>
                  <span v-if="isExternal(parent)" class="text-xs text-muted font-mono">[EXT]</span>
                  <UIcon
                    v-if="isExternal(parent)"
                    name="i-lucide-external-link"
                    class="size-3 text-muted"
                    title="On another board"
                  />
                </div>
              </div>
            </div>

            <div v-if="card.children?.length">
              <p class="text-xs text-muted mb-1">Children</p>
              <div class="flex flex-col gap-1">
                <div
                  v-for="child in card.children"
                  :key="child.uid"
                  class="flex items-center gap-2 text-sm"
                >
                  <UBadge variant="subtle" size="xs" color="neutral" class="font-mono">
                    {{ child.display_id }}
                  </UBadge>
                  <span class="truncate text-default">{{ child.title }}</span>
                  <UBadge :color="statusColor(child.status)" variant="subtle" size="xs">
                    {{ child.status }}
                  </UBadge>
                  <span v-if="isExternal(child)" class="text-xs text-muted font-mono">[EXT]</span>
                  <UIcon
                    v-if="isExternal(child)"
                    name="i-lucide-external-link"
                    class="size-3 text-muted"
                    title="On another board"
                  />
                </div>
              </div>
            </div>
          </UCard>
        </div>

        <UAlert
          v-if="errorMsg"
          icon="i-lucide-alert-circle"
          color="error"
          variant="soft"
          class="mb-4"
          :title="errorMsg"
        />

        <UAlert
          v-if="conflictServerCard"
          icon="i-lucide-alert-triangle"
          color="error"
          variant="soft"
          class="mb-4"
          title="Someone else edited this — refresh and retry"
        >
          <template #actions>
            <UButton variant="outline" size="xs" @click="onRefreshConflict">Refresh</UButton>
          </template>
        </UAlert>

        <UAlert
          v-if="isLocked"
          icon="i-lucide-lock"
          color="warning"
          variant="soft"
          class="mb-4"
          title="Card is locked"
          description="This card is being processed and cannot be edited right now."
        />

        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="onClose">Cancel</UButton>
          <UButton type="submit" :loading="isSaving" :disabled="!!conflictServerCard || isLocked">Save</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
