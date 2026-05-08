import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockAccess,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
  mockExecFilePromise,
  mockComplete,
  mockGetModel,
  mockGetApiKey,
} = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockExecFilePromise: vi.fn(),
  mockComplete: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetApiKey: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  constants: { X_OK: 1, F_OK: 0 },
}));

vi.mock('./exec-helpers.js', () => ({
  execFilePromise: (...args: unknown[]) => mockExecFilePromise(...args),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  complete: (...args: unknown[]) => mockComplete(...args),
  getModel: (...args: unknown[]) => mockGetModel(...args) ?? { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
}));

vi.mock('../lib/ai-auth.js', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
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
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockExecFilePromise.mockReset();
    mockComplete.mockReset();
    mockGetModel.mockReset();
    mockGetApiKey.mockReset();

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.endsWith('/.dossier/sow.md')) {
        return '# Mission\nImplement the feature.';
      }
      if (p.endsWith('/llm_context.md')) {
        return '# Repo Context\n- README.md\n- src/index.ts';
      }
      if (p.endsWith('/README.md')) {
        return '# README\nInfo';
      }
      return '';
    });
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockExecFilePromise.mockResolvedValue({ stdout: '', stderr: '' });
    mockGetModel.mockReturnValue({ provider: 'opencode-go', modelId: 'deepseek-v4-flash' });
    mockGetApiKey.mockResolvedValue('fake-api-key');
    mockComplete.mockResolvedValue({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '{"file":".dossier/sow.md","reasoning":"Mission statement; include first so downstream readers understand the requested work."}\n{"file":"README.md","reasoning":"High-level overview for developers and LLMs."}',
        },
      ],
    } as unknown as Awaited<ReturnType<typeof mockComplete>>);

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
    it('accepts and runs context-generator + LLM target extraction', async () => {
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

      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecFilePromise).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('.bin/context-generator'),
        ['-e', '.agents', '-e', 'tools', '-r', '/tmp/workspaces/TST-1', '-o', expect.stringContaining('llm_context.md')],
        { cwd: '/tmp/workspaces/TST-1', timeout: 60_000 },
      );

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(mockGetModel).toHaveBeenCalledWith('opencode-go', 'deepseek-v4-flash');

      const completeCall = mockComplete.mock.calls[0];
      const completeContext = completeCall?.[1] as { systemPrompt?: string; messages: Array<{ role: string; content: string }> };
      expect(completeContext.systemPrompt).toContain('# Repo Context');
      expect(completeContext.messages).toHaveLength(1);
      expect(completeContext.messages[0].role).toBe('user');
      expect(completeContext.messages[0].content).toContain('# Mission');
      expect(completeContext.messages[0].content).not.toContain('# Repo Context');
      expect(completeContext.messages[0].content).toContain('Output only JSONL');
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/tmp/workspaces/TST-1/.dossier/sow.md',
        expect.stringContaining('Initial task body'),
        'utf8',
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/tmp/workspaces/TST-1/.dossier/llm_extract_target.jsonl',
        expect.stringContaining('{"file":".dossier/sow.md"'),
        'utf8',
      );

      expect(mockExecFilePromise).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('.bin/context-extractor'),
        ['-i', '.dossier/llm_extract_target.jsonl', '-o', 'llm_target.md'],
        { cwd: '/tmp/workspaces/TST-1', timeout: 120_000 },
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
      expect(fetchPayload.payload_updates.payload.body).toContain("Mission-focused extracted context is available in 'llm_target.md'");
      expect(fetchPayload.payload_updates.payload.body).toContain('Initial task body');
      expect(fetchPayload.payload_updates.payload.llm_extract_target_jsonl).toBe('.dossier/llm_extract_target.jsonl');
      expect(fetchPayload.payload_updates.payload.llm_target_md).toBe('llm_target.md');
    });

    it('still generates llm_target when context-generator is missing', async () => {
      mockAccess.mockImplementation(async (path: unknown) => {
        const p = String(path);
        if (p.includes('context-generator')) {
          const err = new Error('ENOENT') as Error & { code: string };
          err.code = 'ENOENT';
          throw err;
        }
        return undefined;
      });

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
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecFilePromise).toHaveBeenCalledTimes(1);
      expect(mockExecFilePromise).toHaveBeenCalledWith(
        expect.stringContaining('.bin/context-extractor'),
        ['-i', '.dossier/llm_extract_target.jsonl', '-o', 'llm_target.md'],
        { cwd: '/tmp/workspaces/TST-1', timeout: 120_000 },
      );

      const fetchCall = fetchSpy.mock.calls[0];
      const fetchPayload = JSON.parse((fetchCall?.[1] as { body?: string })?.body ?? '{}');
      expect(fetchPayload.status).toBe('success');
      expect(fetchPayload.move_to_column).toBe('agentic-team');
      expect(fetchPayload.payload_updates.payload.body).toContain("Mission-focused extracted context is available in 'llm_target.md'");
    });

    it('still moves forward when LLM produces invalid JSONL', async () => {
      mockComplete.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'not-json' }],
      } as unknown as Awaited<ReturnType<typeof mockComplete>>);

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440030';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/explore/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440031',
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecFilePromise).toHaveBeenCalledTimes(1);

      const fetchCall = fetchSpy.mock.calls[0];
      const fetchPayload = JSON.parse((fetchCall?.[1] as { body?: string })?.body ?? '{}');
      expect(fetchPayload.status).toBe('success');
      expect(fetchPayload.move_to_column).toBe('agentic-team');
      expect(fetchPayload.payload_updates.payload.body).toContain('Explore Warnings');
      expect(fetchPayload.payload_updates.payload.explore_warnings).toBeDefined();
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
