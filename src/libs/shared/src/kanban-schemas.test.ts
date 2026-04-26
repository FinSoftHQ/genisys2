import { describe, expect, it } from 'vitest';
import {
  BoardSchemaDocumentSchema,
  BoardSequenceEntitySchema,
  CreateCardRequestSchema,
  MoveCardRequestSchema,
  SnapshotResponseSchema,
  SqlitePragmasSchema,
  UpdateCardRequestSchema,
} from './kanban-schemas.js';

describe('kanban contracts', () => {
  it('validates required sqlite pragmas', () => {
    const result = SqlitePragmasSchema.safeParse({
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
      busy_timeout: 5000,
    });

    expect(result.success).toBe(true);
  });

  it('accepts sqlite pragma values returned in lowercase from sqlite introspection', () => {
    const result = SqlitePragmasSchema.safeParse({
      journal_mode: 'wal',
      synchronous: 'normal',
      busy_timeout: '5000',
    });

    expect(result.success).toBe(true);
  });

  it('rejects duplicate board column order', () => {
    const result = BoardSchemaDocumentSchema.safeParse({
      columns: [
        {
          uid: 'backlog',
          title: 'Backlog',
          type: 'Normal',
          processor_id: 'default-manual',
          exit_logic: { default: 'in-progress' },
          order: 0,
        },
        {
          uid: 'in-progress',
          title: 'In Progress',
          type: 'Normal',
          processor_id: 'default-manual',
          exit_logic: { default: 'done' },
          order: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('validates create card request', () => {
    const result = CreateCardRequestSchema.safeParse({
      title: 'Ship static board UI',
      description: 'Implement drag and drop',
      current_status: 'backlog',
      payload: { assignee: 'alice@corp.com', estimate: 3 },
    });

    expect(result.success).toBe(true);
  });

  it('rejects whitespace-only title for update card request', () => {
    const result = UpdateCardRequestSchema.safeParse({
      title: '   ',
    });

    expect(result.success).toBe(false);
  });

  it('validates move card request', () => {
    const result = MoveCardRequestSchema.safeParse({ to_column_uid: 'in-progress' });

    expect(result.success).toBe(true);
  });

  it('validates board sequence entity for display id generation', () => {
    const result = BoardSequenceEntitySchema.safeParse({
      prefix: 'MKT',
      seq_value: 0,
    });

    expect(result.success).toBe(true);
  });

  it('enforces snapshot data envelope', () => {
    const result = SnapshotResponseSchema.safeParse({
      data: {
        board: {
          uid: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Marketing Sprint Q2',
          prefix: 'MKT',
          schema: {
            columns: [
              {
                uid: 'backlog',
                title: 'Backlog',
                type: 'Normal',
                processor_id: 'default-manual',
                exit_logic: { default: 'in-progress' },
                order: 0,
              },
            ],
          },
          permissions: { read: ['role:marketing'], write: ['role:marketing-lead'] },
          created_at: '2026-04-26T08:30:00.000Z',
          updated_at: '2026-04-26T08:30:00.000Z',
        },
        cards: [
          {
            uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
            board_uid: '550e8400-e29b-41d4-a716-446655440000',
            display_id: 'MKT-1',
            title: 'Campaign launch draft',
            description: null,
            version: 1,
            processing_state: 'IDLE',
            is_editable: true,
            payload: {},
            current_status: 'backlog',
            created_at: '2026-04-26T08:30:00.000Z',
            updated_at: '2026-04-26T08:30:00.000Z',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});
