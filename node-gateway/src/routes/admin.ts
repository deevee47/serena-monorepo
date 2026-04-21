import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { prisma } from '../lib/prisma.js';
import { refreshScoringConfig } from '../services/scoring.service.js';

export default async function adminRoutes(app: FastifyInstance) {
  app.post('/admin/scoring-config', {
    config: { rateLimit: false },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminSecret = request.headers['x-admin-secret'];
    if (adminSecret !== config.ADMIN_SECRET) {
      logger.warn({ ip: request.ip }, 'Unauthorized admin request');
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin secret' } });
    }

    const body = request.body as { key?: unknown; value?: unknown };
    if (typeof body.key !== 'string' || !body.key) {
      return reply.status(400).send({ error: { code: 'INVALID_BODY', message: 'key must be a non-empty string' } });
    }
    if (typeof body.value !== 'number' || !Number.isFinite(body.value)) {
      return reply.status(400).send({ error: { code: 'INVALID_BODY', message: 'value must be a finite number' } });
    }

    const { key, value } = body as { key: string; value: number };

    await prisma.scoringConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await refreshScoringConfig();

    logger.info({ key, value }, 'Scoring config updated');
    return reply.send({ ok: true, key, value });
  });
}
