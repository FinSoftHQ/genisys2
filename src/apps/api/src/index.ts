import { buildServer } from './server.js';
import { openDb, closeDb } from './kanban/db-context.js';
import { openIndexDb, closeIndexDb } from '@repo/agent-rooms-core';

const port = Number(process.env.PORT) || 8080;
const host = '0.0.0.0';

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let shuttingDown = false;

async function performShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;

  if (!app) {
    process.exit(0);
    return;
  }

  app.log.info(`${signal} received, closing server gracefully...`);
  try {
    await app.close();
    closeIndexDb();
    closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void performShutdown('SIGTERM'); });
process.on('SIGINT', () => { void performShutdown('SIGINT'); });
process.on('SIGHUP', () => { void performShutdown('SIGHUP'); });
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  void performShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  void performShutdown('unhandledRejection');
});

try {
  const dbPath = process.env.KANBAN_DB_PATH ?? ':memory:';
  openDb(dbPath);
  openIndexDb();
  app = await buildServer();
  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${String(port)}`);
} catch (err) {
  if (app) app.log.error(err);
  else console.error(err);
  process.exit(1);
}
