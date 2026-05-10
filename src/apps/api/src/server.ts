import fastify from 'fastify';
import websocket from '@fastify/websocket';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { FastifySerializerCompiler, FastifySchema } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createLogger } from '@repo/logger';
import { agentRoomRoutes } from './agent-rooms/index.js';
import { kanbanRoutes, suiteRoutes, callbackRoutes } from './kanban/routes.js';
import { processorRoutes } from './kanban/processors/context-routes.js';
import { prepProcessorRoutes } from './kanban/processor-prep.js';
import { planningProcessorRoutes } from './kanban/processor-planning.js';
import { wrapProcessorRoutes } from './kanban/processor-wrap.js';
import { commitProcessorRoutes } from './kanban/processor-commit.js';
import { doneProcessorRoutes } from './kanban/processors/done.js';
import { delegatedProcessorRoutes } from './kanban/processor-delegated.js';
import { agenticTeamProcessorRoutes } from './kanban/processor-agentic-team.js';
import { exploreProcessorRoutes } from './kanban/processor-explore.js';
import { devWrapupRoutes } from './dev-wrapup/routes.js';

if (process.versions.bun && process.env.NODE_ENV === 'production') {
  throw new Error('Production requires Node.js 22. Bun runtime is not supported in Azure Oryx.');
}

export async function buildServer() {
  const app = fastify({
    loggerInstance: createLogger({ name: 'api' }),
    bodyLimit: 1 * 1024 * 1024, // 1 MB
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler as FastifySerializerCompiler<FastifySchema>);

  app.addContentTypeParser(
    "text/markdown",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  await app.register(helmet);
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1', 'localhost'],
  });
  await app.register(websocket);

  await app.register(
    async (instance) => {
      instance.get('/health', () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
      }));

      instance.get('/health/ready', () => ({
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'stub',
        },
      }));

      instance.get('/health/live', () => ({
        status: 'alive',
        timestamp: new Date().toISOString(),
      }));

      instance.get(
        '/ws',
        { websocket: true },
        (socket, _req) => {
          socket.on('message', (message: Buffer) => {
            socket.send(`echo: ${message.toString()}`);
          });
        }
      );
    },
    { prefix: '/api' }
  );

  await app.register(agentRoomRoutes, { prefix: '/api/v1/agent-rooms' });
  await app.register(kanbanRoutes, { prefix: '/api/boards' });
  await app.register(suiteRoutes, { prefix: '/api/board-suites' });
  await app.register(processorRoutes, { prefix: '/api/kanban-processor/default' });
  await app.register(processorRoutes, { prefix: '/api/kanban-processor/todo' });
  await app.register(prepProcessorRoutes, { prefix: '/api/kanban-processor/prep' });
  await app.register(planningProcessorRoutes, { prefix: '/api/kanban-processor/planning' });
  await app.register(wrapProcessorRoutes, { prefix: '/api/kanban-processor/wrap' });
  await app.register(commitProcessorRoutes, { prefix: '/api/kanban-processor/commit' });
  await app.register(doneProcessorRoutes, { prefix: '/api/kanban-processor/done' });
  await app.register(delegatedProcessorRoutes, { prefix: '/api/kanban-processor/delegated' });
  await app.register(agenticTeamProcessorRoutes, { prefix: '/api/kanban-processor/agentic-team' });
  await app.register(exploreProcessorRoutes, { prefix: '/api/kanban-processor/explore' });
  await app.register(callbackRoutes, { prefix: '/api/callbacks' });
  await app.register(devWrapupRoutes, { prefix: '/api/v1/dev-wrapup' });

  return app;
}
