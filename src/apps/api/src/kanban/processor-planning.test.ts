import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockCreateCard,
  mockCreateCardRelationship,
  mockGetBoardById,
  mockListBoards,
  mockParseProtocolFromString,
  mockParseProtocol,
  mockComplete,
  mockGetModel,
} = vi.hoisted(() => ({
  mockCreateCard: vi.fn(),
  mockCreateCardRelationship: vi.fn(),
  mockGetBoardById: vi.fn(),
  mockListBoards: vi.fn(),
  mockParseProtocolFromString: vi.fn(),
  mockParseProtocol: vi.fn(),
  mockComplete: vi.fn(),
  mockGetModel: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createCard: (...args: unknown[]) => mockCreateCard(...args),
  createCardRelationship: (...args: unknown[]) => mockCreateCardRelationship(...args),
  getBoardById: (...args: unknown[]) => mockGetBoardById(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
}));

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return {
    ...actual,
    complete: (...args: unknown[]) => mockComplete(...args),
    getModel: (...args: unknown[]) => mockGetModel(...args) ?? { provider: args[0], modelId: args[1] },
  };
});

vi.mock('../lib/ai-auth.js', () => ({
  getApiKey: vi.fn().mockResolvedValue('fake-api-key'),
}));

vi.mock('@repo/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/shared')>();
  return {
    ...actual,
    parseProtocolFromString: (...args: unknown[]) => mockParseProtocolFromString(...args),
    parseProtocol: (...args: unknown[]) => mockParseProtocol(...args),
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

function makePlanningV1Response(overrides?: { tasks?: unknown[]; clarification_needed?: unknown }) {
  const header = {
    version: 'planning.v1',
    pre_flight: {
      complexity_level: 'standard',
      justification: 'Well-defined scope.',
      primary_type: 'implementation',
      ambiguity_status: 'none',
      missing_info: [],
      validation: {
        coverage_complete: true,
        fits_one_day: true,
        independently_testable: true,
        forward_dependencies_only: true,
        notes: [],
      },
    },
    clarification_needed: {
      required: false,
      questions: [],
    },
  };
  const tasks = overrides?.tasks ?? [];
  const clarification = overrides?.clarification_needed;
  const lines = [
    JSON.stringify(clarification !== undefined ? { ...header, clarification_needed: clarification } : header),
    ...(Array.isArray(tasks) ? tasks.map((t) => JSON.stringify(t)) : []),
  ];
  return lines.join('\n');
}

function makeLlmResponse(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as Awaited<ReturnType<typeof mockComplete>>;
}

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
    mockParseProtocol.mockReset();
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
    it('creates multiple task cards and stores planned tasks from valid JSON', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: { dev: 'Build login', tester: 'Write tests' },
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint with email/password validation and JWT generation.'],
                depends_on: [],
                acceptance: ['POST /login returns 200 with valid JWT for correct credentials.'],
                instructions: { agent_name: 'dev', notes: ['Implement the login endpoint'] },
                risk: [],
              },
              {
                id: 'T2',
                title: 'Implement signup endpoint',
                type: 'implementation',
                body: ['Create the POST /signup endpoint with password hashing and user creation.'],
                depends_on: [],
                acceptance: ['POST /signup creates a new user and returns 201.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
            ],
          })
        )
      );

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

      const firstCreateCall = mockCreateCard.mock.calls[0];
      expect(firstCreateCall[2].title).toBe('Implement login endpoint');
      expect(firstCreateCall[2].description).toContain('Create the POST /login endpoint');
      expect(firstCreateCall[2].description.startsWith('## Scope of Work')).toBe(true);
      expect(firstCreateCall[2].current_status).toBe('todo');

      const secondCreateCall = mockCreateCard.mock.calls[1];
      expect(secondCreateCall[2].title).toBe('Implement signup endpoint');
      expect(secondCreateCall[2].description).toContain('Create the POST /signup endpoint');
      expect(secondCreateCall[2].description.startsWith('## Scope of Work')).toBe(true);

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

    it('creates inter-task dependency relationships by task ID', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Define auth schema',
                type: 'infrastructure',
                body: ['Define the user schema and migration.'],
                depends_on: [],
                acceptance: ['Schema is defined.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
              {
                id: 'T2',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint.'],
                depends_on: ['T1'],
                acceptance: ['POST /login returns 200.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
            ],
          })
        )
      );

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

    it('handles clarification-needed flow without creating child cards', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            clarification_needed: { required: true, questions: ['What auth provider should we use?'] },
            tasks: [],
          })
        )
      );

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440026';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440016',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockCreateCard).not.toHaveBeenCalled();
      expect(mockCreateCardRelationship).not.toHaveBeenCalled();

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.planned_tasks).toEqual([]);
      expect(payload.payload_updates.payload.clarification_needed.required).toBe(true);
      expect(payload.payload_updates.payload.clarification_needed.questions).toEqual([
        'What auth provider should we use?',
      ]);
    });

    it('repairs malformed output successfully on second LLM call', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);

      // First call: broken JSON
      // Second call: valid JSON
      mockComplete
        .mockResolvedValueOnce(
          makeLlmResponse('this is not json { broken')
        )
        .mockResolvedValueOnce(
          makeLlmResponse(
            makePlanningV1Response({
              tasks: [
                {
                  id: 'T1',
                  title: 'Implement login endpoint',
                  type: 'implementation',
                  body: ['Create the POST /login endpoint.'],
                  depends_on: [],
                  acceptance: ['POST /login returns 200.'],
                  instructions: { agent_name: null, notes: [] },
                  risk: [],
                },
              ],
            })
          )
        );

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440027';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440017',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockComplete).toHaveBeenCalledTimes(2);
      expect(mockCreateCard).toHaveBeenCalledTimes(1);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(1);
      expect(payload.payload_updates.payload.planned_tasks[0].title).toBe('Implement login endpoint');
    });

    it('falls back to clone with diagnostics when repair also fails', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: { dev: 'Build login' },
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(makeLlmResponse('still not json'));

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
      expect(payload.payload_updates.payload.planning_raw_output).toBeDefined();
      expect(payload.payload_updates.payload.planning_parse_errors).toBeDefined();
      expect(payload.payload_updates.payload.planning_validation_errors).toBeDefined();
    });

    it('falls back to clone when semantic validation fails and repair fails', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);

      // First: valid JSON but with a self-dependency
      // Second: still invalid
      mockComplete
        .mockResolvedValueOnce(
          makeLlmResponse(
            makePlanningV1Response({
              tasks: [
                {
                  id: 'T1',
                  title: 'Bad task',
                  type: 'implementation',
                  body: ['Body.'],
                  depends_on: ['T1'],
                  acceptance: ['Acc.'],
                  instructions: { agent_name: null, notes: [] },
                  risk: [],
                },
              ],
            })
          )
        )
        .mockResolvedValueOnce(makeLlmResponse('not json'))
        .mockResolvedValueOnce(makeLlmResponse('still not json'));

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440020',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-20',
        title: 'Implement auth system',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440028';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440018',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCreateCard).toHaveBeenCalledTimes(1);
      expect(mockComplete).toHaveBeenCalledTimes(3);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.payload_updates.payload.planning_validation_errors).toEqual(
        expect.arrayContaining([expect.stringContaining('self-dependency')])
      );
    });

    it('extracts JSONL from markdown code fences with prose', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);

      // LLM wrapped JSONL in ```jsonl ... ``` with prose before and after
      const fencedJsonl = `Now I have the full picture. Let me break this down.

\`\`\`jsonl
${makePlanningV1Response({
  tasks: [
    {
      id: 'T1',
      title: 'Implement login endpoint',
      type: 'implementation',
      body: ['Create the POST /login endpoint.'],
      depends_on: [],
      acceptance: ['POST /login returns 200.'],
      instructions: { agent_name: null, notes: [] },
      risk: [],
    },
  ],
})}
\`\`\`

Hope this helps! Let me know if you need anything else.`;

      mockComplete.mockResolvedValue(makeLlmResponse(fencedJsonl));

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440040';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440040',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(mockCreateCard).toHaveBeenCalledTimes(1);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(1);
      expect(payload.payload_updates.payload.planned_tasks[0].title).toBe('Implement login endpoint');
    });

    it('extracts JSONL from plain markdown fences', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);

      // LLM used plain ``` ... ``` without language tag
      const plainFencedJsonl = `Here is the plan:

\`\`\`
${makePlanningV1Response({
  tasks: [
    {
      id: 'T1',
      title: 'Implement login endpoint',
      type: 'implementation',
      body: ['Create the POST /login endpoint.'],
      depends_on: [],
      acceptance: ['POST /login returns 200.'],
      instructions: { agent_name: null, notes: [] },
      risk: [],
    },
  ],
})}
\`\`\``;

      mockComplete.mockResolvedValue(makeLlmResponse(plainFencedJsonl));

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440041';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440041',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(mockCreateCard).toHaveBeenCalledTimes(1);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(1);
      expect(payload.payload_updates.payload.planned_tasks[0].title).toBe('Implement login endpoint');
    });

    it('recovers from truncated JSONL via repair pass', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);

      // First call: truncated JSONL — last task line is incomplete
      const truncatedJsonl = makePlanningV1Response({
        tasks: [
          {
            id: 'T1',
            title: 'Implement login endpoint',
            type: 'implementation',
            body: ['Create the POST /login endpoint.'],
            depends_on: [],
            acceptance: ['POST /login returns 200.'],
            instructions: { agent_name: null, notes: [] },
            risk: [],
          },
        ],
      }) + '\n{"id":"T2","title":"Implement signup endpoint","type":"implementation","body":["Create the';

      mockComplete
        .mockResolvedValueOnce(makeLlmResponse(truncatedJsonl))
        .mockResolvedValueOnce(
          makeLlmResponse(
            makePlanningV1Response({
              tasks: [
                {
                  id: 'T1',
                  title: 'Implement login endpoint',
                  type: 'implementation',
                  body: ['Create the POST /login endpoint.'],
                  depends_on: [],
                  acceptance: ['POST /login returns 200.'],
                  instructions: { agent_name: null, notes: [] },
                  risk: [],
                },
                {
                  id: 'T2',
                  title: 'Implement signup endpoint',
                  type: 'implementation',
                  body: ['Create the POST /signup endpoint.'],
                  depends_on: [],
                  acceptance: ['POST /signup returns 201.'],
                  instructions: { agent_name: null, notes: [] },
                  risk: [],
                },
              ],
            })
          )
        );

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

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440030';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440030',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockComplete).toHaveBeenCalledTimes(2);
      expect(mockCreateCard).toHaveBeenCalledTimes(2);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(2);
    });

    it('generates and appends markdown summary on success', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint.'],
                depends_on: [],
                acceptance: ['POST /login returns 200.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
            ],
          })
        )
      );

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440029';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440019',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.payload_updates.description).toContain('# Planning Summary');
      expect(payload.payload_updates.description).toContain('Implement login endpoint');
      expect(payload.payload_updates.description).toContain('Complexity:');
    });

    it('succeeds when LLM omits header and outputs only task objects', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);

      // No header — only task lines
      const taskOnlyJsonl = [
        JSON.stringify({
          id: 'T1',
          title: 'Implement login endpoint',
          type: 'implementation',
          body: ['Create the POST /login endpoint.'],
          depends_on: [],
          acceptance: ['POST /login returns 200.'],
          instructions: { agent_name: null, notes: [] },
          risk: [],
        }),
        JSON.stringify({
          id: 'T2',
          title: 'Implement signup endpoint',
          type: 'implementation',
          body: ['Create the POST /signup endpoint.'],
          depends_on: [],
          acceptance: ['POST /signup returns 201.'],
          instructions: { agent_name: null, notes: [] },
          risk: [],
        }),
      ].join('\n');

      mockComplete.mockResolvedValue(makeLlmResponse(taskOnlyJsonl));

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

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440050';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440050',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(mockCreateCard).toHaveBeenCalledTimes(2);

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.status).toBe('success');
      expect(payload.move_to_column).toBe('delegated');
      expect(payload.payload_updates.payload.planned_tasks).toHaveLength(2);
      expect(payload.payload_updates.payload.planned_tasks[0].title).toBe('Implement login endpoint');
      expect(payload.payload_updates.payload.planned_tasks[1].title).toBe('Implement signup endpoint');
    });

    it('falls back to single card when LLM throws', async () => {
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

    it('injects contact_agent_name from facilitator when tailor_shop is present', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockParseProtocol.mockReturnValue({
        team: { Linda: 'fs-team-lead', Sola: 'architect' },
        facilitator: 'Linda',
        body: '',
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint.'],
                depends_on: [],
                acceptance: ['POST /login returns 200.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
            ],
          })
        )
      );

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const cardWithTailorShop = {
        ...mockParentCard,
        payload: { ...mockParentCard.payload, tailor_shop: '/workspace/teams/dev' },
      };

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440060';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: cardWithTailorShop,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440060',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockParseProtocol).toHaveBeenCalledWith('/workspace/teams/dev/working_protocol.md', { requireTeam: true });
      expect(mockCreateCard).toHaveBeenCalledTimes(1);
      const createCall = mockCreateCard.mock.calls[0];
      expect(createCall[2].payload.instructions.agent_name).toBe('Linda');
      expect(createCall[2].payload.instructions.notes[0]).toBe(
        'Coordinate the team to implement the Scope of Work described in this card.'
      );

      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.payload_updates.payload.contact_agent_name).toBe('Linda');
    });

    it('falls back to first team member when no facilitator is set', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockParseProtocol.mockReturnValue({
        team: { Sola: 'architect', Paul: 'planner' },
        body: '',
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint.'],
                depends_on: [],
                acceptance: ['POST /login returns 200.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
            ],
          })
        )
      );

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const cardWithTailorShop = {
        ...mockParentCard,
        payload: { ...mockParentCard.payload, tailor_shop: '/workspace/teams/dev' },
      };

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440061';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: cardWithTailorShop,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440061',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      const createCall = mockCreateCard.mock.calls[0];
      expect(createCall[2].payload.instructions.agent_name).toBe('Sola');
    });

    it('preserves existing LLM-assigned agent_name and does not overwrite', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockParseProtocol.mockReturnValue({
        team: { Linda: 'fs-team-lead' },
        facilitator: 'Linda',
        body: '',
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint.'],
                depends_on: [],
                acceptance: ['POST /login returns 200.'],
                instructions: { agent_name: 'Sola', notes: ['Use JWT'] },
                risk: [],
              },
            ],
          })
        )
      );

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const cardWithTailorShop = {
        ...mockParentCard,
        payload: { ...mockParentCard.payload, tailor_shop: '/workspace/teams/dev' },
      };

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440062';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: cardWithTailorShop,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440062',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      const createCall = mockCreateCard.mock.calls[0];
      expect(createCall[2].payload.instructions.agent_name).toBe('Sola');
      expect(createCall[2].payload.instructions.notes).toEqual(['Use JWT']);
    });

    it('gracefully continues when tailor_shop is missing', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            tasks: [
              {
                id: 'T1',
                title: 'Implement login endpoint',
                type: 'implementation',
                body: ['Create the POST /login endpoint.'],
                depends_on: [],
                acceptance: ['POST /login returns 200.'],
                instructions: { agent_name: null, notes: [] },
                risk: [],
              },
            ],
          })
        )
      );

      mockCreateCard.mockReturnValue({
        uid: '550e8400-e29b-41d4-a716-446655440010',
        board_uid: mockTaskBoard.uid,
        display_id: 'TSK-10',
        title: 'Implement login endpoint',
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440063';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: mockParentCard,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440063',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockParseProtocol).not.toHaveBeenCalled();
      const createCall = mockCreateCard.mock.calls[0];
      expect(createCall[2].payload.instructions.agent_name).toBeNull();
    });

    it('stores contact_agent_name in parent payload even for clarification-needed', async () => {
      mockGetBoardById.mockReturnValue(mockDevBoard);
      mockListBoards.mockReturnValue([mockDevBoard, mockTaskBoard]);
      mockParseProtocolFromString.mockReturnValue({
        body: 'Create a full auth system with JWT.',
        instructions: {},
      });
      mockParseProtocol.mockReturnValue({
        team: { Linda: 'fs-team-lead' },
        facilitator: 'Linda',
        body: '',
      });
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValue(
        makeLlmResponse(
          makePlanningV1Response({
            clarification_needed: { required: true, questions: ['What provider?'] },
            tasks: [],
          })
        )
      );

      const cardWithTailorShop = {
        ...mockParentCard,
        payload: { ...mockParentCard.payload, tailor_shop: '/workspace/teams/dev' },
      };

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440064';
      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/planning/on-enter',
        payload: {
          card: cardWithTailorShop,
          board: mockDevBoard,
          column: mockDevBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440064',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockCreateCard).not.toHaveBeenCalled();
      const callbackCall = fetchSpy.mock.calls.find((call) => {
        const url = call[0] as string;
        return typeof url === 'string' && url.includes('/api/callbacks/');
      });
      expect(callbackCall).toBeDefined();
      const init = callbackCall![1] as { body: string };
      const payload = JSON.parse(init.body);
      expect(payload.payload_updates.payload.contact_agent_name).toBe('Linda');
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
