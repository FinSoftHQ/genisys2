import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    const cmd = args[0] as string;
    const cb = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
    const opts = args.length > 2 && typeof args[args.length - 2] === 'object' && args[args.length - 2] !== null
      ? (args[args.length - 2] as Record<string, unknown>)
      : {};
    mockExecFile(cmd, ...(args.slice(1, args.length - 2) as unknown[]), opts);
    if (cb) cb(null, '', '');
    return {} as any;
  },
}));

import { prepProcessorRoutes } from './processor-prep.js';

const mockBoard = {
  uid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Board',
  prefix: 'TST',
  schema: {
    columns: [
      {
        uid: 'prep',
        title: 'Prep',
        type: 'Processing' as const,
        processor_id: 'prep',
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
  description: 'https://github.com/test-org/test-repo.git',
  version: 1,
  processing_state: 'IDLE' as const,
  is_editable: true,
  payload: {},
  current_status: 'prep',
  created_at: '2026-04-26T08:30:00.000Z',
  updated_at: '2026-04-26T08:30:00.000Z',
};

describe('prep processor routes', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let workspaceRoot: string;
  let originalWorkspaceRoot: string | undefined;

  beforeEach(async () => {
    mockExecFile.mockClear();
    originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
    workspaceRoot = await mkdtemp(join(tmpdir(), 'prep-processor-test-'));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    app = fastify();
    await app.register(prepProcessorRoutes, { prefix: '/api/kanban-processor/prep' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
    if (originalWorkspaceRoot === undefined) {
      delete process.env.WORKSPACE_ROOT;
    } else {
      process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  describe('GET /api/kanban-processor/prep/health', () => {
    it('returns 200 with healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/prep/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(HealthCheckResponseSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('healthy');
    });
  });

  describe('POST /api/kanban-processor/prep/can-exit', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/can-exit',
        payload: {
          card: mockCard,
          target_column: 'agentic-team',
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(CanExitHookResponseSchema.safeParse(body).success).toBe(true);
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/prep/on-update', () => {
    it('returns 200 with allowed: true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-update',
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

  describe('POST /api/kanban-processor/prep/on-enter', () => {
    it('returns 202 accepted and fires success callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
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

    it('fires error callback when repository_url is missing and description has no URL', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440003';
      const cardNoUrl = { ...mockCard, description: null, payload: {} };

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {
          card: cardNoUrl,
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

    it('parses markdown description with repo and team_name and stores parsed fields in payload', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440005';
      const originalCwd = process.cwd();
      const cardWithFrontMatter = {
        ...mockCard,
        description: `---\nteam:\n  alice: Developer\nrepo: https://github.com/org/repo.git\nteam_name: dev\nfacilitator: alice\n---\n\nDo the work.`,
        payload: {},
      };

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {
          card: cardWithFrontMatter,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440006',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const call = fetchSpy.mock.calls.find((c) => (c[0] as string) === callbackUrl);
      expect(call).toBeDefined();
      const requestBody = JSON.parse((call![1] as RequestInit).body as string);
      expect(requestBody.status).toBe('success');
      expect(requestBody.payload_updates.payload.repository_url).toBe('https://github.com/org/repo.git');
      expect(requestBody.payload_updates.payload.repo).toBe('https://github.com/org/repo.git');
      expect(requestBody.payload_updates.payload.team_name).toBe('dev');
      expect(requestBody.payload_updates.payload.tailor_shop).toBe(resolve(originalCwd, '../../..', 'teams', 'dev'));
      expect(requestBody.payload_updates.payload.facilitator).toBe('alice');
      expect(requestBody.payload_updates.payload.body).toBe('Do the work.');
      expect(requestBody.payload_updates.payload.team).toEqual({ alice: 'Developer' });
    });

    it('falls back to regex when repo is missing in front matter but other fields are stored', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440007';
      const originalCwd = process.cwd();
      const cardWithFrontMatterNoRepo = {
        ...mockCard,
        description: `---\nteam:\n  bob: Tester\nteam_name: sample\n---\n\nhttps://github.com/fallback-org/fallback-repo.git\n\nSome instructions.`,
        payload: {},
      };

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {
          card: cardWithFrontMatterNoRepo,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440008',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const call = fetchSpy.mock.calls.find((c) => (c[0] as string) === callbackUrl);
      expect(call).toBeDefined();
      const requestBody = JSON.parse((call![1] as RequestInit).body as string);
      expect(requestBody.status).toBe('success');
      expect(requestBody.payload_updates.payload.repository_url).toBe('https://github.com/fallback-org/fallback-repo.git');
      expect(requestBody.payload_updates.payload.team_name).toBe('sample');
      expect(requestBody.payload_updates.payload.tailor_shop).toBe(resolve(originalCwd, '../../..', 'teams', 'sample'));
      expect(requestBody.payload_updates.payload.team).toEqual({ bob: 'Tester' });
    });

    it('gracefully handles invalid front matter and falls back to regex', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440009';
      const cardWithInvalid = {
        ...mockCard,
        description: '---\ninvalid yaml without closing\nhttps://github.com/org/repo.git',
        payload: {},
      };

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {
          card: cardWithInvalid,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440010',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const call = fetchSpy.mock.calls.find((c) => (c[0] as string) === callbackUrl);
      expect(call).toBeDefined();
      const requestBody = JSON.parse((call![1] as RequestInit).body as string);
      expect(requestBody.status).toBe('success');
      expect(requestBody.payload_updates.payload.repository_url).toBe('https://github.com/org/repo.git');
      expect(requestBody.payload_updates.payload.team_name).toBeUndefined();
    });

    it('runs just bootup and just build-tools when both recipes are available', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440011';
      const cardWithJustfile = { ...mockCard, display_id: 'TST-2' };
      const workspacePath = join(workspaceRoot, cardWithJustfile.display_id);
      const justfilePath = join(workspacePath, 'justfile');
      await mkdir(workspacePath, { recursive: true });
      await writeFile(justfilePath, 'bootup:\n\techo booting\n\nbuild-tools:\n\techo building tools\n');

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {
          card: cardWithJustfile,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440012',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockExecFile).toHaveBeenNthCalledWith(5, 'just', ['--justfile', justfilePath, 'bootup'], expect.objectContaining({ cwd: workspacePath }));
      expect(mockExecFile).toHaveBeenNthCalledWith(6, 'just', ['--justfile', justfilePath, 'build-tools'], expect.objectContaining({ cwd: workspacePath }));
      const call = fetchSpy.mock.calls.find((c) => (c[0] as string) === callbackUrl);
      expect(call).toBeDefined();
      const requestBody = JSON.parse((call![1] as RequestInit).body as string);
      expect(requestBody.status).toBe('success');
    });

    it('skips unavailable just recipes', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440013';
      const cardWithJustfile = { ...mockCard, display_id: 'TST-3' };
      const workspacePath = join(workspaceRoot, cardWithJustfile.display_id);
      const justfilePath = join(workspacePath, 'Justfile');
      await mkdir(workspacePath, { recursive: true });
      await writeFile(justfilePath, 'bootup:\n\techo booting\n');

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {
          card: cardWithJustfile,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440014',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const justCalls = mockExecFile.mock.calls.filter((call) => call[0] === 'just');
      expect(justCalls).toEqual([
        ['just', ['--justfile', justfilePath, 'bootup'], expect.objectContaining({ cwd: workspacePath })],
      ]);
      const call = fetchSpy.mock.calls.find((c) => (c[0] as string) === callbackUrl);
      expect(call).toBeDefined();
      const requestBody = JSON.parse((call![1] as RequestInit).body as string);
      expect(requestBody.status).toBe('success');
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-enter',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /api/kanban-processor/prep/on-action', () => {
    it('returns 202 accepted and fires callback', async () => {
      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440001';
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-action',
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

  describe('POST /api/kanban-processor/prep/on-exit', () => {
    it('returns 200 acknowledged', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/prep/on-exit',
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
