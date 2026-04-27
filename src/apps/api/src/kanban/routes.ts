import type { FastifyInstance } from 'fastify';
import {
  BoardPathParamsSchema,
  CardPathParamsSchema,
  CreateCardRequestSchema,
  UpdateCardRequestSchema,
  MoveCardRequestSchema,
  TriggerActionRequestSchema,
  SyncHookDispatchRequestSchema,
  CanExitHookRequestSchema,
  ProcessorCallbackPathParamsSchema,
  ProcessorCallbackHeadersSchema,
  ProcessorCallbackRequestSchema,
} from '@repo/shared';
import {
  getBoardById,
  getSnapshot,
  getCardById,
  createCard,
  updateCard,
  moveCard,
  createBoard,
  getProcessorById,
  listBoards,
} from './repository.js';
import { dispatchSyncHook } from './hook-dispatcher.js';
import { consumeCallback, startProcessing } from './processing-orchestrator.js';
import { DEFAULT_PROCESSOR_BASE_URL, getDefaultProcessor } from './config.js';

function callRepo<TArgs extends unknown[], TReturn>(
  fn: (instance: unknown, ...args: TArgs) => TReturn,
  ...args: TArgs
): TReturn {
  return fn({}, ...args);
}

function errorResponse(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export async function kanbanRoutes(instance: FastifyInstance): Promise<void> {
  instance.get('/', async (_request, reply) => {
    const boards = await callRepo(listBoards);
    return reply.status(200).send({ data: { boards } });
  });

  instance.post('/', async (_request, reply) => {
    const board = await callRepo(createBoard);
    return reply.status(201).send({ data: { board } });
  });

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

    const currentCard = await callRepo(getCardById, params.data.boardId, params.data.cardId);
    if (!currentCard) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    const updatedCard = await callRepo(updateCard, params.data.boardId, params.data.cardId, body.data);
    if (!updatedCard) {
      const freshCard = await callRepo(getCardById, params.data.boardId, params.data.cardId);
      return reply.status(409).send({
        error: {
          code: 'CONFLICT',
          message: 'Card was modified by another user. Please refresh and retry.',
          details: {
            current_version: freshCard?.version ?? currentCard.version,
            card: freshCard ?? currentCard,
          },
        },
      });
    }

    return reply.status(200).send({ data: { card: updatedCard } });
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

    const card = await callRepo(getCardById, params.data.boardId, params.data.cardId);
    if (card) {
      if (card.processing_state === 'PROCESSING') {
        return reply.status(409).send({
          error: {
            code: 'MOVE_BLOCKED',
            message: 'Card is currently being processed',
          },
        });
      }

      const currentColumn = board.schema.columns.find((c) => c.uid === card.current_status);
      if (currentColumn) {
        const processor = (getProcessorById ? callRepo(getProcessorById, currentColumn.processor_id) : undefined) ?? getDefaultProcessor(currentColumn.processor_id);

        const dispatchRequest = SyncHookDispatchRequestSchema.parse({
          hook: 'can-exit',
          processor_id: currentColumn.processor_id,
          timeout_ms: 3000,
        });
        const hookPayload = CanExitHookRequestSchema.parse({
          card,
          target_column: body.data.to_column_uid,
          actor: 'system',
        });

        let hookResult;
        try {
          hookResult = await dispatchSyncHook(processor, dispatchRequest, hookPayload);
        } catch (_err) {
          return reply.status(409).send({
            error: {
              code: 'MOVE_BLOCKED',
              message: 'Move blocked: processor unavailable',
              details: { hook: 'can-exit' },
            },
          });
        }

        if (!hookResult.allowed) {
          return reply.status(409).send({
            error: {
              code: 'MOVE_BLOCKED',
              message: hookResult.message || 'Move blocked by processor',
              details: { hook: 'can-exit' },
            },
          });
        }
      }
    }

    const targetColumn = board.schema.columns.find((c) => c.uid === body.data.to_column_uid);

    try {
      if (targetColumn?.type === 'Processing') {
        if (!card) {
          return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
        }
        const result = await startProcessing(
          {},
          board,
          card,
          targetColumn as {
            uid: string;
            title: string;
            type: 'Processing';
            processor_id: string;
            exit_logic: Record<string, string>;
            order: number;
          },
        );
        return reply.status(200).send({ data: { card: result } });
      }

      const movedCard = await callRepo(moveCard, params.data.boardId, params.data.cardId, body.data.to_column_uid);
      if (!movedCard) {
        return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
      }
      return reply.status(200).send({ data: { card: movedCard } });
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
      return reply.status(500).send(errorResponse('MOVE_FAILED', 'Move operation failed'));
    }
  });

  instance.post('/:boardId/cards/:cardId/action', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const body = TriggerActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }

    const card = await callRepo(getCardById, params.data.boardId, params.data.cardId);
    if (!card) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    if (card.version !== body.data.version) {
      return reply.status(409).send({
        error: {
          code: 'CONFLICT',
          message: 'Card was modified by another user. Please refresh and retry.',
          details: {
            current_version: card.version,
            card,
          },
        },
      });
    }

    return reply.status(200).send({ data: { card, status: 'completed' } });
  });
}

export async function callbackRoutes(instance: FastifyInstance): Promise<void> {
  instance.post('/:token', async (request, reply) => {
    try {
      const params = ProcessorCallbackPathParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid token format', { issues: params.error.issues }));
      }

      const headers = ProcessorCallbackHeadersSchema.safeParse({ authorization: request.headers.authorization });
      if (!headers.success) {
        return reply.status(401).send(errorResponse('INVALID_AUTH', 'Invalid authorization header', { issues: headers.error.issues }));
      }

      const body = ProcessorCallbackRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
      }

      const result = await consumeCallback({}, params.data.token, headers.data.authorization, body.data);
      return reply.status(200).send({ data: { card: result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'CALLBACK_TOKEN_MISSING') {
        return reply.status(404).send({ error: { code: 'CALLBACK_TOKEN_MISSING', message: 'Callback token not found' } });
      }
      if (message === 'CALLBACK_TOKEN_EXPIRED') {
        return reply.status(410).send({ error: { code: 'CALLBACK_TOKEN_EXPIRED', message: 'Callback token has expired' } });
      }
      if (message === 'CALLBACK_TOKEN_REPLAYED') {
        return reply.status(409).send({ error: { code: 'CALLBACK_TOKEN_REPLAYED', message: 'Callback token has already been used' } });
      }
      return reply.status(500).send(errorResponse('CALLBACK_ERROR', 'Callback processing failed'));
    }
  });
}
