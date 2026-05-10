import { randomUUID } from 'node:crypto';
import { CardEntitySchema, BoardStreamSseEventSchema, BoardEntitySchema } from '@repo/shared';
import type { BoardEntity, CardEntity } from '@repo/shared';
import {
  resolveDb,
  updateCardProcessingState,
  createCallbackToken,
  getProcessorById,
  getBoardById,
  moveCard,
} from './repository.js';
import { queueRollupForCard, enrichCardFamily } from './family-tree.js';
import { dispatchAsyncHook, dispatchFireAndForgetHook, dispatchSyncHook } from './hook-dispatcher.js';
import { getDefaultProcessor } from './config.js';
import { appendEventLog } from './event-log.js';
import { broadcastEvent } from './board-stream.js';
import { cards, callbackTokens, boards, processorRegistry, consumedCallbackTokens } from '../db/schema.js';
import { eq, sql, and, asc } from 'drizzle-orm';

export async function moveCardToNextColumn(
  db: unknown,
  board: BoardEntity,
  fromProcessorId: string,
): Promise<CardEntity | undefined> {
  const { db: database } = resolveDb(db);

  const sourceColumns = board.schema.columns.filter((c) => c.processor_id === fromProcessorId);

  for (const sourceColumn of sourceColumns) {
    const nextColumnUid = sourceColumn.exit_logic?.default;
    if (!nextColumnUid) continue;

    const targetColumn = board.schema.columns.find((c) => c.uid === nextColumnUid);
    if (!targetColumn) continue;

    const nextCardRaw = database
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.board_uid, board.uid),
          eq(cards.current_status, sourceColumn.uid),
          eq(cards.processing_state, 'IDLE'),
        ),
      )
      .orderBy(asc(cards.created_at))
      .limit(1)
      .get();

    if (!nextCardRaw) continue;

    const nextCard = CardEntitySchema.safeParse(nextCardRaw);
    if (!nextCard.success) continue;

    // Dispatch can-exit hook to source processor (gives it veto power)
    const sourceProcessor = getProcessorById(db, sourceColumn.processor_id) ?? getDefaultProcessor(sourceColumn.processor_id);

    let canExit;
    try {
      canExit = await dispatchSyncHook(sourceProcessor, 'can-exit', {
        card: nextCard.data,
        target_column: targetColumn.uid,
        actor: 'system:auto-pull',
      });
    } catch (_err) {
      continue; // Processor unavailable — skip this column
    }

    if (!canExit.allowed) continue;

    // Dispatch on-exit fire-and-forget to source processor
    dispatchFireAndForgetHook(sourceProcessor, 'on-exit', {
      card: nextCard.data,
      next_column: targetColumn,
      actor: 'system:auto-pull',
    });

    if (targetColumn.type === 'Processing') {
      try {
        await startProcessing(db, board, nextCard.data, targetColumn as {
          uid: string;
          title: string;
          type: 'Processing';
          processor_id: string;
          exit_logic: Record<string, string>;
          order: number;
        });
        return nextCard.data;
      } catch (_err) {
        continue;
      }
    } else {
      const moved = moveCard(db, board.uid, nextCard.data.uid, targetColumn.uid, 'system:auto-pull');
      if (moved) return moved;
    }
  }

  return undefined;
}

export async function startProcessing(
  db: unknown,
  board: BoardEntity,
  card: CardEntity,
  processingColumn: {
    uid: string;
    title: string;
    type: 'Processing';
    processor_id: string;
    exit_logic: Record<string, string>;
    order: number;
  },
): Promise<CardEntity> {
  if (card.processing_state !== 'IDLE') {
    throw new Error('INVALID_STATE_TRANSITION');
  }

  const updated = updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', {
    is_editable: false,
    current_status: processingColumn.uid,
  });
  if (!updated) {
    throw new Error('CARD_UPDATE_FAILED');
  }

  const token = randomUUID();
  const idempotencyKey = randomUUID();
  const callbackBaseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
  const callbackUrl = `${callbackBaseUrl.replace(/\/$/, '')}/api/callbacks/${token}`;
  const processor = getProcessorById(db, processingColumn.processor_id) ?? getDefaultProcessor(processingColumn.processor_id);

  const expiresAt = new Date(Date.now() + (processor.max_sla_seconds ?? 600) * 1000).toISOString();

  createCallbackToken(db, {
    token,
    card_uid: card.uid,
    processor_id: processingColumn.processor_id,
    hook: 'on-enter',
    idempotency_key: idempotencyKey,
    context: { previous_status: card.current_status },
    expires_at: expiresAt,
  });

  await dispatchAsyncHook(processor, 'on-enter', {
    card: updated,
    board,
    column: processingColumn,
    callback_url: callbackUrl,
    idempotency_key: idempotencyKey,
  });

  const logEvent = appendEventLog(db, {
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    card_uid: card.uid,
    board_uid: board.uid,
    actor: 'system:processor',
    action: 'PROCESSING_STARTED',
    category: 'lifecycle',
    lifecycle_event: 'PROCESSING_STARTED',
    from_column: null,
    to_column: null,
  } as Parameters<typeof appendEventLog>[1]);

  const processingEvent = BoardStreamSseEventSchema.parse({
    id: logEvent.event_id,
    event: 'CARD_UPDATED',
    data: {
      event_id: logEvent.event_id,
      board_uid: board.uid,
      actor: 'system:processor',
      timestamp: logEvent.timestamp,
      card: updated,
      changed_fields: ['processing_state', 'is_editable', 'current_status', 'version', 'updated_at'],
    },
  });
  broadcastEvent(board.uid, processingEvent);

  return updated;
}

export async function consumeCallback(
  db: unknown,
  token: string,
  authHeader: string,
  payload: {
    status: 'success' | 'error';
    payload_updates?: Record<string, unknown>;
    move_to_column?: string | null;
    error_message?: string;
  },
): Promise<CardEntity> {
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('INVALID_AUTH');
  }

  const { db: database } = resolveDb(db);
  const now = new Date().toISOString();

  const transactionResult = database.transaction(() => {
    const tokenRow = database
      .select()
      .from(callbackTokens)
      .where(eq(callbackTokens.token, token))
      .get();

    if (!tokenRow) {
      const consumed = database
        .select()
        .from(consumedCallbackTokens)
        .where(eq(consumedCallbackTokens.token, token))
        .get();
      if (consumed) {
        throw new Error('CALLBACK_TOKEN_REPLAYED');
      }
      throw new Error('CALLBACK_TOKEN_MISSING');
    }

    if (tokenRow.expires_at < now) {
      throw new Error('CALLBACK_TOKEN_EXPIRED');
    }

    const processor = database
      .select()
      .from(processorRegistry)
      .where(eq(processorRegistry.processor_id, tokenRow.processor_id))
      .get();
    if (!processor) {
      throw new Error('PROCESSOR_NOT_FOUND');
    }

    const card = database.select().from(cards).where(eq(cards.uid, tokenRow.card_uid)).get();
    if (!card) {
      throw new Error('CARD_NOT_FOUND');
    }

    if (payload.move_to_column) {
      const board = database.select().from(boards).where(eq(boards.uid, card.board_uid)).get();
      if (board) {
        const schema = board.schema as { columns: Array<{ uid: string }> };
        const validColumns = new Set(schema.columns.map((c) => c.uid));
        if (!validColumns.has(payload.move_to_column)) {
          throw new Error('INVALID_COLUMN');
        }
      }
    }

    const updateData: Partial<typeof cards.$inferInsert> = {
      updated_at: now,
      version: sql<number>`${cards.version} + 1` as unknown as number,
    };

    if (payload.status === 'success') {
      updateData.processing_state = 'IDLE';
      updateData.is_editable = true;

      if (payload.payload_updates) {
        if ('title' in payload.payload_updates && payload.payload_updates.title !== undefined) {
          updateData.title = payload.payload_updates.title as string;
        }
        if ('description' in payload.payload_updates && payload.payload_updates.description !== undefined) {
          updateData.description = payload.payload_updates.description as string | null;
        }
        if ('payload' in payload.payload_updates && payload.payload_updates.payload !== undefined) {
          updateData.payload = payload.payload_updates.payload as Record<string, unknown>;
        }
        if ('is_editable' in payload.payload_updates && payload.payload_updates.is_editable !== undefined) {
          updateData.is_editable = payload.payload_updates.is_editable as boolean;
        }
      }

      if (payload.move_to_column) {
        updateData.current_status = payload.move_to_column;
      }
    } else {
      updateData.processing_state = 'ERROR';
      updateData.is_editable = false;
    }

    const result = database
      .update(cards)
      .set(updateData)
      .where(eq(cards.uid, tokenRow.card_uid))
      .returning()
      .get();

    if (!result) {
      throw new Error('CARD_UPDATE_FAILED');
    }

    database.delete(callbackTokens).where(eq(callbackTokens.token, token)).run();
    database.insert(consumedCallbackTokens).values({ token, consumed_at: now }).run();

    const logEvent = appendEventLog(db, {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      card_uid: tokenRow.card_uid,
      board_uid: card.board_uid,
      actor: 'system:processor',
      action: payload.status === 'success' ? 'PROCESSING_COMPLETED' : 'PROCESSING_ERROR',
      category: 'lifecycle',
      lifecycle_event: payload.status === 'success' ? 'PROCESSING_COMPLETED' : 'PROCESSING_ERROR',
      from_column: null,
      to_column: null,
    } as Parameters<typeof appendEventLog>[1]);

    const changedFields: Array<'title' | 'description' | 'payload' | 'processing_state' | 'is_editable' | 'current_status' | 'version' | 'updated_at'> = ['processing_state', 'is_editable', 'version', 'updated_at'];
    if (payload.status === 'success' && payload.move_to_column) {
      changedFields.push('current_status');
    }
    if (payload.payload_updates) {
      if ('title' in payload.payload_updates) changedFields.push('title');
      if ('description' in payload.payload_updates) changedFields.push('description');
      if ('payload' in payload.payload_updates) changedFields.push('payload');
    }

    const callbackEvent = BoardStreamSseEventSchema.parse({
      id: logEvent.event_id,
      event: 'CARD_UPDATED',
      data: {
        event_id: logEvent.event_id,
        board_uid: card.board_uid,
        actor: 'system:processor',
        timestamp: logEvent.timestamp,
        card: result,
        changed_fields: changedFields,
      },
    });
    broadcastEvent(card.board_uid, callbackEvent);

    const parsed = CardEntitySchema.safeParse(result);
    if (!parsed.success) {
      throw new Error('INVALID_CARD_DATA');
    }
    return { result: parsed.data, tokenRow };
  });

  const enrichedResult = enrichCardFamily(db, transactionResult.result);
  queueRollupForCard(db, transactionResult.result.board_uid, transactionResult.result.uid, 'system:processor');

  // After transaction: handle post-callback column transitions
  if (payload.status === 'success' && payload.move_to_column) {
    const board = database.select().from(boards).where(eq(boards.uid, transactionResult.result.board_uid)).get();
    const targetColumn = (board?.schema as { columns: Array<{ uid: string; title: string; type: string; processor_id: string; exit_logic: Record<string, string>; order: number }> } | undefined)?.columns.find((c) => c.uid === payload.move_to_column);

    // 1. Fire on-exit for the source column
    const processor = getProcessorById(db, transactionResult.tokenRow.processor_id) ?? getDefaultProcessor(transactionResult.tokenRow.processor_id);
    dispatchFireAndForgetHook(processor, 'on-exit', {
      card: enrichedResult,
      next_column: targetColumn,
      actor: 'system:processor',
    });

    // 2. If moving into a Processing column, trigger on-enter
    if (targetColumn?.type === 'Processing') {
      const boardParsed = BoardEntitySchema.safeParse(board);
      if (boardParsed.success) {
        try {
          await startProcessing(db, boardParsed.data, enrichedResult, targetColumn as {
            uid: string;
            title: string;
            type: 'Processing';
            processor_id: string;
            exit_logic: Record<string, string>;
            order: number;
          });
        } catch (err) {
          console.error(
            `[orchestrator] startProcessing failed when moving card ${
              enrichedResult.uid
            } into column ${targetColumn.uid} (processor: ${targetColumn.processor_id}):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  // 3. Auto-pull: if a card entered 'done', pull next card from 'todo'
  if (payload.status === 'success' && transactionResult.tokenRow.processor_id === 'done') {
    const board = getBoardById(db, transactionResult.result.board_uid);
    if (board) {
      try {
        await moveCardToNextColumn(db, board, 'todo');
      } catch (_err) {
        // Best-effort: ignore failures
      }
    }
  }

  return enrichedResult;
}
