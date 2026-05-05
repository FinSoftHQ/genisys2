import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockCreateCard,
  mockCreateCardRelationship,
  mockGetBoardById,
  mockListBoards,
  mockParseProtocolFromString,
  mockSession,
  mockCreateAgentSession,
  mockSessionManager,
  mockGetModel,
} = vi.hoisted(() => ({
  mockCreateCard: vi.fn(),
  mockCreateCardRelationship: vi.fn(),
  mockGetBoardById: vi.fn(),
  mockListBoards: vi.fn(),
  mockParseProtocolFromString: vi.fn(),
  mockSession: {
    prompt: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    abort: vi.fn(),
    dispose: vi.fn(),
    isStreaming: false,
    getLastAssistantText: vi.fn(),
  },
  mockCreateAgentSession: vi.fn(),
  mockSessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  mockGetModel: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createCard: (...args: unknown[]) => mockCreateCard(...args),
  createCardRelationship: (...args: unknown[]) => mockCreateCardRelationship(...args),
  getBoardById: (...args: unknown[]) => mockGetBoardById(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => mockCreateAgentSession(...args),
  SessionManager: mockSessionManager,
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
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
    mockCreateAgentSession.mockReset();
    mockGetModel.mockReset();
    Object.values(mockSession).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    });
    mockSession.subscribe.mockImplementation(() => vi.fn());
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
    it('creates a single clone card and stores planned tasks', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: { dev: 'Build login', tester: 'Write tests' },
      });
      mockGetModel.mockReturnValue(undefined);
      mockCreateAgentSession.mockResolvedValue({ session: mockSession });
      mockSession.isStreaming = true;
      mockSession.getLastAssistantText.mockReturnValue(
        '<<<PRE_FLIGHT>>>\nComplexity: Standard (2 subtasks). Building login and signup endpoints is a well-defined scope.\nPrimary Type: implementation\nAmbiguity Check: None. The task body is sufficiently detailed.\nDraft Plan & Validation:\n- [x] 100% coverage of the parent Task Body scope.\n- [x] No subtask exceeds one day of work.\n- [x] Every subtask is independently testable.\n- [x] Dependencies flow forward only.\n<<<TASK>>>\n<<<TITLE>>>\nImplement login endpoint\n<<<TYPE>>>\nimplementation\n<<<BODY>>>\nCreate the POST /login endpoint with email/password validation and JWT generation.\n<<<DEPENDS_ON>>>\nnone\n<<<ACCEPTANCE>>>\n- POST /login returns 200 with valid JWT for correct credentials.\n- POST /login returns 401 for incorrect credentials.\n<<<INSTRUCTIONS>>>\ndev: Implement the login endpoint\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<TASK>>>\n<<<TITLE>>>\nImplement signup endpoint\n<<<TYPE>>>\nimplementation\n<<<BODY>>>\nCreate the POST /signup endpoint with password hashing and user creation.\n<<<DEPENDS_ON>>>\nnone\n<<<ACCEPTANCE>>>\n- POST /signup creates a new user and returns 201.\n- Password is hashed before storage.\n<<<INSTRUCTIONS>>>\ndev: Implement the signup endpoint\ntester: Write signup tests\n<<<RISK>>>\nnone\n<<<END_TASK>>>\n<<<END>>>',
      );

      let streaming = true;
      const interval = setInterval(() => {
        streaming = false;
        mockSession.isStreaming = false;
        clearInterval(interval);
      }, 50);
      mockSession.prompt.mockImplementation(async () => {
        mockSession.isStreaming = streaming;
      });

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement auth system',
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

      expect(mockCreateCard).toHaveBeenCalledTimes(1);
      expect(mockCreateCardRelationship).toHaveBeenCalledTimes(1);

      // Verify the clone uses parent's title and description
      const createCall = mockCreateCard.mock.calls[0];
      expect(createCall[2].title).toBe(mockParentCard.title);
      expect(createCall[2].description).toBe(mockParentCard.description);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.task_card_uid).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(payload.payload_updates.payload.task_board_uid).toBe(mockTaskBoard.uid);
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(2);
      expect(payload.payload_updates.payload.planned_tasks[0].title).toBe('Implement login endpoint');
      expect(payload.payload_updates.payload.planned_tasks[1].title).toBe('Implement signup endpoint');
    });

    it('falls back to single card when LLM fails', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: { dev: 'Build login' },
      });
      mockGetModel.mockReturnValue(undefined);
      mockCreateAgentSession.mockRejectedValue(new Error('LLM unavailable'));

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
