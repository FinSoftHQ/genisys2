import fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRm = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => mockRm(...args),
}));
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
    const result = mockExecFile(args[0], ...(args.slice(1, args.length - 2) as unknown[]), opts);
    let stdout = '';
    let stderr = '';
    let error: Error | null = null;
    const allArgs = args.slice(1, args.length - 2).flat() as unknown[];
    const cmdArgs = allArgs.filter((a): a is string => typeof a === 'string');
    if (result && typeof result === 'object') {
      if ('error' in result) {
        const r = result as { error: Error | null; stdout?: string; stderr?: string };
        error = r.error;
        stdout = r.stdout ?? '';
        stderr = r.stderr ?? '';
      } else if ('stdout' in result) {
        stdout = (result as { stdout: string }).stdout;
      }
    } else if (cmdArgs.includes('auth') && cmdArgs.includes('status')) {
      stdout = 'github.com\n  ✓ Logged in to github.com\n';
    } else if (cmdArgs.includes('diff') && cmdArgs.includes('--cached') && cmdArgs.includes('--name-only')) {
      stdout = 'src/index.ts\n';
    } else if (cmdArgs.includes('status') && cmdArgs.includes('--porcelain')) {
      stdout = 'src/index.ts\n';
    } else if (cmdArgs.includes('pr') && cmdArgs.includes('view')) {
      error = new Error('no PR found');
    }
    if (cb) cb(error, stdout, stderr);
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
            has_staged_changes: true,
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
    mockRm.mockClear();
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

    it('skips commit when there are no staged changes but still pushes and creates PR', async () => {
      mockExecFile.mockImplementation((file, ...rest) => {
        const args = rest.flat().filter((a): a is string => typeof a === 'string');
        if (file === 'git' && args.includes('diff') && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: '' };
        }
        if (file === 'git' && args.includes('rev-list') && args.includes('--count')) {
          return { stdout: '1' };
        }
        return undefined;
      });

      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes('/api/v1/dev-wrapup')) {
          return new Response(
            JSON.stringify({
              commit_message: 'feat: add feature',
              pr_title: '[TST-1] Add feature',
              pr_body: '## Summary\n\nThis PR adds a feature.',
              has_staged_changes: false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
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

      const commitCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'git' && (call[1] as string[]).includes('commit')
      );
      expect(commitCalls).toHaveLength(0);

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['push', 'origin', 'surii/TST-1']),
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
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('short-circuits to done when workspace is clean and PR exists', async () => {
      mockExecFile.mockImplementation((file, ...rest) => {
        const args = rest.flat().filter((a): a is string => typeof a === 'string');
        if (file === 'git' && args.includes('status') && args.includes('--porcelain')) {
          return { stdout: '' };
        }
        if (file === 'git' && args.includes('show-ref') && args.includes('--verify')) {
          return { stdout: 'refs/heads/surii/TST-1\n' };
        }
        if (file === 'git' && args.includes('rev-list') && args.includes('--count')) {
          return { stdout: '0' };
        }
        if (file === 'gh' && args.includes('pr') && args.includes('view')) {
          return { stdout: 'https://github.com/test-org/test-repo/pull/42\n' };
        }
        return undefined;
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

      // dev-wrapup should NOT be called when short-circuiting
      const devWrapupCalls = fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes('/api/v1/dev-wrapup')
      );
      expect(devWrapupCalls).toHaveLength(0);

      const commitCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'git' && (call[1] as string[]).includes('commit')
      );
      expect(commitCalls).toHaveLength(0);

      const pushCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'git' && (call[1] as string[]).includes('push')
      );
      expect(pushCalls).toHaveLength(0);

      const prCreateCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'gh' && (call[1] as string[]).includes('create')
      );
      expect(prCreateCalls).toHaveLength(0);

      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('runs full flow when workspace is clean but PR does not exist', async () => {
      mockExecFile.mockImplementation((file, ...rest) => {
        const args = rest.flat().filter((a): a is string => typeof a === 'string');
        if (file === 'git' && args.includes('status') && args.includes('--porcelain')) {
          return { stdout: '' };
        }
        if (file === 'git' && args.includes('show-ref') && args.includes('--verify')) {
          return { stdout: 'refs/heads/surii/TST-1\n' };
        }
        if (file === 'git' && args.includes('rev-list') && args.includes('--count')) {
          return { stdout: '0' };
        }
        if (file === 'gh' && args.includes('pr') && args.includes('view')) {
          return { error: new Error('no PR found') };
        }
        return undefined;
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

      // dev-wrapup SHOULD be called because PR does not exist
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/dev-wrapup'),
        expect.objectContaining({ method: 'POST' }),
      );

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['push', 'origin', 'surii/TST-1']),
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
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('skips wrap and moves to Done when no branch was ever created and workspace is clean', async () => {
      mockExecFile.mockImplementation((file: string, ...rest: unknown[]) => {
        const args = (rest.flat() as unknown[]).filter((a): a is string => typeof a === 'string');
        if (file === 'git' && args.includes('status') && args.includes('--porcelain')) {
          return { stdout: '' }; // no working-tree changes
        }
        if (file === 'git' && args.includes('show-ref') && args.includes('--verify')) {
          return { error: new Error('not a valid ref'), stdout: '', stderr: '' }; // branch never created
        }
        if (file === 'git' && args.includes('rev-list')) {
          return { error: new Error('unknown revision'), stdout: '', stderr: '' };
        }
        if (file === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) {
          return { error: new Error('unknown ref'), stdout: '', stderr: '' };
        }
        if (file === 'gh' && args.includes('pr') && args.includes('view')) {
          return { error: new Error('no PR found'), stdout: '', stderr: '' }; // no PR either
        }
        return undefined;
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440011';

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440012',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // dev-wrapup must NOT be called
      const devWrapupCalls = fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes('/api/v1/dev-wrapup')
      );
      expect(devWrapupCalls).toHaveLength(0);

      // No git write operations
      const commitCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'git' && (call[1] as string[]).includes('commit')
      );
      expect(commitCalls).toHaveLength(0);

      const pushCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'git' && (call[1] as string[]).includes('push')
      );
      expect(pushCalls).toHaveLength(0);

      // Should not query PR at all in this branch-missing no-op path
      const prViewCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'gh' && (call[1] as string[]).includes('view')
      );
      expect(prViewCalls).toHaveLength(0);

      // Must succeed, not error
      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('does not query PR when no branch exists and workspace is clean', async () => {
      mockExecFile.mockImplementation((file: string, ...rest: unknown[]) => {
        const args = (rest.flat() as unknown[]).filter((a): a is string => typeof a === 'string');
        if (file === 'git' && args.includes('status') && args.includes('--porcelain')) {
          return { stdout: '' }; // no working-tree changes
        }
        if (file === 'git' && args.includes('show-ref') && args.includes('--verify')) {
          return { error: new Error('not a valid ref'), stdout: '', stderr: '' }; // no local branch
        }
        if (file === 'git' && args.includes('rev-list')) {
          return { error: new Error('unknown revision'), stdout: '', stderr: '' };
        }
        if (file === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) {
          return { error: new Error('unknown ref'), stdout: '', stderr: '' };
        }
        if (file === 'gh' && args.includes('pr') && args.includes('view')) {
          return { stdout: 'https://github.com/test-org/test-repo/pull/42\n' }; // PR exists
        }
        return undefined;
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440013';

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440014',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // dev-wrapup must NOT be called
      const devWrapupCalls = fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes('/api/v1/dev-wrapup')
      );
      expect(devWrapupCalls).toHaveLength(0);

      // No git write operations
      const pushCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'git' && (call[1] as string[]).includes('push')
      );
      expect(pushCalls).toHaveLength(0);

      // Should not query PR in this no-op path, even if gh pr view would succeed
      const prViewCalls = mockExecFile.mock.calls.filter((call) =>
        call[0] === 'gh' && (call[1] as string[]).includes('view')
      );
      expect(prViewCalls).toHaveLength(0);

      // Must succeed
      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"success"'),
        }),
      );
    });

    it('fires success callback when gh pr create fails with benign error', async () => {
      mockExecFile.mockImplementation((file, ...rest) => {
        const args = rest.flat().filter((a): a is string => typeof a === 'string');
        if (file === 'gh' && args.includes('pr') && args.includes('create')) {
          return { error: new Error('stderr: GraphQL: No commits between main and surii/TST-1'), stdout: '', stderr: 'GraphQL: No commits between main and surii/TST-1' };
        }
        if (file === 'git' && args.includes('diff') && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: 'src/index.ts\n' };
        }
        return undefined;
      });

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440007';

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440008',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalledWith(
        callbackUrl,
        expect.objectContaining({
          body: expect.stringContaining('"status":"success"'),
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

      const callbackUrl = 'http://localhost:3000/api/callbacks/550e8400-e29b-41d4-a716-446655440009';

      await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-enter',
        payload: {
          card: mockCard,
          board: mockBoard,
          column: mockBoard.schema.columns[0],
          callback_url: callbackUrl,
          idempotency_key: '550e8400-e29b-41d4-a716-446655440010',
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
    it('returns 202 accepted and re-runs wrap workflow on retry', async () => {
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

      // Should re-run the wrap workflow (dev-wrapup, git, gh)
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/dev-wrapup'),
        expect.objectContaining({ method: 'POST' }),
      );

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['auth', 'status']),
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
  });

  describe('POST /api/kanban-processor/wrap/on-exit', () => {
    it('returns 200 acknowledged and cleans up workspace', async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRm).toHaveBeenCalledWith(
        '/tmp/workspaces/TST-1',
        expect.objectContaining({ recursive: true, force: true }),
      );
    });

    it('returns 200 acknowledged when workspace_path is missing', async () => {
      const cardNoWorkspace = { ...mockCard, payload: {} };
      const response = await app.inject({
        method: 'POST',
        url: '/api/kanban-processor/wrap/on-exit',
        payload: {
          card: cardNoWorkspace,
          next_column: mockBoard.schema.columns[0],
          actor: 'user:test@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('acknowledged');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRm).not.toHaveBeenCalled();
    });
  });
});
