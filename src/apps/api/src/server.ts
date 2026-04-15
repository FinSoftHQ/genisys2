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

if (process.versions.bun && process.env.NODE_ENV === 'production') {
  throw new Error('Production requires Node.js 22. Bun runtime is not supported in Azure Oryx.');
}

const port = Number(process.env.PORT) || 8080;
const host = '0.0.0.0';

const app = fastify({
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

try {
  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${String(port)}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
