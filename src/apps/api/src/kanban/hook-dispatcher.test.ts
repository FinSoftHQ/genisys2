import { describe, it, expect, vi } from 'vitest';
import {
  CanExitHookRequestSchema,
  CanExitHookResponseSchema,
  SyncHookTimeoutMsSchema,
  OnEnterDispatchRequestSchema,
  OnEnterDispatchAcceptedResponseSchema,
  type ProcessorRegistryEntity,
} from '@repo/shared';
import { dispatchSyncHook, dispatchAsyncHook } from './hook-dispatcher.js';

const mockProcessor: ProcessorRegistryEntity = {
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
};

describe('sync hook dispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports dispatchSyncHook function', () => {
    expect(typeof dispatchSyncHook).toBe('function');
  });

  it('enforces 3000ms as the only valid timeout literal', () => {
    expect(SyncHookTimeoutMsSchema.parse(3000)).toBe(3000);
    expect(SyncHookTimeoutMsSchema.safeParse(2999).success).toBe(false);
    expect(SyncHookTimeoutMsSchema.safeParse(3001).success).toBe(false);
  });

  describe('can-exit dispatch', () => {
    it('POSTs to processor base_url with can-exit payload', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ allowed: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const payload = {
        card: {
          uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
          board_uid: '550e8400-e29b-41d4-a716-446655440000',
          display_id: 'TST-1',
          title: 'Test Card',
          description: null,
          version: 1,
          processing_state: 'IDLE',
          is_editable: true,
          payload: {},
          current_status: 'backlog',
          created_at: '2026-04-26T08:30:00.000Z',
          updated_at: '2026-04-26T08:30:00.000Z',
        },
        target_column: 'in-progress',
        actor: 'user:alice@corp.com',
      };

      await dispatchSyncHook(mockProcessor, 'can-exit', payload);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:4001/can-exit',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: expect.any(String),
          signal: expect.any(AbortSignal),
        }),
      );

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(CanExitHookRequestSchema.safeParse(callBody).success).toBe(true);
    });

    it('returns parsed CanExitHookResponse when allowed=true', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ allowed: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await dispatchSyncHook(mockProcessor, 'can-exit', {
        card: {},
        target_column: 'in-progress',
        actor: 'system',
      });

      expect(CanExitHookResponseSchema.safeParse(result).success).toBe(true);
      expect(result).toEqual(expect.objectContaining({ allowed: true }));
    });

    it('returns parsed CanExitHookResponse when allowed=false with message', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ allowed: false, message: 'Blocked by policy' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const result = await dispatchSyncHook(mockProcessor, 'can-exit', {
        card: {},
        target_column: 'in-progress',
        actor: 'system',
      });

      expect(CanExitHookResponseSchema.safeParse(result).success).toBe(true);
      expect(result).toEqual(
        expect.objectContaining({ allowed: false, message: 'Blocked by policy' }),
      );
    });

    it('fails fast when fetch exceeds 3000ms', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.spyOn(global, 'fetch').mockImplementation(
        () => new Promise(() => {}),
      );

      const promise = dispatchSyncHook(mockProcessor, 'can-exit', {
        card: {},
        target_column: 'in-progress',
        actor: 'system',
      });

      vi.advanceTimersByTime(3001);

      await expect(promise).rejects.toThrow();

      vi.useRealTimers();
    });
  });

  describe('async on-enter dispatch', () => {
    it('exports dispatchAsyncHook function', () => {
      expect(typeof dispatchAsyncHook).toBe('function');
    });

    it('POSTs to processor on-enter endpoint with OnEnterDispatchRequestSchema payload', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'accepted' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const payload = {
        card: {
          uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
          board_uid: '550e8400-e29b-41d4-a716-446655440000',
          display_id: 'TST-1',
          title: 'Test Card',
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
          title: 'Test Board',
          prefix: 'TST',
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
          permissions: { read: [], write: [] },
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
        callback_url: 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
      };

      await dispatchAsyncHook(mockProcessor, 'on-enter', payload);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:4001/on-enter',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: expect.any(String),
        }),
      );

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(OnEnterDispatchRequestSchema.safeParse(callBody).success).toBe(true);
      expect(callBody.callback_url).toBe(payload.callback_url);
      expect(callBody.idempotency_key).toBe(payload.idempotency_key);
    });

    it('parses OnEnterDispatchAcceptedResponse on 202', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'accepted', estimated_duration: '5s' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await dispatchAsyncHook(mockProcessor, 'on-enter', {
        card: {},
        board: {},
        column: {},
        callback_url: 'http://localhost:3000/api/callbacks/123',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(result).success).toBe(true);
      expect(result.status).toBe('accepted');
    });

    it('does not block on processor non-2xx response', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('Bad Request', { status: 400 }),
      );

      await expect(
        dispatchAsyncHook(mockProcessor, 'on-enter', {
          card: {},
          board: {},
          column: {},
          callback_url: 'http://localhost:3000/api/callbacks/123',
          idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
        }),
      ).rejects.toThrow();
    });
  });
});
