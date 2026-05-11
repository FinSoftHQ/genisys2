import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BoardPathParamsSchema,
  BoardIdSchema,
  CardIdSchema,
  CardPathParamsSchema,
  CreateBoardRequestSchema,
  CreateBoardSuiteRequestSchema,
  UpdateBoardRequestSchema,
  CreateCardRequestSchema,
  UpdateCardRequestSchema,
  MoveCardRequestSchema,
  TriggerActionRequestSchema,
  SyncHookDispatchRequestSchema,
  CanExitHookRequestSchema,
  ProcessorCallbackPathParamsSchema,
  ProcessorCallbackHeadersSchema,
  ProcessorCallbackRequestSchema,
  AuditLogQuerySchema,
  BoardStreamRequestHeadersSchema,
  CreateCardRelationshipRequestSchema,
  ListBoardSuitesResponseSchema,
  BoardSuiteResponseSchema,
  BoardSuiteSnapshotResponseSchema,
} from '@repo/shared';
import { randomUUID } from 'node:crypto';
import {
  getBoardById,
  getSnapshot,
  getCardById,
  createCard,
  updateCard,
  moveCard,
  deleteCard,
  createBoard,
  createSuite,
  updateBoard,
  getProcessorById,
  listBoards,
  listSuites,
  getSuiteById,
  getSuiteSnapshot,
  createCallbackToken,
  createCardRelationship,
  deleteCardRelationship,
  getCardFamily,
} from './repository.js';
import { destroyRoom } from '../agent-rooms/client.js';
import { dispatchSyncHook, dispatchOnUpdateHook, dispatchAsyncHook, dispatchFireAndForgetHook } from './hook-dispatcher.js';
import { consumeCallback, startProcessing } from './processing-orchestrator.js';
import { getDefaultProcessor } from './config.js';
import { resolveActor } from './request-actor.js';
import { subscribeToBoardEvents } from './board-stream.js';
import { queryAuditLog } from './event-log.js';

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

  instance.post('/', async (request, reply) => {
    const body = CreateBoardRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }
    try {
      const query = request.query as Record<string, unknown> | undefined;
      const suiteUid = typeof query?.suite === 'string' ? query.suite : undefined;
      const role = typeof query?.role === 'string' ? query.role : undefined;
      const board = await callRepo(createBoard, body.data.template, body.data.title, body.data.prefix, suiteUid ?? null, role ?? null);
      return reply.status(201).send({ data: { board } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'PREFIX_EXISTS') {
        return reply.status(409).send(errorResponse('PREFIX_EXISTS', 'Board prefix already exists'));
      }
      return reply.status(500).send(errorResponse('BOARD_CREATE_FAILED', 'Failed to create board'));
    }
  });

  instance.patch('/:boardId', async (request, reply) => {
    const params = BoardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const body = UpdateBoardRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }

    const board = await callRepo(updateBoard, params.data.boardId, body.data);
    if (!board) {
      return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
    }

    return reply.status(200).send({ data: { board } });
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

    const actor = resolveActor(request);
    const card = await callRepo(createCard, params.data.boardId, body.data, actor);
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

  instance.get('/:boardId/cards/:cardId/family', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const card = await callRepo(getCardById, params.data.boardId, params.data.cardId);
    if (!card) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    const family = await callRepo(getCardFamily, params.data.boardId, params.data.cardId);
    return reply.status(200).send({ data: { card, ...family } });
  });

  instance.post('/:boardId/cards/:cardId/relationships', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const body = CreateCardRelationshipRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }

    try {
      const relationship = await callRepo(createCardRelationship, params.data.boardId, params.data.cardId, body.data.child_card_uid, body.data.relationship_type ?? 'dependency', body.data.parent_board_uid ?? params.data.boardId, body.data.child_board_uid ?? params.data.boardId);
      const family = await callRepo(getCardFamily, params.data.boardId, params.data.cardId);
      return reply.status(201).send({ data: { relationship, ...family } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'BOARD_NOT_FOUND') {
        return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
      }
      if (message === 'CARD_NOT_FOUND') {
        return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
      }
      if (message === 'RELATIONSHIP_CYCLE') {
        return reply.status(409).send(errorResponse('RELATIONSHIP_CYCLE', 'Cannot create circular card relationships'));
      }
      return reply.status(500).send(errorResponse('RELATIONSHIP_CREATE_FAILED', 'Failed to create relationship'));
    }
  });

  instance.delete('/:boardId/cards/:cardId/relationships/:childCardId', async (request, reply) => {
    const params = z.object({
      boardId: BoardIdSchema,
      cardId: CardIdSchema,
      childCardId: CardIdSchema,
    }).strict().safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const removed = await callRepo(deleteCardRelationship, params.data.boardId, params.data.cardId, params.data.childCardId);
    if (!removed) {
      return reply.status(404).send(errorResponse('RELATIONSHIP_NOT_FOUND', 'Relationship not found'));
    }

    const family = await callRepo(getCardFamily, params.data.boardId, params.data.cardId);
    return reply.status(200).send({ data: { ...family } });
  });

  instance.delete('/:boardId/cards/:cardId', async (request, reply) => {
    const params = CardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const card = await callRepo(getCardById, params.data.boardId, params.data.cardId);
    if (!card) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    // If card has an active room, destroy it first
    if (card.room_id && card.processing_state === 'PROCESSING') {
      try {
        await destroyRoom(card.room_id, 'manual');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[kanban] Failed to destroy room', card.room_id, 'for deleted card:', message);
      }
    }

    const deleted = await callRepo(deleteCard, params.data.boardId, params.data.cardId);
    if (!deleted) {
      return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
    }

    return reply.status(200).send({ data: { deleted: true } });
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

    const board = await callRepo(getBoardById, params.data.boardId);
    const actor = resolveActor(request);
    let updateInput = body.data;

    // Dispatch on-update hook when payload is being modified
    if (body.data.payload !== undefined && board) {
      const currentColumn = board.schema.columns.find((c) => c.uid === currentCard.current_status);
      if (currentColumn) {
        const processor = (getProcessorById ? callRepo(getProcessorById, currentColumn.processor_id) : undefined) ?? getDefaultProcessor(currentColumn.processor_id);
        let hookResult;
        try {
          hookResult = await dispatchOnUpdateHook(processor, {
            card: currentCard,
            proposed_payload: body.data.payload,
            actor,
          });
        } catch {
          return reply.status(503).send({
            error: {
              code: 'PROCESSOR_UNAVAILABLE',
              message: 'on-update hook failed: processor unavailable',
              details: { hook: 'on-update' },
            },
          });
        }

        if (!hookResult.allowed) {
          return reply.status(403).send({
            error: {
              code: 'UPDATE_REJECTED',
              message: hookResult.message || 'Update rejected by processor',
              details: { hook: 'on-update' },
            },
          });
        }

        if (hookResult.transformed_payload) {
          updateInput = { ...body.data, payload: hookResult.transformed_payload };
        }
      }
    }

    const updatedCard = actor !== 'user:anonymous'
      ? await callRepo(updateCard, params.data.boardId, params.data.cardId, updateInput, actor)
      : await callRepo(updateCard, params.data.boardId, params.data.cardId, updateInput);
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
        } catch {
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
      const actor = resolveActor(request);
      const sourceColumn = board.schema.columns.find((c) => c.uid === card?.current_status);

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
        // Fire-and-forget on-exit for the source column
        if (sourceColumn) {
          const processor = (getProcessorById ? callRepo(getProcessorById, sourceColumn.processor_id) : undefined) ?? getDefaultProcessor(sourceColumn.processor_id);
          dispatchFireAndForgetHook(processor, 'on-exit', {
            card: result,
            next_column: targetColumn,
            actor,
          });
        }
        return reply.status(200).send({ data: { card: result } });
      }

      const movedCard = await callRepo(moveCard, params.data.boardId, params.data.cardId, body.data.to_column_uid, actor);
      if (!movedCard) {
        return reply.status(404).send(errorResponse('CARD_NOT_FOUND', 'Card not found'));
      }
      // Fire-and-forget on-exit for the source column
      if (sourceColumn) {
        const processor = (getProcessorById ? callRepo(getProcessorById, sourceColumn.processor_id) : undefined) ?? getDefaultProcessor(sourceColumn.processor_id);
        dispatchFireAndForgetHook(processor, 'on-exit', {
          card: movedCard,
          next_column: targetColumn,
          actor,
        });
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

  instance.get('/:boardId/stream', async (request, reply) => {
    const params = BoardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const rawHeaders = {
      'last-event-id': request.headers['last-event-id'],
    };
    const headers = BoardStreamRequestHeadersSchema.safeParse(rawHeaders);
    if (!headers.success) {
      return reply.status(400).send(errorResponse('INVALID_HEADERS', 'Invalid headers', { issues: headers.error.issues }));
    }

    const lastEventId = headers.data['last-event-id'];

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 15000);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      unsubscribe();
      try { reply.raw.end(); } catch {}
    };

    const unsubscribe = subscribeToBoardEvents(params.data.boardId, (chunk) => {
      try {
        reply.raw.write(chunk);
      } catch {
        cleanup();
      }
    }, lastEventId);

    const timeout = setTimeout(() => {
      cleanup();
    }, process.env.VITEST ? 10 : 300000);

    request.raw.on('close', cleanup);
    reply.raw.once('error', cleanup);
  });

  instance.get('/:boardId/audit-log', async (request, reply) => {
    const params = BoardPathParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const rawQuery: Record<string, unknown> = { ...(request.query as Record<string, unknown>) };
    if (typeof rawQuery.categories === 'string') {
      rawQuery.categories = [rawQuery.categories];
    }
    if (typeof rawQuery.actions === 'string') {
      rawQuery.actions = [rawQuery.actions];
    }

    const query = AuditLogQuerySchema.safeParse(rawQuery);
    if (!query.success) {
      return reply.status(400).send(errorResponse('INVALID_QUERY', 'Invalid query parameters', { issues: query.error.issues }));
    }

    const result = await queryAuditLog({}, params.data.boardId, query.data);
    return reply.status(200).send({ data: result });
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

    const board = await callRepo(getBoardById, params.data.boardId);
    if (!board) {
      return reply.status(404).send(errorResponse('BOARD_NOT_FOUND', 'Board not found'));
    }

    const currentColumn = board.schema.columns.find((c) => c.uid === card.current_status);
    if (!currentColumn) {
      return reply.status(404).send(errorResponse('COLUMN_NOT_FOUND', 'Column not found'));
    }

    const processor = (getProcessorById ? callRepo(getProcessorById, currentColumn.processor_id) : undefined) ?? getDefaultProcessor(currentColumn.processor_id);
    const actor = resolveActor(request);
    const token = randomUUID();
    const idempotencyKey = randomUUID();
    const callbackBaseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
    const callbackUrl = `${callbackBaseUrl.replace(/\/$/, '')}/api/callbacks/${token}`;
    const expiresAt = new Date(Date.now() + (processor.max_sla_seconds ?? 600) * 1000).toISOString();

    createCallbackToken({}, {
      token,
      card_uid: card.uid,
      processor_id: currentColumn.processor_id,
      hook: 'on-action',
      idempotency_key: idempotencyKey,
      context: { action: body.data.action },
      expires_at: expiresAt,
    });

    try {
      await dispatchAsyncHook(processor, 'on-action', {
        card,
        board,
        column: currentColumn,
        action: body.data.action,
        actor,
        callback_url: callbackUrl,
        idempotency_key: idempotencyKey,
      });
    } catch {
      return reply.status(503).send({
        error: {
          code: 'PROCESSOR_UNAVAILABLE',
          message: 'Processor is currently unavailable',
          details: { processor_id: currentColumn.processor_id },
        },
      });
    }

    return reply.status(200).send({ data: { card, status: 'accepted' } });
  });
}

export async function suiteRoutes(instance: FastifyInstance): Promise<void> {
  instance.post('/', async (request, reply) => {
    const body = CreateBoardSuiteRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send(errorResponse('INVALID_BODY', 'Invalid request body', { issues: body.error.issues }));
    }
    try {
      const result = await callRepo(createSuite, body.data.template, body.data.title);
      return reply.status(201).send(BoardSuiteResponseSchema.parse({ data: result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send(errorResponse('SUITE_CREATE_FAILED', message || 'Failed to create suite'));
    }
  });

  instance.get('/', async (_request, reply) => {
    const suites = await callRepo(listSuites);
    return reply.status(200).send(ListBoardSuitesResponseSchema.parse({ data: { suites } }));
  });

  instance.get('/:suiteId', async (request, reply) => {
    const params = z.object({ suiteId: BoardIdSchema }).strict().safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const suite = await callRepo(getSuiteById, params.data.suiteId);
    if (!suite) {
      return reply.status(404).send(errorResponse('SUITE_NOT_FOUND', 'Suite not found'));
    }

    return reply.status(200).send(BoardSuiteResponseSchema.parse({ data: suite }));
  });

  instance.get('/:suiteId/snapshot', async (request, reply) => {
    const params = z.object({ suiteId: BoardIdSchema }).strict().safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorResponse('INVALID_PARAMS', 'Invalid path parameters', { issues: params.error.issues }));
    }

    const snapshot = await callRepo(getSuiteSnapshot, params.data.suiteId);
    if (!snapshot) {
      return reply.status(404).send(errorResponse('SUITE_NOT_FOUND', 'Suite not found'));
    }

    return reply.status(200).send(BoardSuiteSnapshotResponseSchema.parse({ data: snapshot }));
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
