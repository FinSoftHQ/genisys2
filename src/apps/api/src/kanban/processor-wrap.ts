import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
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

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, env: { ...process.env, ...options.env } }, (err, stdout, stderr) => {
      if (err) {
        const stderrMsg = stderr?.trim() ? `\nstderr: ${stderr.trim()}` : '';
        reject(new Error(`${err.message}${stderrMsg}`));
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
  });
}

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
  }).catch(() => {
    // Fire-and-forget: failures are silently ignored.
  });
}

function getDevWrapupBaseUrl(): string {
  return (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
}

async function runWrapWorkflow(
  card: { display_id: string; payload?: Record<string, unknown> },
  callbackUrl: string,
) {
  const workspacePath = card.payload?.workspace_path;
  if (!workspacePath || typeof workspacePath !== 'string') {
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: 'Wrap failed: missing workspace_path in card payload',
    });
    return;
  }

  try {
    // 1. Fetch dev-wrapup metadata
    const devWrapupUrl = `${getDevWrapupBaseUrl()}/api/v1/dev-wrapup`;
    const wrapupResponse = await fetch(devWrapupUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_path: workspacePath }),
    });

    if (!wrapupResponse.ok) {
      const bodyText = await wrapupResponse.text().catch(() => 'unknown');
      throw new Error(`dev-wrapup API returned ${wrapupResponse.status}: ${bodyText}`);
    }

    const wrapupData = await wrapupResponse.json() as {
      commit_message: string;
      pr_title: string;
      pr_body: string;
    };

    if (
      typeof wrapupData.commit_message !== 'string' ||
      typeof wrapupData.pr_title !== 'string' ||
      typeof wrapupData.pr_body !== 'string'
    ) {
      throw new Error('dev-wrapup API returned invalid response shape');
    }

    // 2. Git add, commit, push
    await execFilePromise('git', ['add', '.'], { cwd: workspacePath, timeout: 30_000 });
    await execFilePromise('git', ['commit', '-m', wrapupData.commit_message], { cwd: workspacePath, timeout: 30_000 });
    await execFilePromise('git', ['push', 'origin', `surii/${card.display_id}`], { cwd: workspacePath, timeout: 60_000 });

    // 3. Verify gh auth and create PR
    console.log(`[wrap] Card ${card.display_id}: checking gh auth status`);
    const { stdout: authStatus } = await execFilePromise('gh', ['auth', 'status'], { cwd: workspacePath, timeout: 10_000 });
    console.log(`[wrap] gh auth status:\n${authStatus}`);

    console.log(`[wrap] Card ${card.display_id}: creating PR via gh CLI`);
    await execFilePromise(
      'gh',
      [
        'pr', 'create',
        '--title', wrapupData.pr_title,
        '--body', wrapupData.pr_body,
      ],
      { cwd: workspacePath, timeout: 30_000 },
    );

    // 6. Success callback
    fireAndForgetCallback(callbackUrl, {
      status: 'success',
      move_to_column: 'done',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[wrap] Card ${card.display_id}: ${message}`);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: `Wrap failed: ${message}`.slice(0, 500),
    });
  }
}

export async function wrapProcessorRoutes(instance: FastifyInstance): Promise<void> {
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

    runWrapWorkflow(body.data.card, body.data.callback_url);

    return reply.status(202).send(response);
  });

  instance.post('/on-action', async (request, reply) => {
    const body = OnActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    fireAndForgetCallback(body.data.callback_url, { status: 'success' });

    return reply.status(202).send(response);
  });

  instance.post('/on-exit', async (request, reply) => {
    const body = OnExitRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const workspacePath = body.data.card.payload?.workspace_path;
    if (typeof workspacePath === 'string') {
      rm(workspacePath, { recursive: true, force: true }).then(() => {
        console.log(`[wrap] Cleaned up workspace ${workspacePath}`);
      }).catch((err) => {
        console.error(`[wrap] Failed to clean up workspace ${workspacePath}:`, err instanceof Error ? err.message : String(err));
      });
    }

    return reply.status(200).send({ status: 'acknowledged' });
  });
}
