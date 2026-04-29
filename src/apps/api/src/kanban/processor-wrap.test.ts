import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
    const opts = args.length > 2 && typeof args[args.length - 2] === 'object' && args[args.length - 2] !== null
      ? (args[args.length - 2] as Record<string, unknown>)
      : {};
    mockExecFile(args[0], ...(args.slice(1, args.length - 2) as unknown[]), opts);
    let stdout = '';
    const allArgs = args.slice(1, args.length - 2).flat() as unknown[];
    const cmdArgs = allArgs.filter((a): a is string => typeof a === 'string');
    if (cmdArgs.includes('auth') && cmdArgs.includes('status')) {
      stdout = 'github.com\n  ✓ Logged in to github.com\n';
    }
    if (cb) cb(null, stdout, '');
    return {} as any;
  },
}));

import { wrapProcessorRoutes } from './processor-wrap.js';

const mockBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      {
        uid: 'wrap',
        title: 'Wrap',
        type: 'Processing' as const,
        processor_id: 'wrap',
        exit_logic: { default: 'done' },
        order: 0,
      },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockCard = {
  uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'TST-1',
  title: 'Test Card',
  description: null,
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: {
    workspace_path: '/tmp/workspaces/TST-1',
    repository_url: 'https://github.com/test-org/test-repo.git',
  },
  current_status: 'wrap',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('wrap processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockExecFile.mockClear();
    app = fastify();
    await app.register(wrapProcessorRoutes, { prefix: '/api/kanban-processor/wrap' });
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/dev-wrapup')) {
        return new Response(
          JSON.stringify({
            commit_message: 'feat: add feature',
            pr_title: '[TST-1] Add feature',
            pr_body: '## Summary\n\nThis PR adds a feature.',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
  });

  describe('GET /api/kanban-processor/wrap/health', () => {
    it('returns 200 with healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/wrap/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/wrap/can-exit', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/can-exit',
        payload: {
          card: mockCard,
          target_column: 'done',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/wrap/on-update', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-update',
        payload: {
          card: mockCard,
          proposed_payload: { title: 'New Title' },
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(OnUpdateResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/wrap/on-enter', () => {
    it('returns 202 accepted and fires success callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('accepted');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/dev-wrapup'),
        expect.objectContaining({ method: 'POST' }),
      );

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['auth', 'status']),
        expect.anything(),
      );

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining([
          'pr', 'create',
          '--title', '[TST-1] Add feature',
          '--body', '## Summary\n\nThis PR adds a feature.',
        ]),
        expect.anything(),
      );

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

    it('fires error callback when workspace_path is missing', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440003';
      const cardNoWorkspace = { ...mockCard, payload: {} };

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: cardNoWorkspace,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440004',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"error"'),
        }),
      );
    });

    it('fires error callback when dev-wrapup API fails', async () => {
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes('/api/v1/dev-wrapup')) {
          return new Response(JSON.stringify({ error: 'bad' }), { status: 500 });
        }
        return new Response(null, { status: 200 });
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440005';

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440006',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"error"'),
        }),
      );
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/wrap/on-action', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-action',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          action: 'Retry',
          actor: 'user:test@example.com',
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
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
  });

  describe('POST /api/kanban-processor/wrap/on-exit', () => {
    it('returns 200 acknowledged', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-exit',
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
  });
});
