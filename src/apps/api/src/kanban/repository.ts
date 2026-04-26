import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { BoardEntitySchema, CardEntitySchema } from '@repo/shared';
import type { DbInstance } from '../db/client.js';
import { createClient } from '../db/client.js';
import { boards, boardSequences, cards } from '../db/schema.js';
import { seedBoard as seedBoardImpl } from '../db/seed.js';
import type { BoardEntity, CardEntity } from '@repo/shared';

let defaultDb: DbInstance | null = null;

function isDbInstance(value: unknown): value is DbInstance {
  return !!value && typeof value === 'object' && 'sqlite' in value && 'db' in value;
}

function resolveDb(instance: unknown): DbInstance {
  if (isDbInstance(instance)) {
    return instance;
  }
  if (!defaultDb) {
    defaultDb = createClient(process.env.KANBAN_DB_PATH ?? ':memory:');
  }
  return defaultDb;
}

export function openDb(path: string): DbInstance {
  defaultDb = createClient(path);
  return defaultDb;
}

export function closeDb(instance: unknown): void {
  const db = resolveDb(instance);
  if (db === defaultDb) {
    defaultDb = null;
  }
  db.sqlite.close();
}

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

export function createBoard(instance: unknown): BoardEntity {
  const { db } = resolveDb(instance);
  const uid = randomUUID();
  const now = new Date().toISOString();

  let prefix: string;
  let attempts = 0;
  do {
    prefix = generatePrefix();
    attempts++;
  } while (
    db.select().from(boardSequences).where(eq(boardSequences.prefix, prefix)).get() &&
    attempts < 10
  );

  if (attempts >= 10) {
    throw new Error('Failed to generate unique board prefix');
  }

  const boardData = {
    uid,
    title: 'New Board',
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
          uid: 'in-progress',
          title: 'In Progress',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: { default: 'done' },
          order: 1,
        },
        {
          uid: 'done',
          title: 'Done',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: {},
          order: 2,
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

  return parsed.data;
}

export { seedBoardImpl as seedBoard };

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

  const card = db.transaction(() => {
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
    return CardEntitySchema.parse(cardData);
  });

  return card;
}

export function updateCard(
  instance: unknown,
  boardUid: string,
  cardUid: string,
  input: { title?: string; description?: string | null },
): CardEntity | null {
  const { db } = resolveDb(instance);
  const existing = db
    .select()
    .from(cards)
    .where(and(eq(cards.board_uid, boardUid), eq(cards.uid, cardUid)))
    .get();

  if (!existing) return null;

  const now = new Date().toISOString();
  const updateData: Partial<typeof cards.$inferInsert> = {
    updated_at: now,
    version: existing.version + 1,
  };

  if (input.title !== undefined) {
    updateData.title = input.title;
  }
  if (input.description !== undefined) {
    updateData.description = input.description;
  }

  const result = db
    .update(cards)
    .set(updateData)
    .where(and(eq(cards.board_uid, boardUid), eq(cards.uid, cardUid)))
    .returning()
    .get();

  if (!result) return null;
  const parsed = CardEntitySchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

export function moveCard(instance: unknown, boardUid: string, cardUid: string, toColumn: string): CardEntity {
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

  const now = new Date().toISOString();
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
  const parsed = CardEntitySchema.safeParse(result);
  if (!parsed.success) {
    throw new Error('CARD_NOT_FOUND');
  }
  return parsed.data;
}
