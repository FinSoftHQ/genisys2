import type { FastifyInstance } from 'fastify';
import {
  OnEnterDispatchRequestSchema,
  OnUpdateRequestSchema,
  OnUpdateResponseSchema,
  OnActionRequestSchema,
  OnExitRequestSchema,
  CanExitHookRequestSchema,
  CanExitHookResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  HealthCheckResponseSchema,
} from '@repo/shared';
import { execFilePromise } from './exec-helpers.js';

function errorResponse(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function fireAndForgetCallback(callbackUrl: string, payload: Record<string, unknown>) {
  fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer processor',
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('[commit] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

function getDevWrapupBaseUrl(): string {
  return (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
}

function sendDone(callbackUrl: string, displayId: string): void {
  console.log(`[commit] Card ${displayId}: success, moving to done`);
  fireAndForgetCallback(callbackUrl, { status: 'success', move_to_column: 'done' });
}

function sendError(callbackUrl: string, displayId: string, message: string): void {
  console.error(`[commit] Card ${displayId}: ${message}`);
  fireAndForgetCallback(callbackUrl, { status: 'error', error_message: message.slice(0, 500) });
}

async function fetchDevWrapupCommit(workspacePath: string) {
  const url = `${getDevWrapupBaseUrl()}/api/v1/dev-wrapup`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_path: workspacePath, include: 'commit' }),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => 'unknown');
    throw new Error(`dev-wrapup API returned ${response.status}: ${bodyText}`);
  }
  const data = await response.json() as {
    commit_message?: string;
  };
  if (typeof data.commit_message !== 'string') {
    throw new Error('dev-wrapup API returned invalid response shape: missing commit_message');
  }
  return data.commit_message;
}

async function runCommitWorkflow(
  card: { display_id: string; payload?: Record<string, unknown> },
  callbackUrl: string,
) {
  const workspacePath = card.payload?.workspace_path;
  if (!workspacePath || typeof workspacePath !== 'string') {
    return sendError(callbackUrl, card.display_id, 'Commit failed: missing workspace_path in card payload');
  }

  try {
    // Phase 1: Stage all changes
    console.log(`[commit] Card ${card.display_id}: staging changes with git add -A`);
    await execFilePromise('git', ['add', '-A'], { cwd: workspacePath, timeout: 30_000 });

    // Phase 2: Check if anything was staged
    const { stdout: stagedStdout } = await execFilePromise(
      'git',
      ['diff', '--cached', '--name-only'],
      { cwd: workspacePath, timeout: 10_000 },
    );
    const stagedFiles = stagedStdout.trim().split('\n').filter(Boolean);
    if (stagedFiles.length === 0) {
      console.warn(`[commit] Card ${card.display_id}: no changes to stage, skipping commit`);
      return sendDone(callbackUrl, card.display_id);
    }

    console.log(
      `[commit] Card ${card.display_id}: ${stagedFiles.length} file(s) staged, proceeding with commit`,
    );

    // Phase 3: Generate commit message
    const commitMessage = await fetchDevWrapupCommit(workspacePath);
    console.log(`[commit] Card ${card.display_id}: generated commit message: ${commitMessage}`);

    // Phase 4: Commit
    await execFilePromise('git', ['commit', '-m', commitMessage], {
      cwd: workspacePath,
      timeout: 30_000,
    });
    console.log(`[commit] Card ${card.display_id}: committed successfully`);

    return sendDone(callbackUrl, card.display_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(callbackUrl, card.display_id, `Commit failed: ${message}`);
  }
}

export async function commitProcessorRoutes(instance: FastifyInstance): Promise<void> {
  instance.get('/health', async (_request, reply) => {
    const response = HealthCheckResponseSchema.parse({ status: 'healthy' });
    return reply.status(200).send(response);
  });

  instance.post('/can-exit', async (request, reply) => {
    const body = CanExitHookRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = CanExitHookResponseSchema.parse({ allowed: true });
    return reply.status(200).send(response);
  });

  instance.post('/on-update', async (request, reply) => {
    const body = OnUpdateRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnUpdateResponseSchema.parse({ allowed: true });
    return reply.status(200).send(response);
  });

  instance.post('/on-enter', async (request, reply) => {
    const body = OnEnterDispatchRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    runCommitWorkflow(body.data.card, body.data.callback_url);

    return reply.status(202).send(response);
  });

  instance.post('/on-action', async (request, reply) => {
    const body = OnActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    runCommitWorkflow(body.data.card, body.data.callback_url);

    return reply.status(202).send(response);
  });

  instance.post('/on-exit', async (request, reply) => {
    const body = OnExitRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    return reply.status(200).send({ status: 'acknowledged' });
  });
}
