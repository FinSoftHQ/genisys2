import { randomUUID } from 'node:crypto';
import type { BoardStreamSseEvent } from '@repo/shared';

export class BoardStreamManager {
  private buffers = new Map<string, Array<{ id: string; event: BoardStreamSseEvent; insertedAt: number }>>();
  private subscribers = new Map<string, Array<(chunk: string) => void>>();

  readonly bufferWindowMs = 300000;

  getBuffer(boardUid: string): Array<{ id: string; event: string; data: unknown }> {
    const buf = this.buffers.get(boardUid) ?? [];
    return buf.map((b) => ({
      id: b.id,
      event: b.event.event,
      data: b.event.data,
    }));
  }

  broadcast(boardUid: string, event: BoardStreamSseEvent): void {
    const now = Date.now();
    this.evictOldEvents(boardUid, now);

    let buf = this.buffers.get(boardUid);
    if (!buf) {
      buf = [];
      this.buffers.set(boardUid, buf);
    }
    buf.push({ id: event.id, event, insertedAt: now });

    const formatted = this.formatSse(event);
    const handlers = this.subscribers.get(boardUid) ?? [];
    for (const handler of handlers) {
      handler(formatted);
    }
  }

  subscribe(
    boardUid: string,
    handler: (chunk: string) => void,
    lastEventId?: string,
  ): () => void {
    const now = Date.now();

    let handlers = this.subscribers.get(boardUid);
    if (!handlers) {
      handlers = [];
      this.subscribers.set(boardUid, handlers);
    }
    handlers.push(handler);

    if (lastEventId) {
      this.replay(boardUid, handler, lastEventId, now);
    }

    this.evictOldEvents(boardUid, now);

    return () => {
      const h = this.subscribers.get(boardUid);
      if (h) {
        const idx = h.indexOf(handler);
        if (idx !== -1) h.splice(idx, 1);
      }
    };
  }

  private evictOldEvents(boardUid: string, now: number): void {
    const buf = this.buffers.get(boardUid);
    if (!buf) return;
    const cutoff = now - this.bufferWindowMs;
    const remaining = buf.filter((b) => b.insertedAt > cutoff);
    if (remaining.length !== buf.length) {
      this.buffers.set(boardUid, remaining);
    }
  }

  private replay(
    boardUid: string,
    handler: (chunk: string) => void,
    lastEventId: string,
    now: number,
  ): void {
    const buf = this.buffers.get(boardUid) ?? [];

    if (buf.length === 0) {
      handler(this.formatBoardReload(boardUid, 'SERVER_RESET'));
      return;
    }

    const index = buf.findIndex((b) => b.id === lastEventId);
    if (index === -1) {
      handler(this.formatBoardReload(boardUid, 'BUFFER_MISS'));
      return;
    }

    const lastEvent = buf[index];
    if (lastEvent.insertedAt <= now - this.bufferWindowMs) {
      handler(this.formatBoardReload(boardUid, 'CURSOR_EXPIRED'));
      return;
    }

    const missed = buf.slice(index + 1);
    for (const item of missed) {
      handler(this.formatSse(item.event));
    }
  }

  private formatSse(event: BoardStreamSseEvent): string {
    return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
  }

  private formatBoardReload(
    boardUid: string,
    reason: 'CURSOR_EXPIRED' | 'BUFFER_MISS' | 'SERVER_RESET',
  ): string {
    const eventId = randomUUID() as BoardStreamSseEvent['id'];
    const event: BoardStreamSseEvent = {
      id: eventId,
      event: 'BOARD_RELOAD',
      data: {
        event_id: eventId,
        board_uid: boardUid as BoardStreamSseEvent['data']['board_uid'],
        reason,
        timestamp: new Date().toISOString(),
      },
    };
    return this.formatSse(event);
  }
}

const globalStream = new BoardStreamManager();

export function subscribeToBoardEvents(
  boardUid: string,
  handler: (chunk: string) => void,
  lastEventId?: string,
): () => void {
  return globalStream.subscribe(boardUid, handler, lastEventId);
}

export function broadcastEvent(boardUid: string, event: BoardStreamSseEvent): void {
  globalStream.broadcast(boardUid, event);
}
