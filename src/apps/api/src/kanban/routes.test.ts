import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SnapshotResponseSchema,
  CreateCardResponseSchema,
  GetCardResponseSchema,
  UpdateCardResponseSchema,
  MoveCardResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';
import { kanbanRoutes } from './routes.js';
import * as repository from './repository.js';

vi.mock('./repository.js', () => ({
  getBoardById: vi.fn(),
  getSnapshot: vi.fn(),
  getCardById: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  moveCard: vi.fn(),
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
      const updatedCard = { ...mockCard, title: 'Updated Title', version: 2 };
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(UpdateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.title).toBe('Updated Title');
      expect(body.data.card.version).toBe(2);
    });

    it('returns 404 for unknown card', async () => {
      vi.mocked(repository.updateCard).mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/00000000-0000-0000-0000-000000000000`,
        payload: { title: 'Updated Title' },
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
  });

  describe('POST /api/boards/:boardId/cards/:cardId/move', () => {
    it('returns 200 with data envelope when card is moved', async () => {
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
      const updatedCard = { ...mockCard, description: null, version: 2 };
      vi.mocked(repository.updateCard).mockResolvedValue(updatedCard);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${mockBoard.uid}/cards/${mockCard.uid}`,
        payload: { description: null },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(UpdateCardResponseSchema.safeParse(body).success).toBe(true);
      expect(body.data.card.description).toBeNull();
    });
  });
});
