import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';
import { definePiProcessor } from './define-processor.js';
import { fireAndForgetCallback } from './callback.js';

const mockCard = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'TST-1',
  title: 'Test Card',
  description: null,
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: {},
  current_status: 'backlog',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      {
        uid: 'backlog',
        title: 'Backlog',
        type: 'Processing' as const,
        processor_id: 'default-manual',
        exit_logic: { default: 'in-progress' },
        order: 0,
      },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('definePiProcessor', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = fastify();
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
  });

  describe('default behaviours', () => {
    beforeEach(async () => {
      await app.register(definePiProcessor({ id: 'test-default' }), {
        prefix: '/api/kanban-processor/test-default',
      });
    });

    it('returns 200 healthy on /health', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/test-default/health',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });

    it('returns 200 allowed: true on /can-exit', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-default/can-exit',
        payload: {
          card: mockCard,
          target_column: 'in-progress',
          actor: 'user:test@example.com',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });

    it('returns 200 allowed: true on /on-update', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-default/on-update',
        payload: {
          card: mockCard,
          proposed_payload: { title: 'New' },
          actor: 'user:test@example.com',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(OnUpdateResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });

    it('returns 202 accepted and fires callback on /on-enter', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/abc';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-default/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
        },
      });
      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('returns 202 accepted and fires callback on /on-action', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/action';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-default/on-action',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          action: 'Approve',
          actor: 'user:test@example.com',
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
        },
      });
      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('accepted');

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer processor',
          }),
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('returns 200 acknowledged on /on-exit', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-default/on-exit',
        payload: {
          card: mockCard,
          next_column: mockBoard.schema.columns[0],
          actor: 'user:test@example.com',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });

    it('returns 400 for invalid body with VALIDATION_ERROR code', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-default/can-exit',
        payload: { card: 'not-a-card' },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Invalid request body');
      expect(Array.isArray(body.error.details.issues)).toBe(true);
    });
  });

  describe('custom handlers', () => {
    it('invokes custom onEnter and suppresses default callback', async () => {
      const custom = definePiProcessor({
        id: 'test-custom-enter',
        onEnter: async (_ctx, _request) => {
          return {
            status: 'accepted' as const,
            estimated_duration: '5m',
          };
        },
      });

      await app.register(custom, { prefix: '/api/kanban-processor/test-custom-enter' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-custom-enter/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: 'http://localhost/cb',
          idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.estimated_duration).toBe('5m');
      // Custom handler should not auto-fire callback
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('invokes custom onAction and suppresses default callback', async () => {
      const custom = definePiProcessor({
        id: 'test-custom-action',
        onAction: async (_ctx, _request) => {
          return {
            status: 'accepted' as const,
            estimated_duration: '3m',
          };
        },
      });

      await app.register(custom, { prefix: '/api/kanban-processor/test-custom-action' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-custom-action/on-action',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          action: 'Retry',
          actor: 'user:test@example.com',
          callback_url: 'http://localhost/cb',
          idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.estimated_duration).toBe('3m');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('invokes custom onExit and returns its response', async () => {
      const custom = definePiProcessor({
        id: 'test-custom-exit',
        onExit: async (_ctx, _request) => {
          return { status: 'acknowledged' as const };
        },
      });

      await app.register(custom, { prefix: '/api/kanban-processor/test-custom-exit' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-custom-exit/on-exit',
        payload: {
          card: mockCard,
          next_column: mockBoard.schema.columns[0],
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });

    it('invokes custom canExit and returns its response', async () => {
      const custom = definePiProcessor({
        id: 'test-custom-canexit',
        canExit: async (_ctx, _request) => {
          return { allowed: false, message: 'Blocked by custom rule' };
        },
      });

      await app.register(custom, { prefix: '/api/kanban-processor/test-custom-canexit' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-custom-canexit/can-exit',
        payload: {
          card: mockCard,
          target_column: 'in-progress',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.allowed).toBe(false);
      expect(body.message).toBe('Blocked by custom rule');
    });

    it('invokes custom onUpdate and returns its response', async () => {
      const custom = definePiProcessor({
        id: 'test-custom-update',
        onUpdate: async (_ctx, _request) => {
          return { allowed: false, message: 'Updates disabled' };
        },
      });

      await app.register(custom, { prefix: '/api/kanban-processor/test-custom-update' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/test-custom-update/on-update',
        payload: {
          card: mockCard,
          proposed_payload: { title: 'New' },
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.allowed).toBe(false);
      expect(body.message).toBe('Updates disabled');
    });
  });
});

describe('fireAndForgetCallback', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('POSTs JSON with correct headers', () => {
    fireAndForgetCallback('http://localhost/cb', { status: 'success' }, 'test-proc');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost/cb',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer processor',
        },
        body: JSON.stringify({ status: 'success' }),
      },
    );
  });

  it('swallows fetch failures silently when no processorId', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));
    fireAndForgetCallback('http://localhost/cb', { status: 'success' });
    // Allow microtask queue to drain
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs to console.error when fetch fails and processorId is provided', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));
    fireAndForgetCallback('http://localhost/cb', { status: 'success' }, 'test-proc');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[test-proc] Callback failed:',
      'Network error',
    );
  });
});
