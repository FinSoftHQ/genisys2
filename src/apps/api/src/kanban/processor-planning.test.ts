import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockCreateCard,
  mockCreateCardRelationship,
  mockGetBoardById,
  mockListBoards,
  mockParseProtocolFromString,
  mockComplete,
  mockGetModel,
} = vi.hoisted(() => ({
  mockCreateCard: vi.fn(),
  mockCreateCardRelationship: vi.fn(),
  mockGetBoardById: vi.fn(),
  mockListBoards: vi.fn(),
  mockParseProtocolFromString: vi.fn(),
  mockComplete: vi.fn(),
  mockGetModel: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createCard: (...args: unknown[]) => mockCreateCard(...args),
  createCardRelationship: (...args: unknown[]) => mockCreateCardRelationship(...args),
  getBoardById: (...args: unknown[]) => mockGetBoardById(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  complete: (...args: unknown[]) => mockComplete(...args),
  getModel: (...args: unknown[]) => mockGetModel(...args) ?? { provider: args[0], modelId: args[1] },
}));

vi.mock('../lib/ai-auth.js', () => ({
  getApiKey: vi.fn().mockResolvedValue('fake-api-key'),
}));

vi.mock('@repo/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/shared')>();
  return {
    ...actual,
    parseProtocolFromString: (...args: unknown[]) => mockParseProtocolFromString(...args),
  };
});

import {
  HealthCheckResponseSchema,
  CanExitHookResponseSchema,
  OnUpdateResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  ApiErrorSchema,
} from '@repo/shared';

import { planningProcessorRoutes } from './processor-planning.js';

const mockDevBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Development Board',
  prefix: 'DEV',
  suite_uid: '550e8400-e29b-41d4-a716-446655440001',
  role: 'primary',
  schema: {
    columns: [
      { uid: 'planning', title: 'Planning', type: 'Processing' as const, processor_id: 'planning', exit_logic: { default: 'delegated' }, order: 0 },
      { uid: 'delegated', title: 'Delegated', type: 'Processing' as const, processor_id: 'delegated', exit_logic: { default: 'wrap' }, order: 1 },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockTaskBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440002',
  title: 'Task Board',
  prefix: 'TSK',
  suite_uid: '550e8400-e29b-41d4-a716-446655440001',
  role: 'tasks',
  schema: {
    columns: [
      { uid: 'todo', title: 'TODO', type: 'Normal' as const, processor_id: 'todo', exit_logic: { default: 'agentic-team' }, order: 0 },
      { uid: 'agentic-team', title: 'AI Team', type: 'Processing' as const, processor_id: 'agentic-team', exit_logic: { default: 'commit' }, order: 1 },
    ],
  },
  permissions: { read: [] as string[], write: [] as string[] },
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

const mockParentCard = {
  uid: '550e8400-e29b-41d4-a716-446655440003',
  board_uid: '550e8400-e29b-41d4-a716-446655440000',
  display_id: 'DEV-1',
  title: 'Implement auth system',
  description: '---\ninstructions:\n  dev: Build login\n  tester: Write tests\n---\n\nCreate a full auth system with JWT.',
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: {
    workspace_path: '/workspaces/DEV-1',
    repo: 'https://github.com/org/repo.git',
  },
  current_status: 'planning',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('planning processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = fastify();
    await app.register(planningProcessorRoutes, { prefix: '/api/kanban-processor/planning' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    mockCreateCard.mockReset();
    mockCreateCardRelationship.mockReset();
    mockGetBoardById.mockReset();
    mockListBoards.mockReset();
    mockParseProtocolFromString.mockReset();
    mockComplete.mockReset();
    mockGetModel.mockReset();
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
  });

  describe('GET /api/kanban-processor/planning/health', () => {
    it('returns 200 with healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/planning/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/planning/can-exit', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/can-exit',
        payload: {
          card: mockParentCard,
          target_column: 'delegated',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/planning/on-update', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-update',
        payload: {
          card: mockParentCard,
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

  describe('POST /api/kanban-processor/planning/on-enter', () => {
    it('creates multiple task cards and stores planned tasks', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: { dev: 'Build login', tester: 'Write tests' },
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<<<PRE_FLIGHT>>>\nComplexity: Standard (2 subtasks). Building login and signup endpoints is a well-defined scope.\nPrimary Type: implementation\nAmbiguity Check: None. The task body is sufficiently detailed.\nDraft Plan & Validation:\n- [x] 100% coverage of the parent Task Body scope.\n- [x] No subtask exceeds one day of work.\n- [x] Every subtask is independently testable.\n- [x] Dependencies flow forward only.\n<<<TASK>>>\n<<<TITLE>>>\nImplement login endpoint\n<<<TYPE>>>\nimplementation\n<<<BODY>>>\nCreate the POST /login endpoint with email/password validation and JWT generation.\n<<<DEPENDS_ON>>>\nnone\n<<<ACCEPTANCE>>>\n- POST /login returns 200 with valid JWT for correct credentials.\n- POST /login returns 401 for incorrect credentials.\n<<<INSTRUCTIONS>>>\ndev: Implement the login endpoint\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<TASK>>>\n<<<TITLE>>>\nImplement signup endpoint\n<<<TYPE>>>\nimplementation\n<<<BODY>>>\nCreate the POST /signup endpoint with password hashing and user creation.\n<<<DEPENDS_ON>>>\nnone\n<<<ACCEPTANCE>>>\n- POST /signup creates a new user and returns 201.\n- Password is hashed before storage.\n<<<INSTRUCTIONS>>>\ndev: Implement the signup endpoint\ntester: Write signup tests\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<END>>>',
          },
        ],
      } as unknown as Awaited<ReturnType<typeof mockComplete>>);

      mockCreateCard
        .mockReturnValueOnce({
          uid: '550e8400-e29b-41d4-a716-446655440010',
          board_uid: mockTaskBoard.uid,
          display_id: 'TSK-10',
          title: 'Implement login endpoint',
        })
        .mockReturnValueOnce({
          uid: '550e8400-e29b-41d4-a716-446655440011',
          board_uid: mockTaskBoard.uid,
          display_id: 'TSK-11',
          title: 'Implement signup endpoint',
        });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440020';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440010',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(OnEnterDispatchAcceptedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('accepted');

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockCreateCard).toHaveBeenCalledTimes(2);
      expect(mockCreateCardRelationship).toHaveBeenCalledTimes(2);

      // Verify first task card uses task title and body
      const firstCreateCall = mockCreateCard.mock.calls[0];
      expect(firstCreateCall[2].title).toBe('Implement login endpoint');
      expect(firstCreateCall[2].description).toContain('Create the POST /login endpoint');
      expect(firstCreateCall[2].current_status).toBe('todo');

      // Verify second task card
      const secondCreateCall = mockCreateCard.mock.calls[1];
      expect(secondCreateCall[2].title).toBe('Implement signup endpoint');
      expect(secondCreateCall[2].description).toContain('Create the POST /signup endpoint');

      // Verify parent→child relationships
      expect(mockCreateCardRelationship).toHaveBeenNthCalledWith(
        1,
        {},
        mockParentCard.board_uid,
        mockParentCard.uid,
        '550e8400-e29b-41d4-a716-446655440010',
        'dependency',
        mockParentCard.board_uid,
        mockTaskBoard.uid,
      );
      expect(mockCreateCardRelationship).toHaveBeenNthCalledWith(
        2,
        {},
        mockParentCard.board_uid,
        mockParentCard.uid,
        '550e8400-e29b-41d4-a716-446655440011',
        'dependency',
        mockParentCard.board_uid,
        mockTaskBoard.uid,
      );

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.task_card_uids).toEqual([
        '550e8400-e29b-41d4-a716-446655440010',
        '550e8400-e29b-41d4-a716-446655440011',
      ]);
      expect(payload.payload_updates.payload.task_board_uid).toBe(mockTaskBoard.uid);
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(2);
      expect(payload.payload_updates.payload.planned_tasks[0].title).toBe('Implement login endpoint');
      expect(payload.payload_updates.payload.planned_tasks[1].title).toBe('Implement signup endpoint');
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it('parses multi-line instructions from LLM output', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<<<PRE_FLIGHT>>>\nComplexity: Standard (1 subtask).\nPrimary Type: implementation\n<<<TASK>>>\n<<<TITLE>>>\nImplement login endpoint\n<<<TYPE>>>\nimplementation\n<<<BODY>>>\nCreate the POST /login endpoint.\n<<<DEPENDS_ON>>>\nnone\n<<<ACCEPTANCE>>>\n- POST /login returns 200.\n<<<INSTRUCTIONS>>>\ndev: |\n  Implement the login endpoint\n  Add validation middleware\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<END>>>',
          },
        ],
      } as unknown as Awaited<ReturnType<typeof mockComplete>>);

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440020';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440010',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockCreateCard).toHaveBeenCalledTimes(1);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.payload_updates.payload.task_card_uids).toEqual([
        '550e8400-e29b-41d4-a716-446655440010',
      ]);
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(1);
      expect(payload.payload_updates.payload.planned_tasks[0].instructions).toEqual({
        dev: 'Implement the login endpoint\nAdd validation middleware',
      });
    });

    it('creates inter-task dependency relationships when tasks depend on each other', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<<<PRE_FLIGHT>>>\nComplexity: Standard (2 subtasks).\nPrimary Type: implementation\n<<<TASK>>>\n<<<TITLE>>>\nDefine auth schema\n<<<TYPE>>>\ninfrastructure\n<<<BODY>>>\nDefine the user schema and migration.\n<<<DEPENDS_ON>>>\nnone\n<<<ACCEPTANCE>>>\n- Schema is defined.\n<<<INSTRUCTIONS>>>\ndev: Define schema\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<TASK>>>\n<<<TITLE>>>\nImplement login endpoint\n<<<TYPE>>>\nimplementation\n<<<BODY>>>\nCreate the POST /login endpoint.\n<<<DEPENDS_ON>>>\nDefine auth schema\n<<<ACCEPTANCE>>>\n- POST /login returns 200.\n<<<INSTRUCTIONS>>>\ndev: Implement login\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<END>>>',
          },
        ],
      } as unknown as Awaited<ReturnType<typeof mockComplete>>);

      mockCreateCard
        .mockReturnValueOnce({
          uid: '550e8400-e29b-41d4-a716-446655440030',
          board_uid: mockTaskBoard.uid,
          display_id: 'TSK-30',
          title: 'Define auth schema',
        })
        .mockReturnValueOnce({
          uid: '550e8400-e29b-41d4-a716-446655440031',
          board_uid: mockTaskBoard.uid,
          display_id: 'TSK-31',
          title: 'Implement login endpoint',
        });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440025';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440015',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockCreateCard).toHaveBeenCalledTimes(2);
      // 2 parent→child + 1 inter-task dependency
      expect(mockCreateCardRelationship).toHaveBeenCalledTimes(3);

      // Verify inter-task dependency: schema → login
      expect(mockCreateCardRelationship).toHaveBeenNthCalledWith(
        3,
        {},
        mockTaskBoard.uid,
        '550e8400-e29b-41d4-a716-446655440030',
        '550e8400-e29b-41d4-a716-446655440031',
        'dependency',
        mockTaskBoard.uid,
        mockTaskBoard.uid,
      );

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.payload_updates.payload.task_card_uids).toEqual([
        '550e8400-e29b-41d4-a716-446655440030',
        '550e8400-e29b-41d4-a716-446655440031',
      ]);
    });

    it('falls back to single card when LLM fails', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: { dev: 'Build login' },
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockRejectedValue(new Error('LLM unavailable'));

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440020',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-20',
        title: 'Implement auth system',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440021';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440011',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCreateCard).toHaveBeenCalledTimes(1);
      expect(mockCreateCardRelationship).toHaveBeenCalledTimes(1);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.task_card_uid).toBe('550e8400-e29b-41d4-a716-446655440020');
      expect(payload.payload_updates.payload.planned_tasks).toEqual([]);
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/planning/on-action', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440022';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-action',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          action: 'Retry',
          actor: 'user:test@example.com',
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440012',
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

  describe('POST /api/kanban-processor/planning/on-exit', () => {
    it('returns 200 acknowledged', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-exit',
        payload: {
          card: mockParentCard,
          next_column: mockDevBoard.schema.columns[0],
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');
    });
  });
});
