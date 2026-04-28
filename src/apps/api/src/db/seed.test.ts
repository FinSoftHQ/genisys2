import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoardEntitySchema, BoardSequenceEntitySchema, DefaultAlwaysAllowProcessorSchema, ProcessorRegistryEntitySchema } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { createClient } from './client.js';
import { seedBoard, bootstrapDefaultProcessor, seedDemoBoardWithProcessingColumn } from './seed.js';
import { boardSequences, processorRegistry } from './schema.js';

describe('db seed', () => {
  let db: ReturnType<typeof createClient>;

  beforeAll(() => {
    db = createClient(':memory:');
  });

  afterAll(() => {
    db?.sqlite.close();
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
    expect(board.schema.columns).toHaveLength(4);
    expect(board.schema.columns.map((c) => c.uid)).toEqual([
      'backlog',
      'todo',
      'in-progress',
      'done',
    ]);
  });

  describe('default-manual processor bootstrap', () => {
    it('creates a default-manual processor that validates against DefaultAlwaysAllowProcessorSchema', () => {
      bootstrapDefaultProcessor(db);
      const processor = db.db
        .select()
        .from(processorRegistry)
        .where(eq(processorRegistry.processor_id, 'default-manual'))
        .get();
      expect(processor).toBeDefined();
      expect(DefaultAlwaysAllowProcessorSchema.safeParse(processor).success).toBe(true);
    });

    it('is idempotent — second call does not duplicate', () => {
      bootstrapDefaultProcessor(db);
      bootstrapDefaultProcessor(db);
      const rows = db.db
        .select()
        .from(processorRegistry)
        .where(eq(processorRegistry.processor_id, 'default-manual'))
        .all();
      expect(rows).toHaveLength(1);
    });
  });

  describe('Slice 3 demo seed — Processing column', () => {
    it('creates a board with a Processing column in its schema', () => {
      const board = seedDemoBoardWithProcessingColumn(db);
      const inReview = board.schema.columns.find((c) => c.uid === 'in-review');
      expect(inReview).toBeDefined();
      expect(inReview!.type).toBe('Processing');
      expect(inReview!.processor_id).toBe('manager-approval');
      expect(Object.keys(inReview!.exit_logic).length).toBeGreaterThan(0);
      expect(BoardEntitySchema.safeParse(board).success).toBe(true);
    });

    it('seeds processor registry with temp-secret-ignore hmac_secret', () => {
      seedDemoBoardWithProcessingColumn(db);
      const processor = db.db
        .select()
        .from(processorRegistry)
        .where(eq(processorRegistry.processor_id, 'manager-approval'))
        .get();
      expect(processor).toBeDefined();
      expect(processor!.hmac_secret).toBe('temp-secret-ignore');
      expect(ProcessorRegistryEntitySchema.safeParse(processor).success).toBe(true);
    });

    it('does not duplicate manager-approval processor on repeated seeding', () => {
      seedDemoBoardWithProcessingColumn(db);
      seedDemoBoardWithProcessingColumn(db);
      const rows = db.db
        .select()
        .from(processorRegistry)
        .where(eq(processorRegistry.processor_id, 'manager-approval'))
        .all();
      expect(rows).toHaveLength(1);
    });
  });
});
