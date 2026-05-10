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
import type {
  OnEnterDispatchRequest,
  OnUpdateRequest,
  OnActionRequest,
  OnExitRequest,
  CanExitHookRequest,
  OnEnterDispatchAcceptedResponse,
  OnUpdateResponse,
  CanExitHookResponse,
} from '@repo/shared';
import { errorResponse } from './error-response.js';
import { fireAndForgetCallback } from './callback.js';

export interface ProcessorHandlerContext {
  fireAndForgetCallback: (url: string, payload: Record<string, unknown>) => void;
  processorId: string;
}

export interface PiProcessorConfig {
  id: string;
  onEnter?: (
    ctx: ProcessorHandlerContext,
    request: OnEnterDispatchRequest,
  ) => Promise<OnEnterDispatchAcceptedResponse>;
  onUpdate?: (
    ctx: ProcessorHandlerContext,
    request: OnUpdateRequest,
  ) => Promise<OnUpdateResponse>;
  onAction?: (
    ctx: ProcessorHandlerContext,
    request: OnActionRequest,
  ) => Promise<OnEnterDispatchAcceptedResponse>;
  onExit?: (
    ctx: ProcessorHandlerContext,
    request: OnExitRequest,
  ) => Promise<{ status: 'acknowledged' }>;
  canExit?: (
    ctx: ProcessorHandlerContext,
    request: CanExitHookRequest,
  ) => Promise<CanExitHookResponse>;
}

export function definePiProcessor(
  config: PiProcessorConfig,
): (instance: FastifyInstance) => Promise<void> {
  return async (instance: FastifyInstance): Promise<void> => {
    const ctx: ProcessorHandlerContext = {
      fireAndForgetCallback: (url, payload) =>
        fireAndForgetCallback(url, payload, config.id),
      processorId: config.id,
    };

    instance.get('/health', async (_request, reply) => {
      const response = HealthCheckResponseSchema.parse({ status: 'healthy' });
      return reply.status(200).send(response);
    });

    instance.post('/can-exit', async (request, reply) => {
      const body = CanExitHookRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send(
            errorResponse('VALIDATION_ERROR', 'Invalid request body', {
              issues: body.error.issues,
            }),
          );
      }
      const response = config.canExit
        ? await config.canExit(ctx, body.data)
        : CanExitHookResponseSchema.parse({ allowed: true });
      return reply.status(200).send(response);
    });

    instance.post('/on-update', async (request, reply) => {
      const body = OnUpdateRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send(
            errorResponse('VALIDATION_ERROR', 'Invalid request body', {
              issues: body.error.issues,
            }),
          );
      }
      const response = config.onUpdate
        ? await config.onUpdate(ctx, body.data)
        : OnUpdateResponseSchema.parse({ allowed: true });
      return reply.status(200).send(response);
    });

    instance.post('/on-enter', async (request, reply) => {
      const body = OnEnterDispatchRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send(
            errorResponse('VALIDATION_ERROR', 'Invalid request body', {
              issues: body.error.issues,
            }),
          );
      }

      if (config.onEnter) {
        const response = await config.onEnter(ctx, body.data);
        return reply.status(202).send(response);
      }

      const response = OnEnterDispatchAcceptedResponseSchema.parse({
        status: 'accepted',
      });
      ctx.fireAndForgetCallback(body.data.callback_url, { status: 'success' });
      return reply.status(202).send(response);
    });

    instance.post('/on-action', async (request, reply) => {
      const body = OnActionRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send(
            errorResponse('VALIDATION_ERROR', 'Invalid request body', {
              issues: body.error.issues,
            }),
          );
      }

      if (config.onAction) {
        const response = await config.onAction(ctx, body.data);
        return reply.status(202).send(response);
      }

      const response = OnEnterDispatchAcceptedResponseSchema.parse({
        status: 'accepted',
      });
      ctx.fireAndForgetCallback(body.data.callback_url, { status: 'success' });
      return reply.status(202).send(response);
    });

    instance.post('/on-exit', async (request, reply) => {
      const body = OnExitRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send(
            errorResponse('VALIDATION_ERROR', 'Invalid request body', {
              issues: body.error.issues,
            }),
          );
      }
      const response = config.onExit
        ? await config.onExit(ctx, body.data)
        : { status: 'acknowledged' as const };
      return reply.status(200).send(response);
    });
  };
}
