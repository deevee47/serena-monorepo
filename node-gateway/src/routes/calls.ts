import crypto from 'crypto';
import got from 'got';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

const triggerSchema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  product_id: z.string().min(1),
  trigger_reason: z.enum(['cart_abandon', 'page_view', 'wishlist', 'manual']),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export default async function callsRoutes(app: FastifyInstance) {
  app.post('/calls/trigger', async (request: FastifyRequest, reply: FastifyReply) => {
    const adminSecret = request.headers['x-admin-secret'] as string | undefined;
    const expBuf = Buffer.from(config.ADMIN_SECRET);
    const actBuf = Buffer.from(adminSecret ?? '');
    const valid = actBuf.length === expBuf.length && crypto.timingSafeEqual(actBuf, expBuf);
    if (!valid) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }

    const parsed = triggerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: { code: ErrorCodes.INVALID_PAYLOAD, message: 'Invalid request body', details: parsed.error.flatten() },
      });
    }
    const { phone_number, product_id, trigger_reason, metadata } = parsed.data;

    const today = new Date().toISOString().slice(0, 10);
    const limitKey = `call_limit:${phone_number}:${today}`;
    const callCount = await redis.get(limitKey);
    if (callCount !== null && parseInt(callCount, 10) >= 3) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Call limit reached for this number today' } });
    }

    let vapiCallId: string;
    try {
      const vapiRes = await got.post('https://api.vapi.ai/call/phone', {
        headers: { Authorization: `Bearer ${config.VAPI_API_KEY}` },
        json: {
          assistantId: config.VAPI_ASSISTANT_ID,
          customer: { phoneNumber: phone_number },
          metadata: { product_id, trigger_reason, ...metadata },
        },
      }).json<{ id: string }>();
      vapiCallId = vapiRes.id;
    } catch (err) {
      request.log.error({ err }, 'Vapi call initiation failed');
      throw new AppError(502, ErrorCodes.BRAIN_UNREACHABLE, 'Failed to initiate call via Vapi');
    }

    await redis.setex(`pending_call:${vapiCallId}`, 60, JSON.stringify({ productId: product_id, triggerReason: trigger_reason }));
    await redis.incr(limitKey);
    await redis.expire(limitKey, 86400);

    return reply.status(202).send({ call_id: vapiCallId });
  });
}
