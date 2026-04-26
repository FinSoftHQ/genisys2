import type { FastifyInstance } from 'fastify';
import {
  BoardPathParamsSchema,
  CardPathParamsSchema,
  CreateCardRequestSchema,
  UpdateCardRequestSchema,
  MoveCardRequestSchema,
} from '@repo/shared';
import {
  getBoardById,
  getSnapshot,
  getCardById,
  createCard,
  updateCard,
  moveCard,
} from './repository.js';

function callRepo<TArgs extends unknown[], TReturn>(
  fn: (instance: unknown, ...args: TArgs) => TReturn,
  ...args: TArgs
): TReturn {
  return fn(undefined, ...args);
}

function errorResponse(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export async function kanbanRoutes(instance: FastifyInstance): Promise<void> {
  instance.get('/:boardId/snapshot', async (request, reply) => {
    const params = BoardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const snapshot = await callRepo(getSnapshot, params.data.boardId);
    if (!snapshot) {
      return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
    }

    return reply.status(200).send({ data: snapshot });
  });

  instance.post('/:boardId/cards', async (request, reply) => {
    const params = BoardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const board = await callRepo(getBoardById, params.data.boardId);
    if (!board) {
      return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
    }

    const body = CreateCardRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }

    const validColumns = new Set(board.schema.columns.map((c) => c.uid));
    if (!validColumns.has(body.data.current_status)) {
      return reply.status(400).send(errorResponse('INVALID_COLUMN', 'Invalid current_status for this board'));
    }

    const card = await callRepo(createCard, params.data.boardId, body.data);
    return reply.status(201).send({ data: { card } });
  });

  instance.get('/:boardId/cards/:cardId', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const card = await callRepo(getCardById, params.data.boardId, params.data.cardId);
    if (!card) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    return reply.status(200).send({ data: { card } });
  });

  instance.patch('/:boardId/cards/:cardId', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const body = UpdateCardRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }

    const card = await callRepo(updateCard, params.data.boardId, params.data.cardId, body.data);
    if (!card) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    return reply.status(200).send({ data: { card } });
  });

  instance.post('/:boardId/cards/:cardId/move', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const body = MoveCardRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }

    const board = await callRepo(getBoardById, params.data.boardId);
    if (!board) {
      return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
    }

    const validColumns = new Set(board.schema.columns.map((c) => c.uid));
    if (!validColumns.has(body.data.to_column_uid)) {
      return reply.status(400).send(errorResponse('INVALID_COLUMN', 'Invalid target column for this board'));
    }

    try {
      const card = await callRepo(moveCard, params.data.boardId, params.data.cardId, body.data.to_column_uid);
      if (!card) {
        return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
      }
      return reply.status(200).send({ data: { card } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'CARD_NOT_FOUND') {
        return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
      }
      if (message === 'BOARD_NOT_FOUND') {
        return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
      }
      if (message === 'INVALID_COLUMN') {
        return reply.status(400).send(errorResponse('INVALID_COLUMN', 'Invalid target column for this board'));
      }
      return reply.status(500).send(errorResponse('MOVE_FAILED', message));
    }
  });
}
