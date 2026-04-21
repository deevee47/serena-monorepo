import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { logger } from './utils/logger.js';
import { AppError } from './utils/errors.js';
import { redis } from './lib/redis.js';
import { BunRedisStore } from './lib/rate-limit-store.js';
import healthRoutes from './routes/health.js';
import webhookRoutes from './routes/webhook.js';
import callsRoutes from './routes/calls.js';
import vapiLlmRoutes from './routes/vapi-llm.js';

export async function buildApp() {
  // Verify Redis is reachable before accepting traffic
  try {
    await redis.ping();
  } catch (err) {
    logger.error({ err }, 'Redis is unavailable — cannot start');
    process.exit(1);
  }

  const app = Fastify({ loggerInstance: logger });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(formbody);
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: 60_000,
    store: BunRedisStore,
    skipOnError: true,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Try again in ${context.after}.`,
      },
    }),
  });
  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(callsRoutes);
  await app.register(vapiLlmRoutes);

  app.setErrorHandler((error, request, reply) => {
    const callId = (request.headers['x-call-id'] as string | undefined) ?? 'unknown';
    request.log.error({ call_id: callId, err: error }, 'Request error');

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    const statusCode = error instanceof Error && 'statusCode' in error
      ? (error as { statusCode?: number }).statusCode ?? 500
      : 500;
    const message =
      process.env['NODE_ENV'] === 'production'
        ? 'Internal server error'
        : error instanceof Error
          ? error.message
          : 'Internal server error';

    return reply.status(statusCode).send({
      error: { code: 'INTERNAL_ERROR', message },
    });
  });

  return app;
}
