import crypto from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { createCallLogger, logger } from '../utils/logger.js';
import type { VapiWebhookEvent } from '../types/vapi.types.js';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

export default async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      try {
        const parsed = JSON.parse((body as Buffer).toString()) as unknown;
        (_req as RequestWithRawBody).rawBody = body as Buffer;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request as RequestWithRawBody).rawBody;

    if (!rawBody) {
      return reply.status(400).send({ error: 'Missing body' });
    }

    // Bearer token verification
    const authHeader = request.headers['authorization'] as string | undefined;
    const expected = `Bearer ${config.VAPI_WEBHOOK_SECRET}`;
    const expBuf = Buffer.from(expected);
    const authBuf = Buffer.from(authHeader ?? '');
    const valid =
      authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
    if (!valid) {
      logger.warn({ ip: request.ip }, 'Invalid webhook auth');
      return reply.status(401).send({
        error: { code: 'INVALID_SIGNATURE', message: 'Unauthorized' },
      });
    }

    const event = request.body as VapiWebhookEvent;
    const type = event?.message?.type;
    const callId = event?.message?.call?.id ?? 'unknown';
    const log = createCallLogger(callId);

    log.info({ type }, 'Vapi webhook received');

    if (type === 'assistant-request') {
      return reply.send({ assistantId: config.VAPI_ASSISTANT_ID });
    }

    if (type === 'transcript') {
      const msg = (event as { message: { role?: string; transcriptType?: string; transcript?: string } }).message;
      if (msg.role === 'user' && msg.transcriptType === 'final') {
        log.info({ utterance: msg.transcript }, 'User utterance (Phase 2 handler pending)');
      }
      return reply.send({});
    }

    if (type === 'status-update') {
      const status = (event as { message: { status?: string } }).message.status;
      log.info({ status }, 'Call status update');
      return reply.send({});
    }

    if (type === 'end-of-call-report') {
      log.info('Call ended');
      return reply.send({});
    }

    return reply.send({});
  });
}
