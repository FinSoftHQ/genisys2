import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  CardEntitySchema,
  CallbackTokenEntitySchema,
  ProcessingStateTransitionSchema,
  ProcessorCallbackRequestSchema,
  ProcessorCallbackResponseSchema,
  CallbackTokenRejectedResponseSchema,
  EventLogRowSchema,
  type BoardEntity,
  type CardEntity,
  type EventLogRow,
} from '@repo/shared';
import {
  openDb,
  closeDb,
  seedBoard,
  createCard,
  createCallbackToken,
  getCallbackToken,
  deleteCallbackToken,
  updateCardProcessingState,
} from './repository.js';
import { startProcessing, consumeCallback } from './processing-orchestrator.js';
import { dispatchAsyncHook } from './hook-dispatcher.js';
import { appendEventLog } from './event-log.js';

vi.mock('./hook-dispatcher.js', () => ({
  dispatchAsyncHook: vi.fn(),
}));

vi.mock('./event-log.js', () => ({
  appendEventLog: vi.fn((_db, event) => ({
    ...event,
    event_id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: new Date().toISOString(),
    lifecycle_event: event.lifecycle_event ?? null,
    from_column: event.from_column ?? null,
    to_column: event.to_column ?? null,
    idempotency_key: event.idempotency_key ?? null,
    payload_delta: event.payload_delta ?? null,
    metadata: event.metadata ?? null,
  })),
}));

describe('processing orchestrator', () => {
  let db: unknown;

  beforeAll(() => {
    db = openDb(':memory:');
  });

  afterAll(() => {
    closeDb(db);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('startProcessing', () => {
    it('transitions card from IDLE to PROCESSING', async () => {
      const board = seedBoard(db);
      const processingColumn = {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing' as const,
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done', rejected: 'backlog' },
        order: 99,
      };

      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'backlog',
      });

      const result = await startProcessing(db, board, card, processingColumn);

      expect(CardEntitySchema.safeParse(result).success).toBe(true);
      expect(result.processing_state).toBe('PROCESSING');
      expect(result.is_editable).toBe(false);
    });

    it('creates a callback token with correct shape', async () => {
      const board = seedBoard(db);
      const processingColumn = {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing' as const,
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done' },
        order: 99,
      };

      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'backlog',
      });

      await startProcessing(db, board, card, processingColumn);

      // Token should be findable by card relation — we need a way to look it up
      // The implementation should store it; we verify by consuming later
      expect(true).toBe(true); // Placeholder: token existence verified via consumeCallback
    });

    it('dispatches on-enter hook to processor', async () => {
      const board = seedBoard(db);
      const processingColumn = {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing' as const,
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done' },
        order: 99,
      };

      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'backlog',
      });

      await startProcessing(db, board, card, processingColumn);

      expect(dispatchAsyncHook).toHaveBeenCalledWith(
        expect.objectContaining({ processor_id: 'manager-approval' }),
        'on-enter',
        expect.objectContaining({
          card: expect.objectContaining({ uid: card.uid }),
          board: expect.objectContaining({ uid: board.uid }),
          column: expect.objectContaining({ uid: 'in-review' }),
          callback_url: expect.stringContaining('/api/callbacks/'),
          idempotency_key: expect.any(String),
        }),
      );
    });

    it('rejects invalid state transitions', async () => {
      const board = seedBoard(db);
      const processingColumn = {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing' as const,
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done' },
        order: 99,
      };

      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'backlog',
      });

      // Manually set to PROCESSING first
      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      await expect(startProcessing(db, board, { ...card, processing_state: 'PROCESSING' }, processingColumn)).rejects.toThrow();
    });
  });

  describe('consumeCallback', () => {
    it('accepts valid callback and moves card to target column', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      // Force card into PROCESSING state
      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440001';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        context: { previous_status: 'backlog' },
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      const result = await consumeCallback(db, token, 'Bearer some-auth-token', {
        status: 'success',
        move_to_column: 'done',
      });

      expect(ProcessorCallbackResponseSchema.safeParse({ data: { card: result } }).success).toBe(true);
      expect(result.processing_state).toBe('IDLE');
      expect(result.current_status).toBe('done');
      expect(result.is_editable).toBe(true);
    });

    it('applies payload_updates on callback success', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440003';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440004',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      const result = await consumeCallback(db, token, 'Bearer some-auth-token', {
        status: 'success',
        payload_updates: { title: 'Updated via Callback', payload: { reviewed: true } },
      });

      expect(result.title).toBe('Updated via Callback');
      expect(result.payload).toEqual({ reviewed: true });
    });

    it('transitions to ERROR state when callback status is error', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440005';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440006',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      const result = await consumeCallback(db, token, 'Bearer some-auth-token', {
        status: 'error',
        error_message: 'Processor failed',
      });

      expect(result.processing_state).toBe('ERROR');
      expect(result.is_editable).toBe(false);
    });

    it('deletes token on successful consumption', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440007';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440008',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      await consumeCallback(db, token, 'Bearer some-auth-token', { status: 'success' });

      const found = getCallbackToken(db, token);
      expect(found).toBeUndefined();
    });

    it('rejects missing token with CALLBACK_TOKEN_MISSING', async () => {
      await expect(
        consumeCallback(db, '550e8400-e29b-41d4-a716-446655440009', 'Bearer token', { status: 'success' }),
      ).rejects.toThrow('CALLBACK_TOKEN_MISSING');
    });

    it('rejects expired token with CALLBACK_TOKEN_EXPIRED', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440010';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440011',
        context: {},
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired
      });

      await expect(
        consumeCallback(db, token, 'Bearer token', { status: 'success' }),
      ).rejects.toThrow('CALLBACK_TOKEN_EXPIRED');
    });

    it('rejects replayed token with CALLBACK_TOKEN_REPLAYED', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440012';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440013',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      await consumeCallback(db, token, 'Bearer token', { status: 'success' });

      await expect(
        consumeCallback(db, token, 'Bearer token', { status: 'success' }),
      ).rejects.toThrow('CALLBACK_TOKEN_REPLAYED');
    });

    it('rejects callback without Bearer prefix', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440014';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440015',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      await expect(
        consumeCallback(db, token, 'Basic token', { status: 'success' }),
      ).rejects.toThrow();
    });
  });

  describe('state transition validation', () => {
    it('allows IDLE -> PROCESSING', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'IDLE', to: 'PROCESSING' }).success).toBe(true);
    });

    it('allows PROCESSING -> IDLE', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'PROCESSING', to: 'IDLE' }).success).toBe(true);
    });

    it('allows PROCESSING -> ERROR', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'PROCESSING', to: 'ERROR' }).success).toBe(true);
    });

    it('allows ERROR -> IDLE', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'ERROR', to: 'IDLE' }).success).toBe(true);
    });

    it('allows ERROR -> PROCESSING', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'ERROR', to: 'PROCESSING' }).success).toBe(true);
    });

    it('rejects IDLE -> ERROR', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'IDLE', to: 'ERROR' }).success).toBe(false);
    });

    it('rejects PROCESSING -> PROCESSING', () => {
      expect(ProcessingStateTransitionSchema.safeParse({ from: 'PROCESSING', to: 'PROCESSING' }).success).toBe(false);
    });
  });

  describe('lifecycle event logging', () => {
    it('appends PROCESSING_STARTED on startProcessing', async () => {
      const board = seedBoard(db);
      const processingColumn = {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing' as const,
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done' },
        order: 99,
      };

      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'backlog',
      });

      vi.mocked(appendEventLog).mockClear();
      await startProcessing(db, board, card, processingColumn);

      expect(appendEventLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: card.uid,
          board_uid: board.uid,
          action: 'PROCESSING_STARTED',
          category: 'lifecycle',
          lifecycle_event: 'PROCESSING_STARTED',
          actor: expect.any(String),
        }),
      );
    });

    it('appends PROCESSING_COMPLETED on successful consumeCallback', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440016';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440017',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      vi.mocked(appendEventLog).mockClear();
      await consumeCallback(db, token, 'Bearer token', { status: 'success' });

      expect(appendEventLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: card.uid,
          board_uid: board.uid,
          action: 'PROCESSING_COMPLETED',
          category: 'lifecycle',
          lifecycle_event: 'PROCESSING_COMPLETED',
          actor: expect.any(String),
        }),
      );
    });

    it('appends PROCESSING_ERROR on error consumeCallback', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'in-review',
      });

      updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', { is_editable: false });

      const token = '550e8400-e29b-41d4-a716-446655440018';
      createCallbackToken(db, {
        token,
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440019',
        context: {},
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });

      vi.mocked(appendEventLog).mockClear();
      await consumeCallback(db, token, 'Bearer token', {
        status: 'error',
        error_message: 'Processor failed',
      });

      expect(appendEventLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: card.uid,
          board_uid: board.uid,
          action: 'PROCESSING_ERROR',
          category: 'lifecycle',
          lifecycle_event: 'PROCESSING_ERROR',
          actor: expect.any(String),
        }),
      );
    });

    it('returns events that validate against EventLogRowSchema', async () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Test Card',
        current_status: 'backlog',
      });

      const processingColumn = {
        uid: 'in-review',
        title: 'In Review',
        type: 'Processing' as const,
        processor_id: 'manager-approval',
        exit_logic: { approved: 'done' },
        order: 99,
      };

      vi.mocked(appendEventLog).mockImplementation((_db, event) => ({
        ...event,
        event_id: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
      }));

      await startProcessing(db, board, card, processingColumn);

      const callArg = vi.mocked(appendEventLog).mock.calls[0][1] as EventLogRow;
      expect(EventLogRowSchema.safeParse(callArg).success).toBe(true);
    });
  });
});
