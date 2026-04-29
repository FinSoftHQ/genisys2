import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { BoardEntitySchema, CardEntitySchema, ProcessorRegistryEntitySchema, CallbackTokenEntitySchema, ProcessingStateTransitionSchema, BoardStreamSseEventSchema } from '@repo/shared';
import { boards, boardSequences, cards, processorRegistry, callbackTokens } from '../db/schema.js';
import type { ProcessorRegistryEntity } from '@repo/shared';
import '../db/seed.js';
import type { BoardEntity, CardEntity } from '@repo/shared';
import { DEFAULT_PROCESSOR_BASE_URL } from './config.js';
import { resolveDb, openDb, closeDb } from './db-context.js';
import { appendEventLog } from './event-log.js';
import { broadcastEvent } from './board-stream.js';
export { resolveDb, openDb, closeDb };

export function getPragmas(instance: unknown) {
  const sqlite = resolveDb(instance).sqlite;
  const journalMode = sqlite.pragma('journal_mode', { simple: true }) as string;
  const synchronous = sqlite.pragma('synchronous', { simple: true }) as number;
  const busyTimeout = sqlite.pragma('busy_timeout', { simple: true }) as number;

  const syncMap: Record<number, string> = {
    0: 'OFF',
    1: 'NORMAL',
    2: 'FULL',
    3: 'EXTRA',
  };

  return {
    journal_mode: journalMode,
    synchronous: (syncMap[synchronous] ?? String(synchronous)).toLowerCase(),
    busy_timeout: busyTimeout,
  };
}

function generatePrefix(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let prefix = letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 3; i++) {
    prefix += chars[Math.floor(Math.random() * chars.length)];
  }
  return prefix;
}

const BOARD_TEMPLATES: Record<string, { title: string; columns: Array<{ uid: string; title: string; type: 'Normal' | 'Processing'; processor_id: string; exit_logic: Record<string, string>; order: number }> }> = {
  default: {
    title: 'New Board',
    columns: [
      { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'todo' }, order: 0 },
      { uid: 'todo', title: 'TODO', type: 'Normal', processor_id: 'todo', exit_logic: { default: 'in-progress' }, order: 1 },
      { uid: 'in-progress', title: 'In Progress', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'done' }, order: 2 },
      { uid: 'done', title: 'Done', type: 'Processing', processor_id: 'done', exit_logic: { default: 'done' }, order: 3 },
    ],
  },
  development: {
    title: 'Development Board',
    columns: [
      { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'todo' }, order: 0 },
      { uid: 'todo', title: 'TODO', type: 'Normal', processor_id: 'todo', exit_logic: { default: 'prep' }, order: 1 },
      { uid: 'prep', title: 'Prep', type: 'Processing', processor_id: 'prep', exit_logic: { default: 'wip' }, order: 2 },
      { uid: 'wip', title: 'WIP', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'wrap' }, order: 3 },
      { uid: 'wrap', title: 'Wrap', type: 'Processing', processor_id: 'wrap', exit_logic: { default: 'done' }, order: 4 },
      { uid: 'done', title: 'Done', type: 'Normal', processor_id: 'done', exit_logic: { default: 'done' }, order: 5 },
    ],
  },
};

export function createBoard(
  instance: unknown,
  template: string = 'default',
  title?: string,
  prefix?: string,
): BoardEntity {
  const { db } = resolveDb(instance);
  const uid = randomUUID();
  const now = new Date().toISOString();

  let finalPrefix: string;
  if (prefix) {
    const existing = db.select().from(boardSequences).where(eq(boardSequences.prefix, prefix)).get();
    if (existing) {
      throw new Error('PREFIX_EXISTS');
    }
    finalPrefix = prefix;
  } else {
    let attempts = 0;
    do {
      finalPrefix = generatePrefix();
      attempts++;
    } while (
      db.select().from(boardSequences).where(eq(boardSequences.prefix, finalPrefix)).get() &&
      attempts < 10
    );

    if (attempts >= 10) {
      throw new Error('Failed to generate unique board prefix');
    }
  }

  const templateConfig = BOARD_TEMPLATES[template] ?? BOARD_TEMPLATES.default;

  const boardData = {
    uid,
    title: title || templateConfig.title,
    prefix: finalPrefix,
    schema: {
      columns: templateConfig.columns,
    },
    permissions: { read: [] as string[], write: [] as string[] },
    created_at: now,
    updated_at: now,
  };

  const parsed = BoardEntitySchema.safeParse(boardData);
  if (!parsed.success) {
    throw new Error('Invalid board data: ' + JSON.stringify(parsed.error.issues));
  }

  db.insert(boards).values(boardData).run();
  db.insert(boardSequences).values({ prefix: finalPrefix, seq_value: 0 }).run();

  return parsed.data;
}

export function updateBoard(
  instance: unknown,
  boardUid: string,
  input: { title?: string },
): BoardEntity | null {
  const { db } = resolveDb(instance);
  const now = new Date().toISOString();

  const updateData: Partial<typeof boards.$inferInsert> = {
    updated_at: now,
  };

  if (input.title !== undefined) {
    updateData.title = input.title;
  }

  const result = db
    .update(boards)
    .set(updateData)
    .where(eq(boards.uid, boardUid))
    .returning()
    .get();

  if (!result) return null;

  const parsed = BoardEntitySchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

let repoSeedCounter = 0;

export function seedBoard(instance: unknown): BoardEntity {
  const { db } = resolveDb(instance);
  const uid = randomUUID();
  const now = new Date().toISOString();
  const prefix = `R${repoSeedCounter++}`;

  const boardData = {
    uid,
    title: 'Demo Board',
    prefix,
    schema: {
      columns: [
        {
          uid: 'backlog',
          title: 'Backlog',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: { default: 'in-progress' },
          order: 0,
        },
        {
          uid: 'in-review',
          title: 'In Review',
          type: 'Processing' as const,
          processor_id: 'manager-approval',
          exit_logic: { approved: 'done', rejected: 'backlog' },
          order: 1,
        },
        {
          uid: 'in-progress',
          title: 'In Progress',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: { default: 'done' },
          order: 2,
        },
        {
          uid: 'done',
          title: 'Done',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: {},
          order: 3,
        },
      ],
    },
    permissions: { read: [] as string[], write: [] as string[] },
    created_at: now,
    updated_at: now,
  };

  const parsed = BoardEntitySchema.safeParse(boardData);
  if (!parsed.success) {
    throw new Error('Invalid board data: ' + JSON.stringify(parsed.error.issues));
  }

  db.insert(boards).values(boardData).run();
  db.insert(boardSequences).values({ prefix, seq_value: 0 }).run();

  const existingProcessor = db.select().from(processorRegistry).where(eq(processorRegistry.processor_id, 'manager-approval')).get();
  if (!existingProcessor) {
    db.insert(processorRegistry).values({
      processor_id: 'manager-approval',
      name: 'Manager Approval Gate',
      base_url: DEFAULT_PROCESSOR_BASE_URL,
      health_endpoint: '/health',
      hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
      sla_seconds: 300,
      max_sla_seconds: 600,
      auth_type: 'none',
      auth_config: null,
      hmac_secret: 'temp-secret-ignore',
      status: 'unknown',
      last_health_check: null,
      created_at: now,
      updated_at: now,
    }).run();
  }

  return parsed.data;
}

export function listBoards(instance: unknown): BoardEntity[] {
  const { db } = resolveDb(instance);
  const rows = db.select().from(boards).all();
  const parsed: BoardEntity[] = [];
  for (const row of rows) {
    const result = BoardEntitySchema.safeParse(row);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

export function getBoardById(instance: unknown, boardUid: string): BoardEntity | null {
  const { db } = resolveDb(instance);
  const board = db.select().from(boards).where(eq(boards.uid, boardUid)).get();
  if (!board) return null;
  const parsed = BoardEntitySchema.safeParse(board);
  return parsed.success ? parsed.data : null;
}

export function getSnapshot(
  instance: unknown,
  boardUid: string,
): { board: BoardEntity; cards: CardEntity[] } | undefined {
  const { db } = resolveDb(instance);
  const board = db.select().from(boards).where(eq(boards.uid, boardUid)).get();
  if (!board) return undefined;
  const boardParsed = BoardEntitySchema.safeParse(board);
  if (!boardParsed.success) return undefined;

  const boardCards = db.select().from(cards).where(eq(cards.board_uid, boardUid)).all();
  const parsedCards: CardEntity[] = [];
  for (const card of boardCards) {
    const parsed = CardEntitySchema.safeParse(card);
    if (parsed.success) parsedCards.push(parsed.data);
  }
  return { board: boardParsed.data, cards: parsedCards };
}

export function getCardById(instance: unknown, boardUid: string, cardUid: string): CardEntity | undefined {
  const { db } = resolveDb(instance);
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.board_uid, boardUid), eq(cards.uid, cardUid)))
    .get();
  if (!card) return undefined;
  const parsed = CardEntitySchema.safeParse(card);
  return parsed.success ? parsed.data : undefined;
}

export function createCard(
  instance: unknown,
  boardUid: string,
  input: { title: string; description?: string | null; current_status: string; payload?: Record<string, unknown> },
  actor: string = 'user:anonymous',
): CardEntity {
  const { db } = resolveDb(instance);
  const board = db.select().from(boards).where(eq(boards.uid, boardUid)).get();
  if (!board) {
    throw new Error('BOARD_NOT_FOUND');
  }

  const schema = board.schema as { columns: Array<{ uid: string }> };
  const validColumns = new Set(schema.columns.map((c) => c.uid));
  if (!validColumns.has(input.current_status)) {
    throw new Error('INVALID_COLUMN');
  }

  const now = new Date().toISOString();

  return db.transaction(() => {
    const seq = db
      .update(boardSequences)
      .set({ seq_value: sql`${boardSequences.seq_value} + 1` })
      .where(eq(boardSequences.prefix, board.prefix))
      .returning()
      .get();

    const displayId = `${board.prefix}-${seq.seq_value}`;
    const cardData = {
      uid: randomUUID(),
      board_uid: boardUid,
      display_id: displayId,
      title: input.title,
      description: input.description ?? null,
      version: 1,
      processing_state: 'IDLE' as const,
      is_editable: true,
      payload: input.payload ?? {},
      current_status: input.current_status,
      created_at: now,
      updated_at: now,
    };

    db.insert(cards).values(cardData).run();

    const logEvent = appendEventLog(instance, {
      event_id: randomUUID(),
      timestamp: now,
      card_uid: cardData.uid,
      board_uid: boardUid,
      actor,
      action: 'CARD_CREATED',
      category: 'user_action',
      lifecycle_event: null,
      from_column: null,
      to_column: null,
    } as Parameters<typeof appendEventLog>[1]);

    const parsedCard = CardEntitySchema.parse(cardData);
    const createdEvent = BoardStreamSseEventSchema.parse({
      id: logEvent.event_id,
      event: 'CARD_CREATED',
      data: {
        event_id: logEvent.event_id,
        board_uid: boardUid,
        actor,
        timestamp: logEvent.timestamp,
        card: parsedCard,
      },
    });
    broadcastEvent(boardUid, createdEvent);

    return parsedCard;
  });
}

export function updateCard(
  instance: unknown,
  boardUid: string,
  cardUid: string,
  input: { version: number; title?: string; description?: string | null; payload?: Record<string, unknown> },
  actor: string = 'user:anonymous',
): CardEntity | null {
  const { db } = resolveDb(instance);
  const now = new Date().toISOString();

  return db.transaction(() => {
    const updateData: Partial<typeof cards.$inferInsert> = {
      updated_at: now,
      version: sql`${cards.version} + 1`,
    };

    if (input.title !== undefined) {
      updateData.title = input.title;
    }
    if (input.description !== undefined) {
      updateData.description = input.description;
    }
    if (input.payload !== undefined) {
      updateData.payload = input.payload;
    }

    const conditions = [
      eq(cards.board_uid, boardUid),
      eq(cards.uid, cardUid),
    ];

    if (input.version !== undefined) {
      conditions.push(eq(cards.version, input.version));
    }

    const result = db
      .update(cards)
      .set(updateData)
      .where(and(...conditions))
      .returning()
      .get();

    if (!result) return null;

    const payloadDelta: Record<string, unknown> = {};
    if (input.title !== undefined) payloadDelta.title = input.title;
    if (input.description !== undefined) payloadDelta.description = input.description;
    if (input.payload !== undefined) payloadDelta.payload = input.payload;

    const logEvent = appendEventLog(instance, {
      event_id: randomUUID(),
      timestamp: now,
      card_uid: cardUid,
      board_uid: boardUid,
      actor,
      action: 'CARD_UPDATED',
      category: 'user_action',
      lifecycle_event: null,
      from_column: null,
      to_column: null,
      payload_delta: Object.keys(payloadDelta).length > 0 ? (payloadDelta as any) : null,
    } as Parameters<typeof appendEventLog>[1]);

    const parsed = CardEntitySchema.safeParse(result);
    if (parsed.success) {
      const changedFields: Array<'title' | 'description' | 'payload' | 'processing_state' | 'is_editable' | 'current_status' | 'version' | 'updated_at'> = ['version', 'updated_at'];
      if (input.title !== undefined) changedFields.push('title');
      if (input.description !== undefined) changedFields.push('description');
      if (input.payload !== undefined) changedFields.push('payload');
      const updatedEvent = BoardStreamSseEventSchema.parse({
        id: logEvent.event_id,
        event: 'CARD_UPDATED',
        data: {
          event_id: logEvent.event_id,
          board_uid: boardUid,
          actor,
          timestamp: logEvent.timestamp,
          card: parsed.data,
          changed_fields: changedFields,
        },
      });
      broadcastEvent(boardUid, updatedEvent);
    }
    return parsed.success ? parsed.data : null;
  });
}

export function getProcessorById(instance: unknown, processorId: string): ProcessorRegistryEntity | undefined {
  const { db } = resolveDb(instance);
  const processor = db
    .select()
    .from(processorRegistry)
    .where(eq(processorRegistry.processor_id, processorId))
    .get();
  if (!processor) return undefined;
  const parsed = ProcessorRegistryEntitySchema.safeParse(processor);
  return parsed.success ? parsed.data : undefined;
}

export function moveCard(instance: unknown, boardUid: string, cardUid: string, toColumn: string, actor: string = 'user:anonymous'): CardEntity {
  const { db } = resolveDb(instance);
  const board = db.select().from(boards).where(eq(boards.uid, boardUid)).get();
  if (!board) {
    throw new Error('BOARD_NOT_FOUND');
  }

  const schema = board.schema as { columns: Array<{ uid: string }> };
  const validColumns = new Set(schema.columns.map((c) => c.uid));
  if (!validColumns.has(toColumn)) {
    throw new Error('INVALID_COLUMN');
  }

  const existing = db
    .select()
    .from(cards)
    .where(and(eq(cards.board_uid, boardUid), eq(cards.uid, cardUid)))
    .get();

  if (!existing) {
    throw new Error('CARD_NOT_FOUND');
  }

  const fromColumn = existing.current_status as string;
  const now = new Date().toISOString();

  return db.transaction(() => {
    const result = db
      .update(cards)
      .set({
        current_status: toColumn,
        version: existing.version + 1,
        updated_at: now,
      })
      .where(and(eq(cards.board_uid, boardUid), eq(cards.uid, cardUid)))
      .returning()
      .get();

    if (!result) {
      throw new Error('CARD_NOT_FOUND');
    }

    const logEvent = appendEventLog(instance, {
      event_id: randomUUID(),
      timestamp: now,
      card_uid: cardUid,
      board_uid: boardUid,
      actor,
      action: 'CARD_MOVED',
      category: 'user_action',
      lifecycle_event: null,
      from_column: fromColumn,
      to_column: toColumn,
    } as Parameters<typeof appendEventLog>[1]);

    const parsed = CardEntitySchema.safeParse(result);
    if (!parsed.success) {
      throw new Error('CARD_NOT_FOUND');
    }
    const movedEvent = BoardStreamSseEventSchema.parse({
      id: logEvent.event_id,
      event: 'CARD_MOVED',
      data: {
        event_id: logEvent.event_id,
        board_uid: boardUid,
        actor,
        timestamp: logEvent.timestamp,
        card: parsed.data,
        from_column: fromColumn,
        to_column: toColumn,
      },
    });
    broadcastEvent(boardUid, movedEvent);
    return parsed.data;
  });
}

export function createCallbackToken(
  instance: unknown,
  input: {
    token: string;
    card_uid: string;
    processor_id: string;
    hook: string;
    idempotency_key: string;
    context: Record<string, unknown>;
    expires_at: string;
  },
) {
  const { db } = resolveDb(instance);
  const now = new Date().toISOString();
  const tokenData = {
    token: input.token,
    card_uid: input.card_uid,
    processor_id: input.processor_id,
    hook: input.hook,
    idempotency_key: input.idempotency_key,
    context: input.context,
    expires_at: input.expires_at,
    created_at: now,
  };
  db.insert(callbackTokens).values(tokenData).run();
  return CallbackTokenEntitySchema.parse(tokenData);
}

export function getCallbackToken(instance: unknown, token: string) {
  const { db } = resolveDb(instance);
  const result = db.select().from(callbackTokens).where(eq(callbackTokens.token, token)).get();
  if (!result) return undefined;
  const parsed = CallbackTokenEntitySchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

export function deleteCallbackToken(instance: unknown, token: string) {
  const { db } = resolveDb(instance);
  db.delete(callbackTokens).where(eq(callbackTokens.token, token)).run();
}

export function updateCardProcessingState(
  instance: unknown,
  boardUid: string,
  cardUid: string,
  fromState: string,
  toState: string,
  options: { is_editable: boolean; payload?: Record<string, unknown>; current_status?: string },
): CardEntity | null {
  const transition = ProcessingStateTransitionSchema.safeParse({ from: fromState, to: toState });
  if (!transition.success) {
    throw new Error('INVALID_STATE_TRANSITION');
  }

  const { db } = resolveDb(instance);
  const now = new Date().toISOString();

  const updateData: Partial<typeof cards.$inferInsert> = {
    processing_state: toState,
    is_editable: options.is_editable,
    version: sql`${cards.version} + 1`,
    updated_at: now,
  };

  if (options.payload !== undefined) {
    updateData.payload = options.payload;
  }
  if (options.current_status !== undefined) {
    updateData.current_status = options.current_status;
  }

  const result = db
    .update(cards)
    .set(updateData)
    .where(and(
      eq(cards.board_uid, boardUid),
      eq(cards.uid, cardUid),
      eq(cards.processing_state, fromState),
    ))
    .returning()
    .get();

  if (!result) return null;
  const parsed = CardEntitySchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

export function upsertProcessorRegistry(
  instance: unknown,
  input: {
    processor_id: string;
    name: string;
    base_url: string;
    health_endpoint?: string;
    hooks: string[];
    sla_seconds: number;
    max_sla_seconds: number;
    auth_type: string;
    auth_config?: Record<string, unknown> | null;
    hmac_secret: string;
  },
): ProcessorRegistryEntity {
  if (input.sla_seconds > input.max_sla_seconds) {
    throw new Error('SLA_EXCEEDS_MAX');
  }
  if (!input.hmac_secret || input.hmac_secret.length === 0) {
    throw new Error('EMPTY_HMAC_SECRET');
  }

  const { db } = resolveDb(instance);
  const now = new Date().toISOString();

  const data = {
    processor_id: input.processor_id,
    name: input.name,
    base_url: input.base_url,
    health_endpoint: input.health_endpoint ?? '/health',
    hooks: input.hooks,
    sla_seconds: input.sla_seconds,
    max_sla_seconds: input.max_sla_seconds,
    auth_type: input.auth_type,
    auth_config: input.auth_config ?? null,
    hmac_secret: input.hmac_secret,
    status: 'unknown' as const,
    last_health_check: null as string | null,
    created_at: now,
    updated_at: now,
  };

  db.insert(processorRegistry)
    .values(data)
    .onConflictDoUpdate({
      target: processorRegistry.processor_id,
      set: {
        name: input.name,
        base_url: input.base_url,
        health_endpoint: input.health_endpoint ?? '/health',
        hooks: input.hooks,
        sla_seconds: input.sla_seconds,
        max_sla_seconds: input.max_sla_seconds,
        auth_type: input.auth_type,
        auth_config: input.auth_config ?? null,
        hmac_secret: input.hmac_secret,
        updated_at: now,
      },
    })
    .run();

  const result = db.select().from(processorRegistry).where(eq(processorRegistry.processor_id, input.processor_id)).get();
  if (!result) throw new Error('UPSERT_FAILED');

  const parsed = ProcessorRegistryEntitySchema.safeParse(result);
  if (!parsed.success) throw new Error('INVALID_PROCESSOR_DATA');
  return parsed.data;
}
