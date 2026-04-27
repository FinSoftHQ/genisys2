import { describe, expect, it } from 'vitest';
import {
  BoardSchemaDocumentSchema,
  BoardSequenceEntitySchema,
  CallbackTokenEntitySchema,
  CanExitHookResponseSchema,
  CardConflictResponseSchema,
  CardEntitySchema,
  CreateCardRequestSchema,
  MoveCardRequestSchema,
  OnEnterDispatchRequestSchema,
  ProcessingStateTransitionSchema,
  ProcessorCallbackRequestSchema,
  ProcessorRegistryEntitySchema,
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

  it('rejects processing columns without exit_logic routes', () => {
    const result = BoardSchemaDocumentSchema.safeParse({
      columns: [
        {
          uid: 'in-review',
          title: 'In Review',
          type: 'Processing',
          processor_id: 'manager-approval',
          exit_logic: {},
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
      version: 1,
      title: '   ',
    });

    expect(result.success).toBe(false);
  });

  it('requires version for update card request optimistic locking', () => {
    const result = UpdateCardRequestSchema.safeParse({
      title: 'Updated title',
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

  it('validates conflict response payload with current card state', () => {
    const result = CardConflictResponseSchema.safeParse({
      error: {
        code: 'CONFLICT',
        message: 'Version conflict',
        details: {
          current_version: 2,
          card: {
            uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
            board_uid: '550e8400-e29b-41d4-a716-446655440000',
            display_id: 'MKT-1',
            title: 'Campaign launch draft',
            description: null,
            version: 2,
            processing_state: 'IDLE',
            is_editable: true,
            payload: {},
            current_status: 'backlog',
            created_at: '2026-04-26T08:30:00.000Z',
            updated_at: '2026-04-26T08:31:00.000Z',
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires a rejection message when can-exit returns allowed=false', () => {
    const result = CanExitHookResponseSchema.safeParse({
      allowed: false,
      message: null,
    });

    expect(result.success).toBe(false);
  });

  it('enforces processor SLA to be less than or equal to max SLA', () => {
    const result = ProcessorRegistryEntitySchema.safeParse({
      processor_id: 'manager-approval',
      name: 'Manager Approval Gate',
      base_url: 'http://localhost:4001',
      health_endpoint: '/health',
      hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
      sla_seconds: 600,
      max_sla_seconds: 300,
      auth_type: 'none',
      auth_config: null,
      hmac_secret: 'temp-secret-ignore',
      status: 'healthy',
      last_health_check: '2026-04-26T08:30:00.000Z',
      created_at: '2026-04-26T08:30:00.000Z',
      updated_at: '2026-04-26T08:30:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('validates processor registry schema for default always-allow processor', () => {
    const result = ProcessorRegistryEntitySchema.safeParse({
      processor_id: 'default-manual',
      name: 'Default Manual Processor',
      base_url: 'http://localhost:4001',
      health_endpoint: '/health',
      hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
      sla_seconds: 300,
      max_sla_seconds: 86400,
      auth_type: 'none',
      auth_config: null,
      hmac_secret: 'dev-secret',
      status: 'healthy',
      last_health_check: '2026-04-26T08:30:00.000Z',
      created_at: '2026-04-26T08:30:00.000Z',
      updated_at: '2026-04-26T08:30:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('validates callback token lifecycle entity shape', () => {
    const result = CallbackTokenEntitySchema.safeParse({
      token: '550e8400-e29b-41d4-a716-446655440001',
      card_uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
      processor_id: 'manager-approval',
      hook: 'on-enter',
      idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
      context: { previous_status: 'backlog' },
      expires_at: '2026-04-26T08:35:00.000Z',
      created_at: '2026-04-26T08:30:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('validates on-enter dispatch payload contract', () => {
    const result = OnEnterDispatchRequestSchema.safeParse({
      card: {
        uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
        board_uid: '550e8400-e29b-41d4-a716-446655440000',
        display_id: 'MKT-1',
        title: 'Campaign launch draft',
        description: null,
        version: 1,
        processing_state: 'IDLE',
        is_editable: true,
        payload: {},
        current_status: 'in-review',
        created_at: '2026-04-26T08:30:00.000Z',
        updated_at: '2026-04-26T08:30:00.000Z',
      },
      board: {
        uid: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Marketing Sprint Q2',
        prefix: 'MKT',
        schema: {
          columns: [
            {
              uid: 'in-review',
              title: 'In Review',
              type: 'Processing',
              processor_id: 'manager-approval',
              exit_logic: { approved: 'done', rejected: 'backlog' },
              order: 0,
            },
          ],
        },
        permissions: { read: ['role:marketing'], write: ['role:marketing-lead'] },
        created_at: '2026-04-26T08:30:00.000Z',
        updated_at: '2026-04-26T08:30:00.000Z',
      },
      column: {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing',
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done', rejected: 'backlog' },
        order: 0,
      },
      callback_url: 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440003',
      idempotency_key: '550e8400-e29b-41d4-a716-446655440004',
    });

    expect(result.success).toBe(true);
  });

  it('requires error_message when callback status is error', () => {
    const result = ProcessorCallbackRequestSchema.safeParse({
      status: 'error',
      payload_updates: { payload: { reason: 'timeout' } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects PROCESSING cards that are still editable', () => {
    const result = CardEntitySchema.safeParse({
      uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
      board_uid: '550e8400-e29b-41d4-a716-446655440000',
      display_id: 'MKT-1',
      title: 'Campaign launch draft',
      description: null,
      version: 2,
      processing_state: 'PROCESSING',
      is_editable: true,
      payload: {},
      current_status: 'in-review',
      created_at: '2026-04-26T08:30:00.000Z',
      updated_at: '2026-04-26T08:31:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('validates allowed processing transitions only', () => {
    expect(ProcessingStateTransitionSchema.safeParse({ from: 'PROCESSING', to: 'IDLE' }).success).toBe(true);
    expect(ProcessingStateTransitionSchema.safeParse({ from: 'IDLE', to: 'ERROR' }).success).toBe(false);
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
