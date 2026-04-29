import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
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

const GITHUB_URL_REGEX = /(?:https?:\/\/github\.com\/[^\/\s]+\/[^\/\s]+(?:\.git)?|git@github\.com[^:\s]*:[^\/\s]+\/[^\/\s]+(?:\.git)?)/i;

function extractRepositoryUrl(card: { payload?: Record<string, unknown>; description?: string | null }): string | undefined {
  const fromPayload = card.payload?.repository_url;
  if (typeof fromPayload === 'string' && fromPayload.trim().length > 0) {
    return fromPayload.trim();
  }
  const fromDescription = card.description ?? '';
  const match = fromDescription.match(GITHUB_URL_REGEX);
  if (match) {
    return match[0];
  }
  return undefined;
}

function getWorkspacePath(displayId: string): string {
  const root = process.env.WORKSPACE_ROOT ?? './.workspaces';
  return resolve(root, displayId);
}



async function runPrepWorkflow(
  card: { display_id: string; payload?: Record<string, unknown>; description?: string | null },
  callbackUrl: string,
) {
  try {
    const repositoryUrl = extractRepositoryUrl(card);
    if (!repositoryUrl) {
      fireAndForgetCallback(callbackUrl, {
        status: 'error',
        error_message: 'Prep failed: missing repository_url in payload or description',
      });
      return;
    }

    const workspacePath = getWorkspacePath(card.display_id);
    console.log(`[prep] Card ${card.display_id}: cloning ${repositoryUrl} into ${workspacePath}`);

    // 1. Clone
    await execFilePromise('git', ['clone', repositoryUrl, workspacePath], { timeout: 120_000 });

    // 2. Configure git
    await execFilePromise('git', ['config', 'user.name', 'Teerachai Laothong'], { cwd: workspacePath });
    await execFilePromise('git', ['config', 'user.email', 'teerachai@finsoft2023.com'], { cwd: workspacePath });

    // 3. Create branch
    await execFilePromise('git', ['checkout', '-b', `surii/${card.display_id}`], { cwd: workspacePath });

    // 4. Success callback
    console.log(`[prep] Card ${card.display_id}: success, moving to wip`);
    fireAndForgetCallback(callbackUrl, {
      status: 'success',
      payload_updates: {
        payload: {
          ...card.payload,
          workspace_path: workspacePath,
          repository_url: repositoryUrl,
        },
      },
      move_to_column: 'wip',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[prep] Card ${card.display_id}: ${message}`);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: `Prep failed: ${message}`.slice(0, 500),
    });
  }
}

export async function prepProcessorRoutes(instance: FastifyInstance): Promise<void> {
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

    // Run prep workflow asynchronously and fire-and-forget the callback
    runPrepWorkflow(body.data.card, body.data.callback_url);

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

    return reply.status(200).send({ status: 'acknowledged' });
  });
}
