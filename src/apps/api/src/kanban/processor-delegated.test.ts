import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockGetBoardById = vi.fn();
const mockListBoards = vi.fn();
const mockMoveCard = vi.fn();
const mockGetSnapshot = vi.fn();
const mockGetCardById = vi.fn();
const mockStartProcessing = vi.fn();
const mockMoveCardToNextColumn = vi.fn();

vi.mock('./repository.js', () => ({
  getBoardById: (...args: unknown[]) => mockGetBoardById(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
  moveCard: (...args: unknown[]) => mockMoveCard(...args),
  getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
  getCardById: (...args: unknown[]) => mockGetCardById(...args),
}));

vi.mock('./processing-orchestrator.js', () => ({
  startProcessing: (...args: unknown[]) => mockStartProcessing(...args),
  moveCardToNextColumn: async (...args: unknown[]) => mockMoveCardToNextColumn(...args),
}));

import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';

import { delegatedProcessorRoutes } from './processor-delegated.js';

const mockDevBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Development Board',
  prefix: 'DEV',
  suite_uid: '550e8400-e29b-41d4-a716-446655440001',
  role: 'primary',
  schema: {
    columns: [
      { uid: 'delegated', title: 'Delegated', type: 'Processing' as const, processor_id: 'delegated', exit_logic: { default: 'wrap' }, order: 0 },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockTaskBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440002',
  title: 'Task Board',
  prefix: 'TSK',
  suite_uid: '550e8400-e29b-41d4-a716-446655440001',
  role: 'tasks',
  schema: {
    columns: [
      { uid: 'todo', title: 'TODO', type: 'Normal' as const, processor_id: 'todo', exit_logic: { default: 'agentic-team' }, order: 0 },
      { uid: 'agentic-team', title: 'AI Team', type: 'Processing' as const, processor_id: 'agentic-team', exit_logic: { default: 'done' }, order: 1 },
      { uid: 'done', title: 'Done', type: 'Processing' as const, processor_id: 'done', exit_logic: { default: 'done' }, order: 2 },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockParentCard = {
  uid: '550e8400-e29b-41d4-a716-446655440003',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'DEV-1',
  title: 'Parent Task',
  description: null,
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: {
    task_card_uid: '550e8400-e29b-41d4-a716-446655440004',
    task_board_uid: '550e8400-e29b-41d4-a716-446655440002',
  },
  current_status: 'delegated',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockTaskCard = {
  uid: '550e8400-e29b-41d4-a716-446655440004',
  board_uid: '550e8400-e29b-41d4-a716-446655440002',
  display_id: 'TSK-1',
  title: 'Task Card',
  description: null,
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: { parent_board_uid: '550e8400-e29b-41d4-a716-446655440000', parent_card_uid: '550e8400-e29b-41d4-a716-446655440003' },
  current_status: 'todo',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('delegated processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = fastify();
    await app.register(delegatedProcessorRoutes, { prefix: '/api/kanban-processor/delegated' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    mockGetBoardById.mockReset();
    mockListBoards.mockReset();
    mockMoveCard.mockReset();
    mockGetSnapshot.mockReset();
    mockGetCardById.mockReset();
    mockStartProcessing.mockReset();
    mockMoveCardToNextColumn.mockReset();
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
  });

  describe('GET /api/kanban-processor/delegated/health', () => {
    it('returns 200 with healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/delegated/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/delegated/can-exit', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/can-exit',
        payload: {
          card: mockParentCard,
          target_column: 'wrap',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/delegated/on-update', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-update',
        payload: {
          card: mockParentCard,
          proposed_payload: { title: 'New Title' },
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(OnUpdateResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/delegated/on-enter', () => {
    it('returns 202 accepted and moves the related todo card to agentic-team', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockGetCardById.mockReturnValue(mockTaskCard);
      mockMoveCard.mockReturnValue({ ...mockTaskCard, current_status: 'agentic-team', version: 2 });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440020';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440010',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('accepted');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockGetBoardById).toHaveBeenCalledWith({}, mockParentCard.board_uid);
      expect(mockListBoards).toHaveBeenCalledWith({});
      expect(mockGetCardById).toHaveBeenCalledWith({}, mockTaskBoard.uid, mockTaskCard.uid);
      expect(mockMoveCard).toHaveBeenCalledWith(
        {},
        mockTaskBoard.uid,
        mockTaskCard.uid,
        'agentic-team',
        'system:delegated',
      );
      expect(mockStartProcessing).toHaveBeenCalledWith(
        {},
        mockTaskBoard,
        expect.objectContaining({ uid: mockTaskCard.uid, current_status: 'agentic-team' }),
        expect.objectContaining({ uid: 'agentic-team', type: 'Processing' }),
      );
      expect(mockMoveCardToNextColumn).toHaveBeenCalledWith({}, mockTaskBoard, 'todo');

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBeUndefined();
    });

    it('does not move an unrelated todo card', async () => {
      const unrelatedTaskCard = {
        ...mockTaskCard,
        uid: '550e8400-e29b-41d4-a716-44665544000a',
        display_id: 'TSK-2',
        payload: { parent_board_uid: '550e8400-e29b-41d4-a716-446655440000', parent_card_uid: '550e8400-e29b-41d4-a716-44665544000b' },
      };

      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      // The explicit task_card_uid points to a card that is no longer in todo
      mockGetCardById.mockReturnValue({ ...mockTaskCard, current_status: 'done' });
      // Fallback snapshot should also not match any card with parent_card_uid === mockParentCard.uid
      mockGetSnapshot.mockReturnValue({ board: mockTaskBoard, cards: [unrelatedTaskCard] });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440025';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440015',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockMoveCard).not.toHaveBeenCalled();

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
    });

    it('callbacks with success when board has no suite', async () => {
      mockGetBoardById.mockReturnValue({ ...mockDevBoard, suite_uid: null });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440021';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-enter',
        payload: {
          card: mockParentCard,
          board: { ...mockDevBoard, suite_uid: null },
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440011',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockMoveCard).not.toHaveBeenCalled();

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
    });

    it('callbacks with success when no task board exists in suite', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard]);

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440022';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440012',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockMoveCard).not.toHaveBeenCalled();

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
    });

    it('callbacks with success when the related card is not in todo', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockGetCardById.mockReturnValue({ ...mockTaskCard, current_status: 'done' });
      mockGetSnapshot.mockReturnValue({ board: mockTaskBoard, cards: [] });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440023';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440013',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockMoveCard).not.toHaveBeenCalled();

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-enter',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/delegated/on-action', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440024';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-action',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          action: 'Retry',
          actor: 'user:test@example.com',
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440014',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('accepted');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer processor',
          }),
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });
  });

  describe('POST /api/kanban-processor/delegated/on-exit', () => {
    it('returns 200 acknowledged', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/delegated/on-exit',
        payload: {
          card: mockParentCard,
          next_column: mockDevBoard.schema.columns[0],
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });
  });
});
