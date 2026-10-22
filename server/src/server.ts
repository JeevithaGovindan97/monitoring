import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db.js';
import { logger } from './logger.js';

const c = config();
const app = createApp();
const server = app.listen(c.PORT, () => logger.info({ port: c.PORT, env: c.NODE_ENV }, 'API listening'));
server.keepAliveTimeout = 65_000;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  const t = setTimeout(() => process.exit(1), 15_000);
  server.close(async () => {
    await closePool().catch(() => undefined);
    clearTimeout(t);
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
