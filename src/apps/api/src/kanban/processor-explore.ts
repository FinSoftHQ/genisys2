import type { FastifyInstance } from 'fastify';
import { access, constants } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFilePromise } from './exec-helpers.js';
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
    console.error('[explore] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

async function runExploreWorkflow(
  card: { display_id: string; payload?: Record<string, unknown> },
  callbackUrl: string,
) {
  try {
    const workingDir = typeof card.payload?.working_dir === 'string' ? card.payload.working_dir.trim() : process.cwd();
    const contextGeneratorPath = resolve(process.cwd(), '.bin/context-generator');

    try {
      await access(contextGeneratorPath, constants.X_OK);
      console.log(`[explore] Card ${card.display_id}: running context-generator`);
      await execFilePromise(
        contextGeneratorPath,
        ['-e', '.agents', '-e', 'tools', '-r', workingDir, '-o', join(workingDir, 'llm_context.md')],
        { cwd: workingDir, timeout: 60_000 },
      );
      console.log(`[explore] Card ${card.display_id}: context-generator completed`);
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: string }).code : undefined;
      if (code === 'ENOENT') {
        console.log(`[explore] Card ${card.display_id}: context-generator not found, skipping`);
      } else {
        console.error(`[explore] Card ${card.display_id}: context-generator failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    const existingBody = typeof card.payload?.body === 'string' ? card.payload.body : '';
    const contextNote = '\n\n## Repository Context\n\nThe working repository structure is described in \'llm_context.md\'.';
    const updatedBody = existingBody + contextNote;

    const updatedPayload: Record<string, unknown> = {
      ...card.payload,
      body: updatedBody,
    };

    console.log(`[explore] Card ${card.display_id}: success, moving to agentic-team`);
    fireAndForgetCallback(callbackUrl, {
      status: 'success',
      move_to_column: 'agentic-team',
      payload_updates: {
        payload: updatedPayload,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[explore] Card ${card.display_id}: ${message}`);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: `Explore failed: ${message}`.slice(0, 500),
    });
  }
}

export async function exploreProcessorRoutes(instance: FastifyInstance): Promise<void> {
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

    runExploreWorkflow(body.data.card, body.data.callback_url);

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
