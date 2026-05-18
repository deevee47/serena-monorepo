import crypto from 'crypto';
import got from 'got';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

function checkAdminSecret(headers: FastifyRequest['headers']): boolean {
  const adminSecret = headers['x-admin-secret'] as string | undefined;
  const expBuf = Buffer.from(config.ADMIN_SECRET);
  const actBuf = Buffer.from(adminSecret ?? '');
  return actBuf.length === expBuf.length && crypto.timingSafeEqual(actBuf, expBuf);
}

const triggerSchema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  product_id: z.string().min(1),
  trigger_reason: z.enum(['cart_abandon', 'page_view', 'wishlist', 'manual']),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export default async function callsRoutes(app: FastifyInstance) {
  app.post('/calls/trigger', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
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
          ...(config.VAPI_PHONE_NUMBER_ID
            ? { phoneNumberId: config.VAPI_PHONE_NUMBER_ID }
            : {}),
          customer: { number: phone_number },
          metadata: { product_id, trigger_reason, ...metadata },
        },
      }).json<{ id: string }>();
      vapiCallId = vapiRes.id;
    } catch (err) {
      // Surface the underlying Vapi error so the curl response is debuggable.
      let vapiBody: unknown = undefined;
      let vapiStatus: number | undefined;
      if (typeof err === 'object' && err !== null && 'response' in err) {
        const resp = (err as { response?: { statusCode?: number; body?: unknown } }).response;
        vapiStatus = resp?.statusCode;
        vapiBody = resp?.body;
      }
      request.log.error({ err, vapi_status: vapiStatus, vapi_body: vapiBody }, 'Vapi call initiation failed');
      throw new AppError(
        502,
        'VAPI_REJECTED',
        `Vapi rejected the call (HTTP ${vapiStatus ?? '?'})`,
        vapiBody,
      );
    }

    await redis.setex(`pending_call:${vapiCallId}`, 60, JSON.stringify({ productId: product_id, triggerReason: trigger_reason }));
    await redis.incr(limitKey);
    await redis.expire(limitKey, 86400);

    return reply.status(202).send({ call_id: vapiCallId });
  });

  app.get('/calls/web-config', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }
    if (!config.VAPI_PUBLIC_KEY) {
      return reply.status(503).send({
        error: { code: 'NOT_CONFIGURED', message: 'VAPI_PUBLIC_KEY env var is not set' },
      });
    }
    return reply.send({
      public_key: config.VAPI_PUBLIC_KEY,
      assistant_id: config.VAPI_ASSISTANT_ID,
    });
  });

  app.get('/calls/:id/recording', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }
    const { id } = request.params as { id: string };

    const row = await prisma.call.findUnique({
      where: { callId: id },
      select: { recordingUrl: true, stereoRecordingUrl: true },
    });
    if (row?.recordingUrl || row?.stereoRecordingUrl) {
      return reply.send({
        recording_url: row.recordingUrl,
        stereo_recording_url: row.stereoRecordingUrl,
      });
    }

    // Fall back to Vapi if the webhook hasn't persisted the URL yet.
    try {
      const vapiCall = await got
        .get(`https://api.vapi.ai/call/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${config.VAPI_API_KEY}` },
        })
        .json<{ recordingUrl?: string | null; stereoRecordingUrl?: string | null }>();
      const recordingUrl = vapiCall.recordingUrl ?? null;
      const stereoRecordingUrl = vapiCall.stereoRecordingUrl ?? null;
      if (recordingUrl || stereoRecordingUrl) {
        await prisma.call
          .update({
            where: { callId: id },
            data: { recordingUrl, stereoRecordingUrl },
          })
          .catch(() => undefined);
      }
      return reply.send({
        recording_url: recordingUrl,
        stereo_recording_url: stereoRecordingUrl,
      });
    } catch (err) {
      let status: number | undefined;
      if (typeof err === 'object' && err !== null && 'response' in err) {
        status = (err as { response?: { statusCode?: number } }).response?.statusCode;
      }
      if (status === 404) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Call not found in Vapi' } });
      }
      request.log.error({ err, callId: id }, 'Vapi recording fetch failed');
      return reply
        .status(502)
        .send({ error: { code: 'VAPI_ERROR', message: 'Failed to fetch recording from Vapi' } });
    }
  });
}
