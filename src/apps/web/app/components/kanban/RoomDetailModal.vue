<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { CardEntity } from '@repo/shared';

const props = defineProps<{
  open: boolean;
  card: CardEntity | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const isOpen = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
});

const roomStatus = ref<Record<string, unknown> | null>(null);
const roomEvents = ref<Array<Record<string, unknown>>>([]);
const isLoading = ref(false);
const error = ref('');

const roomId = computed(() => props.card?.room_id ?? '');

async function loadRoomData() {
  if (!roomId.value) return;
  isLoading.value = true;
  error.value = '';
  try {
    const [statusRes, eventsRes] = await Promise.all([
      $fetch(`/api/v1/agent-rooms/${roomId.value}/status`).catch(() => null),
      $fetch(`/api/v1/agent-rooms/${roomId.value}/events?limit=50`).catch(() => null),
    ]);
    roomStatus.value = statusRes as Record<string, unknown> | null;
    roomEvents.value = (eventsRes as { events?: Array<Record<string, unknown>> } | null)?.events ?? [];
  } catch (err: unknown) {
    error.value = 'Failed to load room data';
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) loadRoomData();
  },
  { immediate: true }
);

watch(
  () => props.card?.room_id,
  () => {
    if (props.open) loadRoomData();
  }
);

function formatDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

const agents = computed(() => {
  const ags = roomStatus.value?.agents;
  if (!ags || typeof ags !== 'object') return [];
  return Object.entries(ags).map(([name, data]) => ({
    name,
    ...(typeof data === 'object' && data !== null ? data : {}),
  }));
});
</script>

<template>
  <UModal v-model:open="isOpen" title="Agent Room" :description="card?.display_id">
    <template #body>
      <div v-if="isLoading" class="flex items-center justify-center py-8">
        <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-info" />
      </div>

      <UAlert
        v-else-if="error"
        icon="i-lucide-alert-circle"
        color="error"
        variant="soft"
        :title="error"
      />

      <div v-else-if="roomStatus" class="space-y-4">
        <!-- Status -->
        <UCard variant="subtle" :ui="{ body: 'p-3' }">
          <div class="flex items-center justify-between mb-2">
            <h4 class="text-xs font-semibold text-muted uppercase tracking-wide">Status</h4>
            <UBadge
              :color="roomStatus.status === 'completed' ? 'success' : roomStatus.status === 'error' ? 'error' : 'info'"
              variant="soft"
              size="xs"
            >
              {{ roomStatus.status }}
            </UBadge>
          </div>
          <div class="grid grid-cols-2 gap-2 text-sm">
            <div class="text-muted">Room ID</div>
            <div class="font-mono text-default truncate">{{ roomId }}</div>
            <div class="text-muted">Created</div>
            <div class="text-default">{{ formatDate(roomStatus.created_at) }}</div>
            <div v-if="roomStatus.completed_at" class="text-muted">Completed</div>
            <div v-if="roomStatus.completed_at" class="text-default">{{ formatDate(roomStatus.completed_at) }}</div>
          </div>
        </UCard>

        <!-- Agents -->
        <UCard v-if="agents.length > 0" variant="subtle" :ui="{ body: 'p-3' }">
          <h4 class="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Agents</h4>
          <div class="flex flex-col gap-2">
            <div
              v-for="agent in agents"
              :key="agent.name"
              class="flex items-center justify-between text-sm"
            >
              <div class="flex items-center gap-2">
                <UIcon name="i-lucide-user" class="size-4 text-muted" />
                <span class="text-default">{{ agent.name }}</span>
                <span class="text-xs text-muted">({{ (agent as Record<string, unknown>).role ?? '—' }})</span>
              </div>
              <UBadge
                :color="(agent as Record<string, unknown>).status === 'completed' ? 'success' : 'neutral'"
                variant="soft"
                size="xs"
              >
                {{ (agent as Record<string, unknown>).status ?? '—' }}
              </UBadge>
            </div>
          </div>
        </UCard>

        <!-- Events -->
        <UCard variant="subtle" :ui="{ body: 'p-3' }">
          <h4 class="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Recent Events</h4>
          <div class="max-h-64 overflow-y-auto flex flex-col gap-2">
            <div
              v-for="(event, idx) in roomEvents"
              :key="idx"
              class="text-xs border-l-2 border-muted pl-2 py-1"
            >
              <div class="flex items-center gap-2 text-muted">
                <span class="font-mono">#{{ (event as Record<string, unknown>).id ?? idx }}</span>
                <span>{{ (event as Record<string, unknown>).type ?? 'event' }}</span>
                <span v-if="(event as Record<string, unknown>).timestamp">{{ formatDate((event as Record<string, unknown>).timestamp) }}</span>
              </div>
              <pre v-if="(event as Record<string, unknown>).content" class="mt-1 text-default whitespace-pre-wrap">{{ (event as Record<string, unknown>).content }}</pre>
            </div>
            <p v-if="roomEvents.length === 0" class="text-xs text-muted text-center py-4">No events</p>
          </div>
        </UCard>
      </div>

      <p v-else class="text-sm text-muted text-center py-8">No room data available</p>
    </template>
  </UModal>
</template>
