import { randomUUID } from 'node:crypto';
import { CardEntitySchema } from '@repo/shared';
import type { BoardEntity, CardEntity } from '@repo/shared';
import {
  resolveDb,
  updateCardProcessingState,
  createCallbackToken,
  getCallbackToken,
  deleteCallbackToken,
  getProcessorById,
} from './repository.js';
import { dispatchAsyncHook } from './hook-dispatcher.js';
import { cards, callbackTokens, boards, processorRegistry, consumedCallbackTokens } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';

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
  const callbackUrl = `http://localhost:3000/api/callbacks/${token}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  createCallbackToken(db, {
    token,
    card_uid: card.uid,
    processor_id: processingColumn.processor_id,
    hook: 'on-enter',
    idempotency_key: idempotencyKey,
    context: { previous_status: card.current_status },
    expires_at: expiresAt,
  });

  const processor = getProcessorById(db, processingColumn.processor_id);
  if (!processor) {
    throw new Error('PROCESSOR_NOT_FOUND');
  }

  await dispatchAsyncHook(processor, 'on-enter', {
    card: updated,
    board,
    column: processingColumn,
    callback_url: callbackUrl,
    idempotency_key: idempotencyKey,
  });

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

  return database.transaction(() => {
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
      version: sql`${cards.version} + 1`,
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

    const parsed = CardEntitySchema.safeParse(result);
    if (!parsed.success) {
      throw new Error('INVALID_CARD_DATA');
    }
    return parsed.data;
  });
}
