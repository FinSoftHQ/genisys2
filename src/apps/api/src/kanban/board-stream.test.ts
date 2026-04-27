import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BoardStreamSseEventSchema,
  BoardReloadSseEventSchema,
  type BoardStreamSseEvent,
} from '@repo/shared';
import { BoardStreamManager } from './board-stream.js';

const mockBoardUid = '550e8400-e29b-41d4-a716-446655440000';
const mockCard = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'TST-1',
  title: 'Test Card',
  description: null,
  version: 1,
  processing_state: 'IDLE',
  is_editable: true,
  payload: {},
  current_status: 'backlog',
  created_at: '2026-04-27T00:00:00.000Z',
  updated_at: '2026-04-27T00:00:00.000Z',
};

function makeCardCreatedEvent(id: string): BoardStreamSseEvent {
  return {
    id,
    event: 'CARD_CREATED',
    data: {
      event_id: id,
      board_uid: mockBoardUid,
      actor: 'alice',
      timestamp: '2026-04-27T00:00:00.000Z',
      card: mockCard,
    },
  };
}

function makeCardMovedEvent(id: string, from: string, to: string): BoardStreamSseEvent {
  return {
    id,
    event: 'CARD_MOVED',
    data: {
      event_id: id,
      board_uid: mockBoardUid,
      actor: 'alice',
      timestamp: '2026-04-27T00:00:00.000Z',
      card: { ...mockCard, current_status: to },
      from_column: from,
      to_column: to,
    },
  };
}

describe('board stream', () => {
  let stream: BoardStreamManager;

  beforeEach(() => {
    stream = new BoardStreamManager();
  });

  describe('buffer', () => {
    it('default buffer window is 300000 ms', () => {
      expect(stream.bufferWindowMs).toBe(300000);
    });

    it('stores broadcast events per board', () => {
      const event = makeCardCreatedEvent('550e8400-e29b-41d4-a716-446655440001');
      stream.broadcast(mockBoardUid, event);
      expect(stream.getBuffer(mockBoardUid)).toHaveLength(1);
    });

    it('evicts events older than bufferWindowMs', () => {
      vi.useFakeTimers();
      const event1 = makeCardCreatedEvent('e1');
      stream.broadcast(mockBoardUid, event1);
      vi.advanceTimersByTime(300001);
      const event2 = makeCardCreatedEvent('e2');
      stream.broadcast(mockBoardUid, event2);
      const buffer = stream.getBuffer(mockBoardUid);
      expect(buffer).toHaveLength(1);
      expect(buffer[0].id).toBe('e2');
      vi.useRealTimers();
    });

    it('maintains independent buffers per board', () => {
      const boardA = '550e8400-e29b-41d4-a716-446655440000';
      const boardB = '550e8400-e29b-41d4-a716-446655440001';
      stream.broadcast(boardA, makeCardCreatedEvent('eA'));
      stream.broadcast(boardB, makeCardCreatedEvent('eB'));
      expect(stream.getBuffer(boardA)).toHaveLength(1);
      expect(stream.getBuffer(boardB)).toHaveLength(1);
      expect(stream.getBuffer(boardA)[0].id).toBe('eA');
      expect(stream.getBuffer(boardB)[0].id).toBe('eB');
    });
  });

  describe('live subscription', () => {
    it('receives events broadcast after subscribing', () => {
      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler);
      const event = makeCardCreatedEvent('e1');
      stream.broadcast(mockBoardUid, event);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.stringContaining('id: e1'));
    });

    it('unsubscribe stops receiving events', () => {
      const handler = vi.fn();
      const unsubscribe = stream.subscribe(mockBoardUid, handler);
      unsubscribe();
      stream.broadcast(mockBoardUid, makeCardCreatedEvent('e1'));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('replay subscription', () => {
    it('replays missed events when lastEventId is in buffer', () => {
      const e1 = makeCardCreatedEvent('e1');
      const e2 = makeCardMovedEvent('e2', 'backlog', 'in-progress');
      const e3 = makeCardCreatedEvent('e3');
      stream.broadcast(mockBoardUid, e1);
      stream.broadcast(mockBoardUid, e2);
      stream.broadcast(mockBoardUid, e3);

      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler, 'e1');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.stringContaining('id: e2'));
      expect(handler).toHaveBeenNthCalledWith(2, expect.stringContaining('id: e3'));
    });

    it('emits BOARD_RELOAD with BUFFER_MISS when lastEventId is unknown', () => {
      stream.broadcast(mockBoardUid, makeCardCreatedEvent('e1'));

      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler, 'unknown-id');
      expect(handler).toHaveBeenCalledTimes(1);
      const call = handler.mock.calls[0][0];
      expect(call).toContain('event: BOARD_RELOAD');
      expect(call).toContain('BUFFER_MISS');
    });

    it('emits BOARD_RELOAD with CURSOR_EXPIRED when lastEventId is older than buffer window', () => {
      vi.useFakeTimers();
      stream.broadcast(mockBoardUid, makeCardCreatedEvent('e1'));
      vi.advanceTimersByTime(300001);

      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler, 'e1');
      expect(handler).toHaveBeenCalledTimes(1);
      const call = handler.mock.calls[0][0];
      expect(call).toContain('event: BOARD_RELOAD');
      expect(call).toContain('CURSOR_EXPIRED');
      vi.useRealTimers();
    });

    it('emits BOARD_RELOAD with SERVER_RESET when buffer is empty and lastEventId is provided', () => {
      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler, 'some-old-id');
      expect(handler).toHaveBeenCalledTimes(1);
      const call = handler.mock.calls[0][0];
      expect(call).toContain('event: BOARD_RELOAD');
      expect(call).toContain('SERVER_RESET');
    });
  });

  describe('SSE format', () => {
    it('formats events with id, event, and data fields', () => {
      const event = makeCardCreatedEvent('e1');
      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler);
      stream.broadcast(mockBoardUid, event);
      const chunk = handler.mock.calls[0][0];
      expect(chunk).toMatch(/^id: e1\n/);
      expect(chunk).toMatch(/event: CARD_CREATED\n/);
      expect(chunk).toMatch(/data: .+/);
      expect(chunk).toMatch(/\n\n$/);
    });

    it('emits events that parse as BoardStreamSseEventSchema', () => {
      const event = makeCardCreatedEvent('e1');
      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler);
      stream.broadcast(mockBoardUid, event);
      const chunk = handler.mock.calls[0][0];
      const lines = chunk.split('\n');
      const dataLine = lines.find((l: string) => l.startsWith('data: '));
      const parsed = JSON.parse(dataLine!.slice(6));
      expect(BoardStreamSseEventSchema.safeParse({ ...event, data: parsed }).success).toBe(true);
    });

    it('emits BOARD_RELOAD events that parse as BoardReloadSseEventSchema', () => {
      const handler = vi.fn();
      stream.subscribe(mockBoardUid, handler, 'missing');
      const chunk = handler.mock.calls[0][0];
      const lines = chunk.split('\n');
      const dataLine = lines.find((l: string) => l.startsWith('data: '));
      const parsed = JSON.parse(dataLine!.slice(6));
      expect(BoardReloadSseEventSchema.safeParse({ id: parsed.event_id, event: 'BOARD_RELOAD', data: parsed }).success).toBe(true);
    });
  });
});
