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
import { getBoardById, getCardById, getSnapshot, listBoards, moveCard } from './repository.js';
import { startProcessing, moveCardToNextColumn } from './processing-orchestrator.js';

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
    console.error('[delegated] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

function findRelatedTodoCard(parentCard: {
  uid: string;
  payload: Record<string, unknown>;
}, taskBoardUid: string): { uid: string; board_uid: string } | undefined {
  // Prefer the explicit task_card_uid set by the planning processor
  const taskCardUid = typeof parentCard.payload.task_card_uid === 'string' ? parentCard.payload.task_card_uid : undefined;
  const taskBoardUidFromPayload = typeof parentCard.payload.task_board_uid === 'string' ? parentCard.payload.task_board_uid : undefined;

  if (taskCardUid && taskBoardUidFromPayload) {
    const card = getCardById({}, taskBoardUidFromPayload, taskCardUid);
    if (card && card.current_status === 'todo') {
      return { uid: card.uid, board_uid: card.board_uid };
    }
  }

  // Fallback: find any card in todo whose payload points back to this parent
  const snapshot = getSnapshot({}, taskBoardUid);
  if (!snapshot) return undefined;
  const todoCards = snapshot.cards
    .filter((c) => c.current_status === 'todo' && c.payload?.parent_card_uid === parentCard.uid)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return todoCards[0] ? { uid: todoCards[0].uid, board_uid: todoCards[0].board_uid } : undefined;
}

async function delegateTask(card: {
  uid: string;
  board_uid: string;
  payload: Record<string, unknown>;
}, callbackUrl: string): Promise<void> {
  try {
    const sourceBoard = getBoardById({}, card.board_uid);
    if (!sourceBoard?.suite_uid) {
      fireAndForgetCallback(callbackUrl, { status: 'success' });
      return;
    }

    const taskBoard = listBoards({}).find((b) => b.suite_uid === sourceBoard.suite_uid && b.role === 'tasks');
    if (!taskBoard) {
      fireAndForgetCallback(callbackUrl, { status: 'success' });
      return;
    }

    // New multi-subtask path: do NOT auto-move children; let them stay in todo for review.
    // The done processor will wake the parent when all children reach done.
    const taskCardUids = card.payload.task_card_uids;
    if (Array.isArray(taskCardUids) && taskCardUids.length > 0 && typeof taskCardUids[0] === 'string') {
      fireAndForgetCallback(callbackUrl, { status: 'success' });
      return;
    }

    // Legacy single-child path: kickstart the child into explore and advance parent to wrap
    const todoCard = findRelatedTodoCard(card, taskBoard.uid);
    if (!todoCard) {
      fireAndForgetCallback(callbackUrl, { status: 'success' });
      return;
    }

    const movedCard = moveCard({}, todoCard.board_uid, todoCard.uid, 'explore', 'system:delegated');

    const exploreColumn = taskBoard.schema.columns.find((c) => c.uid === 'explore');
    if (exploreColumn && exploreColumn.type === 'Processing' && movedCard) {
      await startProcessing({}, taskBoard, movedCard, exploreColumn as {
        uid: string;
        title: string;
        type: 'Processing';
        processor_id: string;
        exit_logic: Record<string, string>;
        order: number;
      });
    }

    // Parent stays in Delegated. The done processor's auto-pull will handle
    // subsequent children, and wakeParentIfAllChildrenDone will move the parent
    // to Wrap when all children reach done.
    fireAndForgetCallback(callbackUrl, { status: 'success' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: `Delegation failed: ${message}`.slice(0, 500),
    });
  }
}

export async function delegatedProcessorRoutes(instance: FastifyInstance): Promise<void> {
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
    delegateTask(body.data.card, body.data.callback_url).catch(() => {});
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
