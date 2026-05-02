import type { FastifyInstance } from 'fastify';
import {
  OnEnterDispatchRequestSchema,
  OnUpdateRequestSchema,
  OnUpdateResponseSchema,
  OnActionRequestSchema,
  OnExitRequestSchema,
  CanExitHookRequestSchema,
  CanExitHookResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  HealthCheckResponseSchema,
} from '@repo/shared';
import { getBoardById, getCardById, getCardFamily, listBoards, moveCard } from './repository.js';
import { startProcessing } from './processing-orchestrator.js';

function errorResponse(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function fireAndForgetCallback(callbackUrl: string, payload: Record<string, unknown>) {
  fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer processor',
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('[done] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

function findCardByUidAcrossBoards(cardUid: string) {
  const allBoards = listBoards({});
  for (const board of allBoards) {
    const card = getCardById({}, board.uid, cardUid);
    if (card) {
      return card;
    }
  }
  return undefined;
}

async function wakeParentIfAllChildrenDone(card: { payload: Record<string, unknown> }): Promise<void> {
  const parentBoardUid = typeof card.payload.parent_board_uid === 'string' ? card.payload.parent_board_uid : undefined;
  const parentCardUid = typeof card.payload.parent_card_uid === 'string' ? card.payload.parent_card_uid : undefined;

  if (!parentBoardUid || !parentCardUid) {
    return;
  }

  const parent = getCardById({}, parentBoardUid, parentCardUid);
  if (!parent) {
    return;
  }

  const family = getCardFamily({}, parentBoardUid, parentCardUid);
  if (family.children.length === 0) {
    return;
  }

  const allDone = family.children.every((childMeta) => {
    const child = findCardByUidAcrossBoards(childMeta.uid);
    return Boolean(child && child.current_status === 'done' && child.processing_state !== 'ERROR');
  });

  if (!allDone) {
    return;
  }

  const parentBoard = getBoardById({}, parentBoardUid);
  if (!parentBoard) {
    return;
  }

  const currentParent = getCardById({}, parentBoardUid, parentCardUid);
  if (!currentParent || currentParent.current_status !== 'delegated') {
    return;
  }

  const moved = moveCard({}, parentBoardUid, parentCardUid, 'wrap', 'system:task-complete');
  const wrapColumn = parentBoard.schema.columns.find((c) => c.uid === 'wrap');
  if (wrapColumn?.type === 'Processing') {
    await startProcessing({}, parentBoard, moved, wrapColumn as {
      uid: string;
      title: string;
      type: 'Processing';
      processor_id: string;
      exit_logic: Record<string, string>;
      order: number;
    });
  }
}

export async function doneProcessorRoutes(instance: FastifyInstance): Promise<void> {
  instance.get('/health', async (_request, reply) => {
    const response = HealthCheckResponseSchema.parse({ status: 'healthy' });
    return reply.status(200).send(response);
  });

  instance.post('/can-exit', async (request, reply) => {
    const body = CanExitHookRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = CanExitHookResponseSchema.parse({ allowed: true });
    return reply.status(200).send(response);
  });

  instance.post('/on-update', async (request, reply) => {
    const body = OnUpdateRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnUpdateResponseSchema.parse({ allowed: true });
    return reply.status(200).send(response);
  });

  instance.post('/on-enter', async (request, reply) => {
    const body = OnEnterDispatchRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    wakeParentIfAllChildrenDone(body.data.card).catch(() => {});
    fireAndForgetCallback(body.data.callback_url, { status: 'success' });

    return reply.status(202).send(response);
  });

  instance.post('/on-action', async (request, reply) => {
    const body = OnActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    fireAndForgetCallback(body.data.callback_url, { status: 'success' });

    return reply.status(202).send(response);
  });

  instance.post('/on-exit', async (request, reply) => {
    const body = OnExitRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    return reply.status(200).send({ status: 'acknowledged' });
  });
}
