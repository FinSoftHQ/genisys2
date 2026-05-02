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

function metadataRecord(evt: EventLogRow): Record<string, unknown> | null {
  return evt.metadata && typeof evt.metadata === 'object' ? evt.metadata : null;
}

function cardLabel(evt: EventLogRow): string {
  const meta = metadataRecord(evt);
  return typeof meta?.display_id === 'string' && meta.display_id.trim().length > 0
    ? meta.display_id
    : evt.card_uid;
}

function rollupSummary(evt: EventLogRow): string {
  const meta = metadataRecord(evt);
  const completed = typeof meta?.completed_children === 'number' ? meta.completed_children : null;
  const total = typeof meta?.total_children === 'number' ? meta.total_children : null;
  const health = typeof meta?.health_score === 'number' ? meta.health_score : null;

  const counts = completed !== null && total !== null ? ` ${completed}/${total} complete` : '';
  const score = health !== null ? ` · health ${health}%` : '';
  return `rollup changed for ${cardLabel(evt)}${counts}${score}`;
}

function eventSummary(evt: EventLogRow): string {
  if (evt.from_column && evt.to_column) {
    return `moved from ${evt.from_column} to ${evt.to_column}`;
  }

  switch (evt.action) {
    case 'CARD_CREATED':
      return `created card ${cardLabel(evt)}`;
    case 'CARD_UPDATED':
      return `updated card ${cardLabel(evt)}`;
    case 'ROLLUP_CHANGED':
      return rollupSummary(evt);
    case 'BOARD_RELOAD':
      return `requested board reload for ${cardLabel(evt)}`;
    default:
      return `— ${evt.card_uid}`;
  }
}

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
              <span class="text-muted"> {{ eventSummary(evt) }}</span>
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
