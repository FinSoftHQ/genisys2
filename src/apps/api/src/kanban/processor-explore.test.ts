import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockAccess = vi.fn();
const mockExecFilePromise = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  constants: { X_OK: 1 },
}));

vi.mock('./exec-helpers.js', () => ({
  execFilePromise: (...args: unknown[]) => mockExecFilePromise(...args),
}));

import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
} from '@repo/shared';

import { exploreProcessorRoutes } from './processor-explore.js';

const mockBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      {
        uid: 'explore',
        title: 'Explore',
        type: 'Processing' as const,
        processor_id: 'explore',
        exit_logic: { default: 'agentic-team' },
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
    working_dir: '/tmp/workspaces/TST-1',
    body: 'Initial task body',
  },
  current_status: 'explore',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('explore processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockAccess.mockReset();
    mockExecFilePromise.mockReset();
    app = fastify();
    await app.register(exploreProcessorRoutes, { prefix: '/api/kanban-processor/explore' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
  });

  describe('GET /api/kanban-processor/explore/health', () => {
    it('returns healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/explore/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/explore/can-exit', () => {
    it('allows exit', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/can-exit',
        payload: { card: mockCard, target_column: 'agentic-team', actor: 'user:test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/explore/on-update', () => {
    it('allows update', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/on-update',
        payload: { card: mockCard, proposed_payload: { body: 'updated' }, actor: 'user:test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(OnUpdateResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/explore/on-enter', () => {
    it('accepts and runs context-generator when available', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecFilePromise.mockResolvedValue({ stdout: '', stderr: '' });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/on-enter',
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

      // Wait for async workflow
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAccess).toHaveBeenCalled();
      expect(mockExecFilePromise).toHaveBeenCalledWith(
        expect.stringContaining('.bin/context-generator'),
        ['-e', '.agents', '-e', 'tools', '-r', '/tmp/workspaces/TST-1', '-o', expect.stringContaining('llm_context.md')],
        { cwd: '/tmp/workspaces/TST-1', timeout: 60_000 },
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

      const fetchCall = fetchSpy.mock.calls[0];
      const fetchPayload = JSON.parse((fetchCall?.[1] as { body?: string })?.body ?? '{}');
      expect(fetchPayload.move_to_column).toBe('agentic-team');
      expect(fetchPayload.payload_updates.payload.body).toContain("The working repository structure is described in 'llm_context.md'.");
      expect(fetchPayload.payload_updates.payload.body).toContain('Initial task body');
    });

    it('appends note even when context-generator is missing', async () => {
      const err = new Error('ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      mockAccess.mockRejectedValue(err);

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440003';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440004',
        },
      });

      expect(response.statusCode).toBe(202);

      // Wait for async workflow
      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecFilePromise).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"success"'),
        }),
      );

      const fetchCall = fetchSpy.mock.calls[0];
      const fetchPayload = JSON.parse((fetchCall?.[1] as { body?: string })?.body ?? '{}');
      expect(fetchPayload.move_to_column).toBe('agentic-team');
      expect(fetchPayload.payload_updates.payload.body).toContain("The working repository structure is described in 'llm_context.md'.");
    });
  });

  describe('POST /api/kanban-processor/explore/on-action', () => {
    it('accepts and callbacks success', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/on-action',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          actor: 'user:test',
          callback_url: 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440005',
          idempotency_key: '550e8400-e29b-41d4-a716-446655440006',
          action: 'retry',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('accepted');
    });
  });

  describe('POST /api/kanban-processor/explore/on-exit', () => {
    it('acknowledges', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/on-exit',
        payload: {
          card: mockCard,
          next_column: {
            uid: 'agentic-team',
            title: 'AI Team',
            type: 'Processing',
            processor_id: 'agentic-team',
            exit_logic: { default: 'commit' },
            order: 1,
          },
          actor: 'system:processor',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });
  });
});
