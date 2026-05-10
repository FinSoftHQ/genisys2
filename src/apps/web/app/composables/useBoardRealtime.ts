import { ref, onUnmounted } from 'vue';
import { BoardStreamSseEventSchema } from '@repo/shared';
import type { BoardStreamSseEvent } from '@repo/shared';
import { useBoardStore } from '~/composables/useBoardStore';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

interface SseMessage {
  id: string;
  event: string;
  data: string;
}

function parseSseMessages(chunk: string): { messages: SseMessage[]; leftover: string } {
  const messages: SseMessage[] = [];
  const lines = chunk.split('\n');

  let currentId = '';
  let currentEvent = '';
  let currentDataLines: string[] = [];

  function flushMessage() {
    if (currentDataLines.length > 0 || currentEvent) {
      messages.push({
        id: currentId,
        event: currentEvent || 'message',
        data: currentDataLines.join('\n'),
      });
    }
    currentId = '';
    currentEvent = '';
    currentDataLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '' && i < lines.length - 1) {
      flushMessage();
      continue;
    }
    if (line.startsWith('id:')) {
      currentId = line.slice(3).trim();
    } else if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      currentDataLines.push(line.slice(5).trimStart());
    }
  }

  const leftoverLines: string[] = [];
  if (currentId) leftoverLines.push(`id: ${currentId}`);
  if (currentEvent) leftoverLines.push(`event: ${currentEvent}`);
  for (const dl of currentDataLines) leftoverLines.push(`data: ${dl}`);

  return { messages, leftover: leftoverLines.join('\n') };
}

export function useBoardRealtime(boardId: string, opts?: { onReload?: () => void }) {
  const boardStore = useBoardStore();

  const status = ref<ConnectionStatus>('idle');
  const lastEventId = ref<string | null>(null);
  const reconnectAttempt = ref(0);

  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;

  function applyEvent(event: BoardStreamSseEvent) {
    switch (event.event) {
      case 'CARD_CREATED':
        boardStore.addCard(event.data.card);
        break;
      case 'CARD_UPDATED':
        boardStore.updateCard(event.data.card);
        break;
      case 'CARD_MOVED':
        boardStore.updateCard(event.data.card);
        break;
      case 'ROLLUP_CHANGED':
        opts?.onReload?.();
        break;
      case 'BOARD_RELOAD':
        opts?.onReload?.();
        break;
    }
  }

  function handleSseMessage(msg: SseMessage) {
    if (msg.id) {
      lastEventId.value = msg.id;
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(msg.data);
    } catch {
      console.error('[SSE] Failed to parse message data', msg.data);
      return;
    }

    const envelope = {
      id: msg.id,
      event: msg.event,
      data: parsedData,
    };

    const parsed = BoardStreamSseEventSchema.safeParse(envelope);
    if (!parsed.success) {
      console.error('[SSE] Validation failed', parsed.error.issues);
      return;
    }

    applyEvent(parsed.data);
  }

  async function connect() {
    disconnect();
    status.value = 'connecting';
    active = true;

    const url = `/api/boards/${boardId}/stream`;
    const headers: Record<string, string> = {};
    if (lastEventId.value) {
      headers['Last-Event-ID'] = lastEventId.value;
    }

    abortController = new AbortController();

    try {
      const response = await fetch(url, {
        headers,
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream request failed: ${response.status.toString()}`);
      }

      status.value = 'connected';
      reconnectAttempt.value = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      interface StreamResult {
        done: boolean;
        value?: Uint8Array;
      }

      while (true) {
        const result: StreamResult = await reader.read() as unknown as StreamResult;
        if (result.done || !active) break;
        if (!result.value) continue;

        buffer += decoder.decode(result.value, { stream: true });
        const { messages, leftover } = parseSseMessages(buffer);
        buffer = leftover;

        for (const msg of messages) {
          handleSseMessage(msg);
        }
      }

      status.value = 'disconnected';
      scheduleReconnect();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      console.error('[SSE] Connection error', err);
      status.value = 'disconnected';
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || !active) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt.value),
      RECONNECT_MAX_MS
    );
    reconnectAttempt.value += 1;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  function disconnect() {
    active = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    status.value = 'idle';
  }

  onUnmounted(() => {
    disconnect();
  });

  return {
    status,
    lastEventId,
    reconnectAttempt,
    connect,
    disconnect,
  };
}
