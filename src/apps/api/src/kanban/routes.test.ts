import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SnapshotResponseSchema,
  CreateCardResponseSchema,
  GetCardResponseSchema,
  UpdateCardResponseSchema,
  MoveCardResponseSchema,
  CreateBoardResponseSchema,
  ApiErrorSchema,
  CardConflictResponseSchema,
  MoveCardBlockedResponseSchema,
  ProcessorCallbackResponseSchema,
  CallbackTokenRejectedResponseSchema,
  TriggerActionResponseSchema,
  ListBoardsResponseSchema,
  AuditLogResponseSchema,
  AuditLogQuerySchema,
  BoardStreamSseEventSchema,
} from '@repo/shared';
import { kanbanRoutes, callbackRoutes } from './routes.js';
import * as repository from './repository.js';
import { dispatchSyncHook, dispatchOnUpdateHook, dispatchAsyncHook, dispatchFireAndForgetHook } from './hook-dispatcher.js';
import { consumeCallback, startProcessing } from './processing-orchestrator.js';
import { subscribeToBoardEvents, broadcastEvent } from './board-stream.js';
import { appendEventLog, queryAuditLog } from './event-log.js';
import { resolveActor } from './request-actor.js';

vi.mock('./repository.js', () => ({
  getBoardById: vi.fn(),
  getSnapshot: vi.fn(),
  getCardById: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  moveCard: vi.fn(),
  createBoard: vi.fn(),
  getProcessorById: vi.fn(),
  listBoards: vi.fn(),
  createCallbackToken: vi.fn(),
}));

vi.mock('./hook-dispatcher.js', () => ({
  dispatchSyncHook: vi.fn(),
  dispatchOnUpdateHook: vi.fn(),
  dispatchAsyncHook: vi.fn(),
  dispatchFireAndForgetHook: vi.fn(),
}));

vi.mock('./processing-orchestrator.js', () => ({
  consumeCallback: vi.fn(),
  startProcessing: vi.fn(),
}));

vi.mock('./board-stream.js', () => ({
  subscribeToBoardEvents: vi.fn(() => () => {}),
  broadcastEvent: vi.fn(),
}));

vi.mock('./event-log.js', () => ({
  appendEventLog: vi.fn((db, event) => event),
  queryAuditLog: vi.fn(() => ({ events: [], next_cursor: null })),
}));

vi.mock('./request-actor.js', () => ({
  resolveActor: vi.fn(() => 'user:anonymous'),
}));

const mockBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      {
        uid: 'backlog',
        title: 'Backlog',
        type: 'Normal',
        processor_id: 'default-manual',
        exit_logic: { default: 'in-progress' },
        order: 0,
      },
      {
        uid: 'in-progress',
        title: 'In Progress',
        type: 'Normal',
        processor_id: 'default-manual',
        exit_logic: { default: 'done' },
        order: 1,
      },
      {
        uid: 'done',
        title: 'Done',
        type: 'Normal',
        processor_id: 'default-manual',
        exit_logic: {},
        order: 2,
      },
    ],
  },
  permissions: { read: [], write: [] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

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
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('kanban routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    await app.register(kanbanRoutes, { prefix: '/api/boards' });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/boards', () => {
    it('returns 200 with data envelope containing list of boards', async () => {
      vi.mocked(repository.listBoards).mockReturnValue([mockBoard]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/boards',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(ListBoardsResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.boards).toHaveLength(1);
      expect(body.data.boards[0].uid).toBe(mockBoard.uid);
    });

    it('returns empty array when no boards exist', async () => {
      vi.mocked(repository.listBoards).mockReturnValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/boards',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(ListBoardsResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.boards).toHaveLength(0);
    });
  });

  describe('POST /api/boards', () => {
    it('returns 201 with data envelope containing the new board', async () => {
      vi.mocked(repository.createBoard).mockReturnValue(mockBoard);

      const response = await app.inject({
        method: 'POST',
        url: '/api/boards',
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(CreateBoardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.board.uid).toBe(mockBoard.uid);
    });
  });

  describe('GET /api/boards/:boardId/snapshot', () => {
    it('returns 200 with data envelope containing board and cards', async () => {
      vi.mocked(repository.getSnapshot).mockResolvedValue({
        board: mockBoard,
        cards: [mockCard],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/snapshot`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(SnapshotResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.board.uid).toBe(mockBoard.uid);
      expect(body.data.cards).toHaveLength(1);
    });

    it('returns 404 for unknown board', async () => {
      vi.mocked(repository.getSnapshot).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/boards/00000000-0000-0000-0000-000000000000/snapshot',
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed boardId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boards/not-a-uuid/snapshot',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('uses strict data envelope with no extra top-level keys', async () => {
      vi.mocked(repository.getSnapshot).mockResolvedValue({
        board: mockBoard,
        cards: [mockCard],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/snapshot`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body)).toEqual(['data']);
      expect(SnapshotResponseSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/boards/:boardId/cards', () => {
    it('returns 201 with data envelope when card is created', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.createCard).mockResolvedValue(mockCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: {
          title: 'New Card',
          current_status: 'backlog',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(CreateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.title).toBe('Test Card');
    });

    it('returns 400 when current_status is not a valid board column', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: {
          title: 'New Card',
          current_status: 'nonexistent-column',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 404 for unknown board', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/boards/00000000-0000-0000-0000-000000000000/cards',
        payload: {
          title: 'New Card',
          current_status: 'backlog',
        },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for whitespace-only title', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: {
          title: '   ',
          current_status: 'backlog',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed boardId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/boards/not-a-uuid/cards',
        payload: {
          title: 'New Card',
          current_status: 'backlog',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('GET /api/boards/:boardId/cards/:cardId', () => {
    it('returns 200 with data envelope when card exists', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(GetCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.uid).toBe(mockCard.uid);
    });

    it('returns 404 for unknown card', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/cards/00000000-0000-0000-0000-000000000000`,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed cardId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/cards/not-a-uuid`,
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('PATCH /api/boards/:boardId/cards/:cardId', () => {
    it('returns 200 with data envelope when card is updated', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      const updatedCard = { ...mockCard, title: 'Updated Title', version: 2 };
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(UpdateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.title).toBe('Updated Title');
      expect(body.data.card.version).toBe(2);
    });

    it('returns 404 for unknown card', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(null);
      vi.mocked(repository.updateCard).mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/00000000-0000-0000-0000-000000000000`,
        payload: { version: 1, title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for empty update payload', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed boardId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/not-a-uuid/cards/${mockCard.uid}`,
        payload: { title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed cardId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/not-a-uuid`,
        payload: { title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('dispatches on-update hook when payload is provided', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchOnUpdateHook).mockResolvedValue({ allowed: true });
      const updatedCard = { ...mockCard, payload: { reviewed: true }, version: 2 };
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, payload: { reviewed: true } },
      });

      expect(response.statusCode).toBe(200);
      expect(dispatchOnUpdateHook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card: expect.objectContaining({ uid: mockCard.uid }),
          proposed_payload: { reviewed: true },
        }),
      );
    });

    it('applies transformed_payload from on-update hook', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchOnUpdateHook).mockResolvedValue({ allowed: true, transformed_payload: { reviewed: true, approved: true } });
      const updatedCard = { ...mockCard, payload: { reviewed: true, approved: true }, version: 2 };
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, payload: { reviewed: true } },
      });

      expect(repository.updateCard).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        mockCard.uid,
        expect.objectContaining({ payload: { reviewed: true, approved: true } }),
      );
    });

    it('returns 403 when on-update hook rejects', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchOnUpdateHook).mockResolvedValue({ allowed: false, message: 'Invalid payload' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, payload: { reviewed: true } },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('UPDATE_REJECTED');
    });

    it('returns 503 when on-update processor is unavailable', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchOnUpdateHook).mockRejectedValue(new Error('Timeout'));

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, payload: { reviewed: true } },
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error.code).toBe('PROCESSOR_UNAVAILABLE');
    });
  });

  describe('POST /api/boards/:boardId/cards/:cardId/move', () => {
    it('returns 200 with data envelope when card is moved', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: true });
      const movedCard = { ...mockCard, current_status: 'in-progress' };
      vi.mocked(repository.moveCard).mockResolvedValue(movedCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(MoveCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.current_status).toBe('in-progress');
    });

    it('returns 400 when target column does not exist on board', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.moveCard).mockRejectedValue(new Error('INVALID_COLUMN'));

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'nonexistent-column' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 404 for unknown card', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(null);
      vi.mocked(repository.moveCard).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/00000000-0000-0000-0000-000000000000/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed boardId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/boards/not-a-uuid/cards/00000000-0000-0000-0000-000000000000/move',
        payload: { to_column_uid: 'in-progress' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 for malformed cardId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/not-a-uuid/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/boards/:boardId/cards — strict contract', () => {
    it('returns the exact card from repository without overriding fields from request body', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.createCard).mockResolvedValue({ ...mockCard, title: 'Repo-Title' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: {
          title: 'Body-Title',
          current_status: 'backlog',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(CreateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.title).toBe('Repo-Title');
    });

    it('accepts explicit null description', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.createCard).mockResolvedValue(mockCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: {
          title: 'Card With Null Desc',
          current_status: 'backlog',
          description: null,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(CreateCardResponseSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('GET /api/boards/:boardId/snapshot — no pagination metadata', () => {
    it('contains no pagination fields in the response body', async () => {
      vi.mocked(repository.getSnapshot).mockResolvedValue({
        board: mockBoard,
        cards: [mockCard],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/snapshot`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).not.toHaveProperty('nextCursor');
      expect(body).not.toHaveProperty('cursor');
      expect(body).not.toHaveProperty('total');
      expect(body).not.toHaveProperty('page');
      expect(body).not.toHaveProperty('limit');
      expect(body).not.toHaveProperty('hasMore');
      expect(SnapshotResponseSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('PATCH /api/boards/:boardId/cards/:cardId — description null', () => {
    it('accepts explicit null description', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      const updatedCard = { ...mockCard, description: null, version: 2 };
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, description: null },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(UpdateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.description).toBeNull();
    });
  });

  describe('PATCH /api/boards/:boardId/cards/:cardId — Slice 2 optimistic locking', () => {
    it('returns 400 when version is missing from request body', async () => {
      vi.mocked(repository.updateCard).mockResolvedValue({ ...mockCard, title: 'Updated' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 409 Conflict with CardConflictResponseSchema when version is stale', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.updateCard).mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(CardConflictResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details.current_version).toBe(mockCard.version);
      expect(body.error.details.card.uid).toBe(mockCard.uid);
    });

    it('returns 404 when card does not exist', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(null);
      vi.mocked(repository.updateCard).mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/00000000-0000-0000-0000-000000000000`,
        payload: { version: 1, title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 200 when version matches and update succeeds', async () => {
      const updatedCard = { ...mockCard, title: 'Updated Title', version: 2 };
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(UpdateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.version).toBe(2);
    });

    it('does not mutate card when version is stale', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      const repoSpy = vi.mocked(repository.updateCard).mockResolvedValue(null);

      await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, title: 'Updated Title' },
      });

      expect(repoSpy).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        mockCard.uid,
        expect.objectContaining({ version: 1, title: 'Updated Title' }),
      );
    });
  });

  describe('POST /api/boards/:boardId/cards/:cardId/move — Slice 2 can-exit hook', () => {
    it('dispatches can-exit hook before moving', async () => {
      const movedCard = { ...mockCard, current_status: 'in-progress', version: 2 };
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: true });
      vi.mocked(repository.moveCard).mockResolvedValue(movedCard);

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(dispatchSyncHook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          hook: 'can-exit',
          processor_id: 'default-manual',
          timeout_ms: 3000,
        }),
        expect.objectContaining({
          card: expect.objectContaining({ uid: mockCard.uid }),
          target_column: 'in-progress',
          actor: expect.any(String),
        }),
      );
    });

    it('returns 409 MoveCardBlockedResponseSchema when can-exit blocks', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: false, message: 'Approval pending' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(MoveCardBlockedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('MOVE_BLOCKED');
      expect(body.error.message).toBe('Approval pending');
      expect(body.error.details.hook).toBe('can-exit');
    });

    it('does not call moveCard when can-exit hook blocks', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: false, message: 'Blocked' });

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(repository.moveCard).not.toHaveBeenCalled();
    });

    it('returns 200 and increments version on successful move', async () => {
      const movedCard = { ...mockCard, current_status: 'in-progress', version: 2 };
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: true });
      vi.mocked(repository.moveCard).mockResolvedValue(movedCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(MoveCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.current_status).toBe('in-progress');
      expect(body.data.card.version).toBe(2);
    });

    it('dispatches on-exit fire-and-forget after successful move', async () => {
      const movedCard = { ...mockCard, current_status: 'in-progress', version: 2 };
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: true });
      vi.mocked(repository.moveCard).mockResolvedValue(movedCard);

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
      });

      expect(dispatchFireAndForgetHook).toHaveBeenCalledWith(
        expect.anything(),
        'on-exit',
        expect.objectContaining({
          card: expect.objectContaining({ uid: mockCard.uid, current_status: 'in-progress' }),
          next_column: expect.objectContaining({ uid: 'in-progress' }),
        }),
      );
    });

    it('dispatches on-exit fire-and-forget after moving to Processing column', async () => {
      const processingBoard = {
        ...mockBoard,
        schema: {
          columns: [
            {
              uid: 'backlog',
              title: 'Backlog',
              type: 'Normal',
              processor_id: 'default-manual',
              exit_logic: { default: 'in-review' },
              order: 0,
            },
            {
              uid: 'in-review',
              title: 'In Review',
              type: 'Processing',
              processor_id: 'manager-approval',
              exit_logic: { approved: 'done', rejected: 'backlog' },
              order: 1,
            },
          ],
        },
      };
      const processingCard = { ...mockCard, current_status: 'in-review', processing_state: 'PROCESSING', is_editable: false, version: 2 };
      vi.mocked(repository.getBoardById).mockResolvedValue(processingBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: true });
      vi.mocked(startProcessing).mockResolvedValue(processingCard);

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-review' },
      });

      expect(dispatchFireAndForgetHook).toHaveBeenCalledWith(
        expect.anything(),
        'on-exit',
        expect.objectContaining({
          card: expect.objectContaining({ uid: mockCard.uid, current_status: 'in-review' }),
          next_column: expect.objectContaining({ uid: 'in-review' }),
        }),
      );
    });
  });

  describe('POST /api/boards/:boardId/cards/:cardId/move — Slice 3 Processing column', () => {
    const processingBoard = {
      ...mockBoard,
      schema: {
        columns: [
          {
            uid: 'backlog',
            title: 'Backlog',
            type: 'Normal',
            processor_id: 'default-manual',
            exit_logic: { default: 'in-review' },
            order: 0,
          },
          {
            uid: 'in-review',
            title: 'In Review',
            type: 'Processing',
            processor_id: 'manager-approval',
            exit_logic: { approved: 'done', rejected: 'backlog' },
            order: 1,
          },
          {
            uid: 'done',
            title: 'Done',
            type: 'Normal',
            processor_id: 'default-manual',
            exit_logic: {},
            order: 2,
          },
        ],
      },
    };

    it('triggers startProcessing when moving into a Processing column', async () => {
      const processingCard = { ...mockCard, current_status: 'in-review', processing_state: 'PROCESSING', is_editable: false, version: 2 };
      vi.mocked(repository.getBoardById).mockResolvedValue(processingBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(dispatchSyncHook).mockResolvedValue({ allowed: true });
      vi.mocked(repository.moveCard).mockResolvedValue(processingCard);
      vi.mocked(startProcessing).mockResolvedValue(processingCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-review' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(MoveCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.processing_state).toBe('PROCESSING');
      expect(body.data.card.is_editable).toBe(false);
    });

    it('does not allow direct move out of PROCESSING state card', async () => {
      const lockedCard = { ...mockCard, processing_state: 'PROCESSING', is_editable: false };
      vi.mocked(repository.getBoardById).mockResolvedValue(processingBoard);
      vi.mocked(repository.getCardById).mockResolvedValue(lockedCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'done' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('MOVE_BLOCKED');
    });
  });

  describe('POST /api/boards/:boardId/cards/:cardId/action', () => {
    it('returns 200 with card and status accepted', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchAsyncHook).mockResolvedValue({ status: 'accepted' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/action`,
        payload: { action: 'Approve', version: 1 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(TriggerActionResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.uid).toBe(mockCard.uid);
      expect(body.data.status).toBe('accepted');
    });

    it('dispatches on-action async hook with callback token', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchAsyncHook).mockResolvedValue({ status: 'accepted' });

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/action`,
        payload: { action: 'Approve', version: 1 },
      });

      expect(dispatchAsyncHook).toHaveBeenCalledWith(
        expect.anything(),
        'on-action',
        expect.objectContaining({
          card: expect.objectContaining({ uid: mockCard.uid }),
          board: expect.objectContaining({ uid: mockBoard.uid }),
          column: expect.objectContaining({ uid: 'backlog' }),
          action: 'Approve',
          callback_url: expect.stringContaining('/api/callbacks/'),
          idempotency_key: expect.any(String),
        }),
      );
      expect(repository.createCallbackToken).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: mockCard.uid,
          hook: 'on-action',
        }),
      );
    });

    it('returns 503 when processor is unavailable for on-action', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(dispatchAsyncHook).mockRejectedValue(new Error('Connection refused'));

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/action`,
        payload: { action: 'Approve', version: 1 },
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('PROCESSOR_UNAVAILABLE');
    });

    it('returns 404 for unknown card', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/00000000-0000-0000-0000-000000000000/action`,
        payload: { action: 'Approve', version: 1 },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 409 when version is stale', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);

      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/action`,
        payload: { action: 'Approve', version: 99 },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(CardConflictResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('CONFLICT');
    });

    it('returns 400 for invalid params', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/not-a-uuid/action`,
        payload: { action: 'Approve', version: 1 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 when action is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/action`,
        payload: { version: 1 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/callbacks/:token — Slice 3 callback receiver', () => {
    let callbackApp: FastifyInstance;

    beforeEach(async () => {
      callbackApp = fastify();
      await callbackApp.register(callbackRoutes, { prefix: '/api/callbacks' });
    });

    afterEach(async () => {
      await callbackApp.close();
    });

    it('returns 200 with ProcessorCallbackResponseSchema on success', async () => {
      const updatedCard = {
        ...mockCard,
        current_status: 'done',
        processing_state: 'IDLE',
        is_editable: true,
        version: 2,
      };
      vi.mocked(consumeCallback).mockResolvedValue(updatedCard);

      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Bearer some-token' },
        payload: { status: 'success', move_to_column: 'done' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(ProcessorCallbackResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.current_status).toBe('done');
    });

    it('returns 401 when authorization header is missing', async () => {
      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        payload: { status: 'success' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 401 when authorization is not Bearer', async () => {
      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Basic token' },
        payload: { status: 'success' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 404 CALLBACK_TOKEN_MISSING for unknown token', async () => {
      vi.mocked(consumeCallback).mockRejectedValue(new Error('CALLBACK_TOKEN_MISSING'));

      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Bearer token' },
        payload: { status: 'success' },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(CallbackTokenRejectedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('CALLBACK_TOKEN_MISSING');
    });

    it('returns 410 CALLBACK_TOKEN_EXPIRED for expired token', async () => {
      vi.mocked(consumeCallback).mockRejectedValue(new Error('CALLBACK_TOKEN_EXPIRED'));

      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Bearer token' },
        payload: { status: 'success' },
      });

      expect(response.statusCode).toBe(410);
      const body = response.json();
      expect(CallbackTokenRejectedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('CALLBACK_TOKEN_EXPIRED');
    });

    it('returns 409 CALLBACK_TOKEN_REPLAYED for replayed token', async () => {
      vi.mocked(consumeCallback).mockRejectedValue(new Error('CALLBACK_TOKEN_REPLAYED'));

      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Bearer token' },
        payload: { status: 'success' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(CallbackTokenRejectedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('CALLBACK_TOKEN_REPLAYED');
    });

    it('returns 400 for malformed token UUID', async () => {
      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/not-a-uuid',
        headers: { authorization: 'Bearer token' },
        payload: { status: 'success' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 400 when status=error without error_message', async () => {
      const response = await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Bearer token' },
        payload: { status: 'error' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('passes payload_updates to consumeCallback', async () => {
      const updatedCard = { ...mockCard, title: 'Updated via callback', version: 2 };
      vi.mocked(consumeCallback).mockResolvedValue(updatedCard);

      await callbackApp.inject({
        method: 'POST',
        url: '/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        headers: { authorization: 'Bearer token' },
        payload: {
          status: 'success',
          payload_updates: { title: 'Updated via callback' },
        },
      });

      expect(consumeCallback).toHaveBeenCalledWith(
        expect.anything(),
        '550e8400-e29b-41d4-a716-446655440001',
        'Bearer token',
        expect.objectContaining({
          status: 'success',
          payload_updates: { title: 'Updated via callback' },
        }),
      );
    });
  });

  describe('GET /api/boards/:boardId/stream — Slice 4 SSE', () => {
    it('returns 400 for malformed boardId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boards/not-a-uuid/stream',
      });

      expect(response.statusCode).toBe(400);
      expect(ApiErrorSchema.safeParse(response.json()).success).toBe(true);
    });

    it('returns 200 with Content-Type text/event-stream', async () => {
      vi.mocked(subscribeToBoardEvents).mockImplementation((_boardUid, handler) => {
        handler('id: test\nevent: test\ndata: {}\n\n');
        return () => {};
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/stream`,
        simulate: { close: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    });

    it('passes Last-Event-ID header to subscribeToBoardEvents', async () => {
      await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/stream`,
        headers: { 'last-event-id': '550e8400-e29b-41d4-a716-446655440001' },
        simulate: { close: true },
      });

      expect(subscribeToBoardEvents).toHaveBeenCalledWith(
        mockBoard.uid,
        expect.any(Function),
        '550e8400-e29b-41d4-a716-446655440001',
      );
    });

    it('emits SSE events with id equal to event_log.event_id', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440002';
      vi.mocked(subscribeToBoardEvents).mockImplementation((_boardUid, handler) => {
        handler(`id: ${eventId}\nevent: CARD_CREATED\ndata: {\\"event_id\\":\\"${eventId}\\"}\n\n`);
        return () => {};
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/stream`,
        simulate: { close: true },
      });

      expect(response.payload).toContain(`id: ${eventId}`);
    });

    it('cleans up subscription on request close', async () => {
      const unsubscribeSpy = vi.fn();
      vi.mocked(subscribeToBoardEvents).mockImplementation((_boardUid, handler) => {
        handler('id: test\nevent: test\ndata: {}\n\n');
        return unsubscribeSpy;
      });

      await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/stream`,
        simulate: { close: true },
      });

      expect(unsubscribeSpy).toHaveBeenCalled();
    });
  });

  describe('GET /api/boards/:boardId/audit-log — Slice 4 audit', () => {
    it('returns 200 with valid AuditLogResponseSchema', async () => {
      vi.mocked(queryAuditLog).mockResolvedValue({
        events: [
          {
            event_id: '550e8400-e29b-41d4-a716-446655440003',
            card_uid: mockCard.uid,
            board_uid: mockBoard.uid,
            timestamp: '2026-04-27T00:00:00.000Z',
            actor: 'alice',
            action: 'CARD_CREATED',
            category: 'user_action',
            lifecycle_event: null,
            from_column: null,
            to_column: null,
          },
        ],
        next_cursor: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/audit-log`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(AuditLogResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.events).toHaveLength(1);
      expect(body.data.events[0].board_uid).toBe(mockBoard.uid);
    });

    it('validates query parameters against AuditLogQuerySchema', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/audit-log?limit=999`,
      });

      expect(response.statusCode).toBe(400);
      expect(ApiErrorSchema.safeParse(response.json()).success).toBe(true);
    });

    it('passes validated query to queryAuditLog', async () => {
      vi.mocked(queryAuditLog).mockResolvedValue({ events: [], next_cursor: null });

      await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/audit-log?limit=10&cursor=next&from=2026-04-01T00:00:00.000Z&to=2026-04-30T00:00:00.000Z&categories=user_action&actions=CARD_CREATED&card_uid=${mockCard.uid}`,
      });

      expect(queryAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        expect.objectContaining({
          limit: 10,
          cursor: 'next',
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-30T00:00:00.000Z',
          categories: ['user_action'],
          actions: ['CARD_CREATED'],
          card_uid: mockCard.uid,
        }),
      );
    });

    it('returns empty events array when no audit entries exist', async () => {
      vi.mocked(queryAuditLog).mockResolvedValue({ events: [], next_cursor: null });

      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/audit-log`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(AuditLogResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.events).toEqual([]);
      expect(body.data.next_cursor).toBeNull();
    });

    it('returns 400 when from is after to', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/boards/${mockBoard.uid}/audit-log?from=2026-04-30T00:00:00.000Z&to=2026-04-01T00:00:00.000Z`,
      });

      expect(response.statusCode).toBe(400);
      expect(ApiErrorSchema.safeParse(response.json()).success).toBe(true);
    });
  });

  describe('actor resolution — Slice 4', () => {
    it('uses x-actor header value for create card', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.createCard).mockResolvedValue(mockCard);
      vi.mocked(resolveActor).mockReturnValue('alice');

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: { title: 'New Card', current_status: 'backlog' },
        headers: { 'x-actor': 'alice' },
      });

      expect(resolveActor).toHaveBeenCalled();
      expect(repository.createCard).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        expect.anything(),
        'alice',
      );
    });

    it('falls back to user:anonymous when x-actor is absent', async () => {
      vi.mocked(repository.getBoardById).mockResolvedValue(mockBoard);
      vi.mocked(repository.createCard).mockResolvedValue(mockCard);
      vi.mocked(resolveActor).mockReturnValue('user:anonymous');

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards`,
        payload: { title: 'New Card', current_status: 'backlog' },
      });

      expect(repository.createCard).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        expect.anything(),
        'user:anonymous',
      );
    });

    it('uses resolved actor for update card', async () => {
      vi.mocked(repository.getCardById).mockResolvedValue(mockCard);
      vi.mocked(repository.updateCard).mockResolvedValue({ ...mockCard, version: 2 });
      vi.mocked(resolveActor).mockReturnValue('bob');

      await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { version: 1, title: 'Updated' },
        headers: { 'x-actor': 'bob' },
      });

      expect(repository.updateCard).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        mockCard.uid,
        expect.anything(),
        'bob',
      );
    });

    it('uses resolved actor for move card', async () => {
      vi.mocked(repository.moveCard).mockResolvedValue({ ...mockCard, current_status: 'in-progress' });
      vi.mocked(resolveActor).mockReturnValue('charlie');

      await app.inject({
        method: 'POST',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}/move`,
        payload: { to_column_uid: 'in-progress' },
        headers: { 'x-actor': 'charlie' },
      });

      expect(repository.moveCard).toHaveBeenCalledWith(
        expect.anything(),
        mockBoard.uid,
        mockCard.uid,
        'in-progress',
        'charlie',
      );
    });
  });
});
