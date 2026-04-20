import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'node-gateway',
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable', reason: 'database' });
    }
  });
};

export default healthRoutes;
