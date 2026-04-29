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
import { squadRoutes } from './squads/routes.js';
import { agentRoomRoutes } from './agent-rooms/index.js';
import { proxyRoomRoutes } from './proxy-room/index.js';
import { kanbanRoutes, callbackRoutes } from './kanban/routes.js';
import { processorRoutes } from './kanban/processor-routes.js';
import { prepProcessorRoutes } from './kanban/processor-prep.js';
import { wrapProcessorRoutes } from './kanban/processor-wrap.js';
import { wipProcessorRoutes } from './kanban/processor-wip.js';
import { devWrapupRoutes } from './dev-wrapup/routes.js';

if (process.versions.bun && process.env.NODE_ENV === 'production') {
  throw new Error('Production requires Node.js 22. Bun runtime is not supported in Azure Oryx.');
}

const port = Number(process.env.PORT) || 8080;
const host = '0.0.0.0';

export const app = fastify({
  loggerInstance: createLogger({ name: 'api' }),
}).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler as FastifySerializerCompiler<FastifySchema>);

await app.register(helmet);
await app.register(cors, {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
});
await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
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

await app.register(squadRoutes, { prefix: '/api/v1/squads' });
await app.register(agentRoomRoutes, { prefix: '/api/v1/agent-rooms' });
await app.register(proxyRoomRoutes, { prefix: '/api/v1/proxy-room' });
await app.register(kanbanRoutes, { prefix: '/api/boards' });
await app.register(processorRoutes, { prefix: '/api/kanban-processor/default' });
await app.register(processorRoutes, { prefix: '/api/kanban-processor/todo' });
await app.register(processorRoutes, { prefix: '/api/kanban-processor/done' });
await app.register(prepProcessorRoutes, { prefix: '/api/kanban-processor/prep' });
await app.register(wrapProcessorRoutes, { prefix: '/api/kanban-processor/wrap' });
await app.register(wipProcessorRoutes, { prefix: '/api/kanban-processor/wip' });
await app.register(callbackRoutes, { prefix: '/api/callbacks' });
await app.register(devWrapupRoutes, { prefix: '/api/v1/dev-wrapup' });

process.on('SIGTERM', () => {
  (async () => {
    app.log.info('SIGTERM received, closing server gracefully...');
    await app.close();
    process.exit(0);
  })().catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
});


