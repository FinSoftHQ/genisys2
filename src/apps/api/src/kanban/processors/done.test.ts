import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockGetBoardById = vi.fn();
const mockGetCardById = vi.fn();
const mockGetCardFamily = vi.fn();
const mockListBoards = vi.fn();
const mockMoveCard = vi.fn();
const mockStartProcessing = vi.fn();

vi.mock('../repository.js', () => ({
  getBoardById: (...args: unknown[]) => mockGetBoardById(...args),
  getCardById: (...args: unknown[]) => mockGetCardById(...args),
  getCardFamily: (...args: unknown[]) => mockGetCardFamily(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
  moveCard: (...args: unknown[]) => mockMoveCard(...args),
}));

vi.mock('../processing-orchestrator.js', () => ({
  startProcessing: (...args: unknown[]) => mockStartProcessing(...args),
}));

import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';

import { doneProcessorRoutes } from './done.js';

const mockDevBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Development Board',
  prefix: 'DEV',
  suite_uid: '550e8400-e29b-41d4-a716-446655440001',
  role: 'primary',
  schema: {
    columns: [
      { uid: 'delegated', title: 'Delegated', type: 'Processing' as const, processor_id: 'delegated', exit_logic: { default: 'wrap' }, order: 3 },
      { uid: 'wrap', title: 'Wrap', type: 'Processing' as const, processor_id: 'wrap', exit_logic: { default: 'done' }, order: 4 },
      { uid: 'done', title: 'Done', type: 'Processing' as const, processor_id: 'done', exit_logic: { default: 'done' }, order: 5 },
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
      { uid: 'agentic-team', title: 'AI Team', type: 'Processing' as const, processor_id: 'agentic-team', exit_logic: { default: 'commit' }, order: 1 },
      { uid: 'commit', title: 'Commit', type: 'Processing' as const, processor_id: 'commit', exit_logic: { default: 'done' }, order: 2 },
      { uid: 'done', title: 'Done', type: 'Processing' as const, processor_id: 'done', exit_logic: { default: 'done' }, order: 3 },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockParentCard = {
  uid: '550e8400-e29b-41d4-a716-446655440003',
  board_uid: mockDevBoard.uid,
  display_id: 'DEV-1',
  title: 'Parent Task',
  description: null,
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: {},
  current_status: 'delegated',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockChildCard = {
  uid: '550e8400-e29b-41d4-a716-446655440004',
  board_uid: mockTaskBoard.uid,
  display_id: 'TSK-1',
  title: 'Task Card',
  description: null,
  version: 1,
  processing_state: 'PROCESSING' as const,
  is_editable: false,
  payload: {
    parent_board_uid: mockDevBoard.uid,
    parent_card_uid: mockParentCard.uid,
  },
  current_status: 'done',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('done processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = fastify();
    await app.register(doneProcessorRoutes, { prefix: '/api/kanban-processor/done' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    mockGetBoardById.mockReset();
    mockGetCardById.mockReset();
    mockGetCardFamily.mockReset();
    mockListBoards.mockReset();
    mockMoveCard.mockReset();
    mockStartProcessing.mockReset();
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
  });

  describe('GET /api/kanban-processor/done/health', () => {
    it('returns 200 with healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/done/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/done/can-exit', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/can-exit',
        payload: {
          card: mockChildCard,
          target_column: 'archive',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/done/on-update', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-update',
        payload: {
          card: mockChildCard,
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

  describe('POST /api/kanban-processor/done/on-enter', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440010';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-enter',
        payload: {
          card: mockChildCard,
          board: mockTaskBoard,
          column: mockTaskBoard.schema.columns[2],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440011',
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

    it('wakes parent to wrap when all children are done (including current child in PROCESSING)', async () => {
      mockGetCardById.mockImplementation((_db: unknown, boardUid: string, cardUid: string) => {
        if (boardUid === mockDevBoard.uid && cardUid === mockParentCard.uid) {
          return mockParentCard;
        }
        if (boardUid === mockTaskBoard.uid && cardUid === mockChildCard.uid) {
          return mockChildCard;
        }
        return undefined;
      });
      mockGetCardFamily.mockReturnValue({
        parents: [],
        children: [{ uid: mockChildCard.uid, board_uid: mockChildCard.board_uid, display_id: mockChildCard.display_id, status: mockChildCard.current_status, title: mockChildCard.title, processing_state: mockChildCard.processing_state }],
      });
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockMoveCard.mockReturnValue({ ...mockParentCard, current_status: 'wrap', version: 2 });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440012';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-enter',
        payload: {
          card: mockChildCard,
          board: mockTaskBoard,
          column: mockTaskBoard.schema.columns[2],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440013',
        },
      });

      expect(response.statusCode).toBe(202);

      // Allow the async wakeParentIfAllChildrenDone to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockGetCardFamily).toHaveBeenCalledWith({}, mockDevBoard.uid, mockParentCard.uid);
      expect(mockMoveCard).toHaveBeenCalledWith(
        {},
        mockDevBoard.uid,
        mockParentCard.uid,
        'wrap',
        'system:task-complete',
      );
      expect(mockStartProcessing).toHaveBeenCalledWith(
        {},
        mockDevBoard,
        expect.objectContaining({ uid: mockParentCard.uid, current_status: 'wrap' }),
        expect.objectContaining({ uid: 'wrap', type: 'Processing' }),
      );
    });

    it('does not wake parent when a child is not in done', async () => {
      const incompleteChild = { ...mockChildCard, current_status: 'todo' };
      mockGetCardById.mockImplementation((_db: unknown, boardUid: string, cardUid: string) => {
        if (boardUid === mockDevBoard.uid && cardUid === mockParentCard.uid) {
          return mockParentCard;
        }
        if (boardUid === mockTaskBoard.uid && cardUid === mockChildCard.uid) {
          return incompleteChild;
        }
        return undefined;
      });
      mockGetCardFamily.mockReturnValue({
        parents: [],
        children: [{ uid: mockChildCard.uid, board_uid: mockChildCard.board_uid, display_id: mockChildCard.display_id, status: 'todo', title: mockChildCard.title, processing_state: mockChildCard.processing_state }],
      });
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440014';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-enter',
        payload: {
          card: incompleteChild,
          board: mockTaskBoard,
          column: mockTaskBoard.schema.columns[2],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440015',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockMoveCard).not.toHaveBeenCalled();
      expect(mockStartProcessing).not.toHaveBeenCalled();
    });

    it('does not wake parent when a child is in ERROR state', async () => {
      const errorChild = { ...mockChildCard, processing_state: 'ERROR' as const };
      mockGetCardById.mockImplementation((_db: unknown, boardUid: string, cardUid: string) => {
        if (boardUid === mockDevBoard.uid && cardUid === mockParentCard.uid) {
          return mockParentCard;
        }
        if (boardUid === mockTaskBoard.uid && cardUid === mockChildCard.uid) {
          return errorChild;
        }
        return undefined;
      });
      mockGetCardFamily.mockReturnValue({
        parents: [],
        children: [{ uid: mockChildCard.uid, board_uid: mockChildCard.board_uid, display_id: mockChildCard.display_id, status: 'done', title: mockChildCard.title, processing_state: 'ERROR' }],
      });
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440016';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-enter',
        payload: {
          card: errorChild,
          board: mockTaskBoard,
          column: mockTaskBoard.schema.columns[2],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440017',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockMoveCard).not.toHaveBeenCalled();
      expect(mockStartProcessing).not.toHaveBeenCalled();
    });

    it('does not wake parent when parent is not in delegated', async () => {
      const parentInWrap = { ...mockParentCard, current_status: 'wrap' };
      mockGetCardById.mockImplementation((_db: unknown, boardUid: string, cardUid: string) => {
        if (boardUid === mockDevBoard.uid && cardUid === mockParentCard.uid) {
          return parentInWrap;
        }
        if (boardUid === mockTaskBoard.uid && cardUid === mockChildCard.uid) {
          return { ...mockChildCard, processing_state: 'IDLE' as const };
        }
        return undefined;
      });
      mockGetCardFamily.mockReturnValue({
        parents: [],
        children: [{ uid: mockChildCard.uid, board_uid: mockChildCard.board_uid, display_id: mockChildCard.display_id, status: 'done', title: mockChildCard.title, processing_state: 'IDLE' }],
      });
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440018';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-enter',
        payload: {
          card: { ...mockChildCard, processing_state: 'IDLE' as const },
          board: mockTaskBoard,
          column: mockTaskBoard.schema.columns[2],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440019',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockMoveCard).not.toHaveBeenCalled();
      expect(mockStartProcessing).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-enter',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/done/on-action', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440020';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-action',
        payload: {
          card: mockChildCard,
          board: mockTaskBoard,
          column: mockTaskBoard.schema.columns[2],
          action: 'Retry',
          actor: 'user:test@example.com',
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440021',
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

  describe('POST /api/kanban-processor/done/on-exit', () => {
    it('returns 200 acknowledged', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/done/on-exit',
        payload: {
          card: mockChildCard,
          next_column: mockTaskBoard.schema.columns[2],
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });
  });
});
