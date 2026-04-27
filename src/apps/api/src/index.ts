import { app } from './server.js';

const port = Number(process.env.PORT) || 8080;
const host = '0.0.0.0';

try {
  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${String(port)}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
