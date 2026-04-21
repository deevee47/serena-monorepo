import { buildApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { redis } from './lib/redis.js';

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  redis.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
logger.info({ port: config.PORT }, 'Server started');
