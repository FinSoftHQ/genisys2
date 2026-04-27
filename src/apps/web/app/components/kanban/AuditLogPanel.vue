<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import {
  AuditLogResponseSchema,
  type EventLogRow,
} from '@repo/shared';

const props = defineProps<{
  boardId: string;
}>();

const open = defineModel<boolean>('open', { default: false });

const events = ref<EventLogRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);

const hasMore = computed(() => !!nextCursor.value);

async function loadAuditLog(isLoadMore = false) {
  loading.value = true;
  error.value = null;

  try {
    const query = new URLSearchParams();
    query.set('limit', '50');
    if (isLoadMore && nextCursor.value) {
      query.set('cursor', nextCursor.value);
    }

    const response = await $fetch(`/api/boards/${props.boardId}/audit-log?${query.toString()}`);

    const parsed = AuditLogResponseSchema.safeParse(response);
    if (!parsed.success) {
      error.value = 'Received invalid audit log data from server';
      return;
    }

    if (isLoadMore) {
      events.value.push(...parsed.data.data.events);
    } else {
      events.value = parsed.data.data.events;
    }
    nextCursor.value = parsed.data.data.next_cursor;
  } catch (err: any) {
    error.value = err?.data?.error?.message || 'Failed to load audit log';
  } finally {
    loading.value = false;
  }
}

watch(open, (isOpen) => {
  if (isOpen && events.value.length === 0) {
    loadAuditLog();
  }
});
</script>

<template>
  <USlideover v-model:open="open" title="Audit Log" side="right">
    <template #body>
      <div class="flex flex-col gap-4">
        <UAlert
          v-if="error"
          icon="i-lucide-alert-circle"
          color="error"
          variant="soft"
          :title="error"
        />

        <div v-if="loading && events.length === 0" class="flex flex-col gap-3">
          <USkeleton v-for="i in 5" :key="i" class="h-16 w-full" />
        </div>

        <div v-else-if="events.length === 0 && !loading" class="text-center py-12">
          <UIcon name="i-lucide-clipboard-list" class="size-10 text-muted mx-auto mb-3" />
          <p class="text-sm text-muted">No audit events yet</p>
        </div>

        <div v-else class="flex flex-col gap-3">
          <UCard
            v-for="evt in events"
            :key="evt.event_id"
            :ui="{ root: 'bg-white dark:bg-gray-900', body: 'p-3' }"
          >
            <div class="flex items-center justify-between gap-2">
              <UBadge
                :color="
                  evt.category === 'user_action'
                    ? 'primary'
                    : evt.category === 'lifecycle'
                      ? 'info'
                      : 'neutral'
                "
                variant="soft"
                size="xs"
              >
                {{ evt.action }}
              </UBadge>
              <span class="text-xs text-muted">
                {{ new Date(evt.timestamp).toLocaleString() }}
              </span>
            </div>
            <div class="mt-2 text-sm text-default">
              <span class="font-medium">{{ evt.actor }}</span>
              <span v-if="evt.from_column && evt.to_column" class="text-muted">
                moved from
                <span class="font-medium text-default">{{ evt.from_column }}</span>
                to
                <span class="font-medium text-default">{{ evt.to_column }}</span>
              </span>
              <span v-else-if="evt.action === 'CARD_CREATED'" class="text-muted">
                created card
                <span class="font-medium text-default">{{ evt.metadata?.display_id || evt.card_uid }}</span>
              </span>
              <span v-else-if="evt.action === 'CARD_UPDATED'" class="text-muted">
                updated card
                <span class="font-medium text-default">{{ evt.metadata?.display_id || evt.card_uid }}</span>
              </span>
              <span v-else class="text-muted">
                — {{ evt.card_uid }}
              </span>
            </div>
          </UCard>

          <UButton
            v-if="hasMore"
            variant="soft"
            color="neutral"
            block
            :loading="loading"
            @click="loadAuditLog(true)"
          >
            Load more
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
