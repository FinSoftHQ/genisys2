import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockGetCardById = vi.fn();
const mockUpdateCard = vi.fn();

vi.mock('./repository.js', () => ({
  getCardById: (...args: unknown[]) => mockGetCardById(...args),
  updateCard: (...args: unknown[]) => mockUpdateCard(...args),
}));

import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';

import { wipProcessorRoutes } from './processor-wip.js';

const mockBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      {
        uid: 'wip',
        title: 'WIP',
        type: 'Processing' as const,
        processor_id: 'wip',
        exit_logic: { default: 'wrap' },
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
  payload: { repository_url: 'https://github.com/test-org/test-repo.git', tailor_shop: '/workspace/teams/dev' },
  current_status: 'wip',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockCardWithProtocol = {
  ...mockCard,
  payload: {
    repository_url: 'https://github.com/test-org/test-repo.git',
    tailor_shop: '/workspace/teams/dev',
    workspace_path: '/workspace/TST-1',
    team: { alice: 'Developer', bob: 'Reviewer' },
    routes: { alice: ['bob'], bob: ['alice'] },
    facilitator: 'alice',
    instructions: { alice: 'Implement the feature', bob: 'Review the code' },
    body: 'Build the new feature.',
  },
};

describe('wip processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = fastify();
    await app.register(wipProcessorRoutes, { prefix: '/api/kanban-processor/wip' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetCardById.mockReset();
    mockUpdateCard.mockReset();
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('GET /api/kanban-processor/wip/health', () => {
    it('returns 200 with healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/wip/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/wip/can-exit', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/can-exit',
        payload: {
          card: mockCard,
          target_column: 'wrap',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/wip/on-update', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-update',
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

  describe('POST /api/kanban-processor/wip/on-enter', () => {
    it('returns 202 accepted, logs payload, and creates agent room', async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/agent-rooms')) {
          return new Response(JSON.stringify({ roomId: 'rm_default123', status: 'initialized' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 200 });
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-enter',
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

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[wip] Card',
        'TST-1',
        'payload:',
        JSON.stringify(mockCard.payload, null, 2),
      );

      // Verify agent-rooms POST was made with composed markdown
      const agentRoomsCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/v1/agent-rooms');
      });
      expect(agentRoomsCall).toBeDefined();

      // Verify kanban callback includes room_id
      const kanbanCallbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(kanbanCallbackCall).toBeDefined();
      const kanbanInit = kanbanCallbackCall![1] as { body: string };
      const kanbanPayload = JSON.parse(kanbanInit.body);
      expect(kanbanPayload.status).toBe('success');
      expect(kanbanPayload.payload_updates.payload.room_id).toBe('rm_default123');
    });

    it('composes markdown, POSTs to agent-rooms, and callbacks with room_id on success', async () => {
      const roomId = 'rm_abc123';
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/agent-rooms')) {
          return new Response(JSON.stringify({ roomId, status: 'initialized' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 200 });
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-enter',
        payload: {
          card: mockCardWithProtocol,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify agent-rooms POST
      const agentRoomsCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/v1/agent-rooms');
      });
      expect(agentRoomsCall).toBeDefined();
      const [agentRoomsUrl, agentRoomsInit] = agentRoomsCall!;
      expect(agentRoomsUrl).toContain('/api/v1/agent-rooms');
      expect(agentRoomsInit).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'text/markdown',
        }),
      });

      const markdownBody = agentRoomsInit?.body as string;
      expect(markdownBody).toContain('---');
      expect(markdownBody).toContain('team:');
      expect(markdownBody).toContain('alice: Developer');
      expect(markdownBody).toContain('bob: Reviewer');
      expect(markdownBody).toContain('routes:');
      expect(markdownBody).toContain('facilitator: alice');
      expect(markdownBody).toContain('tailor_shop:');
      expect(markdownBody).toContain('working_dir: /workspace/TST-1');
      expect(markdownBody).toContain('instructions:');
      expect(markdownBody).toContain('Card: TST-1 / Test Card');
      expect(markdownBody).toContain('Build the new feature.');

      // Verify kanban callback includes room_id
      const kanbanCallbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(kanbanCallbackCall).toBeDefined();
      const kanbanInit = kanbanCallbackCall![1] as { body: string };
      const kanbanPayload = JSON.parse(kanbanInit.body);
      expect(kanbanPayload.status).toBe('success');
      expect(kanbanPayload.payload_updates.payload.room_id).toBe(roomId);
    });

    it('callbacks with error when agent-rooms returns non-2xx', async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/agent-rooms')) {
          return new Response(JSON.stringify({ error: 'No team members found' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 200 });
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-enter',
        payload: {
          card: mockCardWithProtocol,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const kanbanCallbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(kanbanCallbackCall).toBeDefined();
      const kanbanInit = kanbanCallbackCall![1] as { body: string };
      const kanbanPayload = JSON.parse(kanbanInit.body);
      expect(kanbanPayload.status).toBe('error');
      expect(kanbanPayload.error_message).toContain('Agent room creation failed');
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-enter',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/wip/on-action', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-action',
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

  describe('POST /api/kanban-processor/wip/on-exit', () => {
    it('returns 200 acknowledged', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-exit',
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

  describe('POST /api/kanban-processor/wip/_internal/room-closed', () => {
    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/_internal/room-closed',
        payload: { type: 'room_closed', roomId: 'rm_abc' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });

    it('returns 200 acknowledged when roomId not in registry', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/_internal/room-closed',
        payload: {
          type: 'room_closed',
          roomId: 'rm_unknown',
          reason: 'completed',
          at: '2026-04-26T10:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });

    it('updates card payload when room closes', async () => {
      // First create a room to populate the registry
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/agent-rooms')) {
          return new Response(JSON.stringify({ roomId: 'rm_test123', status: 'initialized' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 200 });
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-enter',
        payload: {
          card: mockCardWithProtocol,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockGetCardById.mockReturnValue({
        ...mockCardWithProtocol,
        payload: { ...mockCardWithProtocol.payload, room_id: 'rm_test123' },
      });

      mockUpdateCard.mockReturnValue({
        ...mockCardWithProtocol,
        version: 2,
        payload: {
          ...mockCardWithProtocol.payload,
          room_id: 'rm_test123',
          room_status: 'completed',
          room_closed_at: '2026-04-26T10:00:00.000Z',
          room_close_reason: 'completed',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/_internal/room-closed',
        payload: {
          type: 'room_closed',
          roomId: 'rm_test123',
          reason: 'completed',
          at: '2026-04-26T10:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');

      expect(mockGetCardById).toHaveBeenCalledWith({}, mockCardWithProtocol.board_uid, mockCardWithProtocol.uid);
      expect(mockUpdateCard).toHaveBeenCalledWith(
        {},
        mockCardWithProtocol.board_uid,
        mockCardWithProtocol.uid,
        expect.objectContaining({
          version: 1,
          payload: expect.objectContaining({
            room_status: 'completed',
            room_closed_at: '2026-04-26T10:00:00.000Z',
            room_close_reason: 'completed',
          }),
        }),
        'system:room-closed',
      );
    });

    it('returns 200 when card not found in DB', async () => {
      // First create a room to populate the registry
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/v1/agent-rooms')) {
          return new Response(JSON.stringify({ roomId: 'rm_test456', status: 'initialized' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 200 });
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/on-enter',
        payload: {
          card: mockCardWithProtocol,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockGetCardById.mockReturnValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wip/_internal/room-closed',
        payload: {
          type: 'room_closed',
          roomId: 'rm_test456',
          reason: 'completed',
          at: '2026-04-26T10:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockUpdateCard).not.toHaveBeenCalled();
    });
  });
});
