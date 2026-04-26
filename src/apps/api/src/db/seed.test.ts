import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoardEntitySchema, BoardSequenceEntitySchema } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { createClient } from './client.js';
import { seedBoard } from './seed.js';
import { boardSequences } from './schema.js';

describe('db seed', () => {
  let db: ReturnType<typeof createClient>;

  beforeAll(() => {
    db = createClient(':memory:');
  });

  afterAll(() => {
    db.sqlite.close();
  });

  it('creates a board that validates against BoardEntitySchema', () => {
    const board = seedBoard(db);
    const parsed = BoardEntitySchema.safeParse(board);
    expect(parsed.success).toBe(true);
  });

  it('inserts a matching board_sequences row with seq_value 0', () => {
    const board = seedBoard(db);
    const seq = db.db
      .select()
      .from(boardSequences)
      .where(eq(boardSequences.prefix, board.prefix))
      .get();
    expect(seq).toBeDefined();
    expect(BoardSequenceEntitySchema.safeParse(seq).success).toBe(true);
    expect(seq!.seq_value).toBe(0);
  });

  it('creates a board with the expected default columns', () => {
    const board = seedBoard(db);
    expect(board.schema.columns).toHaveLength(3);
    expect(board.schema.columns.map((c) => c.uid)).toEqual([
      'backlog',
      'in-progress',
      'done',
    ]);
  });
});
