import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import formbody from '@fastify/formbody';
import { logger } from './utils/logger.js';
import { AppError } from './utils/errors.js';
import healthRoutes from './routes/health.js';

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(helmet);
  await app.register(formbody);
  await app.register(healthRoutes);

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
