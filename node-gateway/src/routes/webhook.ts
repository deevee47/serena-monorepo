import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { createCallLogger, logger } from '../utils/logger.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { ensureSessionForCall, getSession, endSession } from '../services/session.service.js';
import { callEndQueue, analyticsQueue, crmQueue } from '../queues/index.js';
import { detectWebhookProvider, getVoiceProvider } from '../services/voice-provider/index.js';
import { parseTexmlStatusCallback } from '../services/voice-provider/telnyx-provider.js';
import type { NormalizedVoiceEvent } from '../services/voice-provider/types.js';
import type { TelnyxTexmlStatusPayload } from '../types/telnyx.types.js';

/** TTL for the bridge entry — long enough for the dashboard to poll a few
 *  times after WebRTC connect, short enough not to leak. */
const WEB_BRIDGE_TTL_SECONDS = 300;

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

async function handleCallStarted(
  event: Extract<NormalizedVoiceEvent, { kind: 'call.started' }>,
): Promise<void> {
  const metadataProductId =
    typeof event.metadata['product_id'] === 'string'
      ? (event.metadata['product_id'] as string)
      : null;
  await ensureSessionForCall({
    callId: event.callId,
    phoneNumber: event.phoneNumber ?? 'unknown',
    metadataProductId,
  });

  // Web calls embed a bridgeUuid (client-generated) in client_state so the
  // dashboard can resolve the canonical callId post-connect. Skip for PSTN.
  const bridgeUuid = event.metadata['bridgeUuid'];
  if (typeof bridgeUuid === 'string' && bridgeUuid.length > 0) {
    await redis
      .setex(`web_call_bridge:${bridgeUuid}`, WEB_BRIDGE_TTL_SECONDS, event.callId)
      .catch((err) =>
        logger.warn({ err, bridgeUuid }, 'web_call_bridge write failed (non-fatal)'),
      );
  }
}

async function handleCallEnded(
  event: Extract<NormalizedVoiceEvent, { kind: 'call.ended' }>,
): Promise<void> {
  const log = createCallLogger(event.callId);
  const session = await getSession(event.callId);
  if (!session) {
    log.warn('call.ended: session not found');
    return;
  }

  // Outcome under the converse pipeline: CONVERTED iff the LLM ever fired
  // the checkout tool during the call. Anything else is DROPPED.
  const checkoutTurn = await prisma.callTurn.findFirst({
    where: { callId: event.callId, toolCalled: 'send_whatsapp_checkout_link' },
    select: { id: true },
  });
  const outcome: 'CONVERTED' | 'DROPPED' = checkoutTurn ? 'CONVERTED' : 'DROPPED';

  await endSession(event.callId);

  const discountGiven =
    session.discountsOffered.length > 0 ? Math.max(...session.discountsOffered) : 0;

  await callEndQueue.add('call-end', {
    callId: event.callId,
    outcome,
    finalScore: 0, // deprecated under converse pipeline
    discountGiven,
    stageReached: outcome === 'CONVERTED' ? 'CONVERTED' : 'DROPPED',
    turnCount: session.turnCount,
    phoneNumber: session.phoneNumber,
    productId: session.currentProductId,
    durationSeconds: event.durationSeconds ?? undefined,
  });

  await analyticsQueue.add('analytics', {
    callId: event.callId,
    outcome,
    finalScore: 0,
    discountGiven,
    stageReached: outcome,
    turnCount: session.turnCount,
  });

  await crmQueue.add('crm-update', {
    callId: event.callId,
    phoneNumber: session.phoneNumber,
    outcome,
    discount: discountGiven,
    productId: session.currentProductId,
  });

  log.info({ outcome, discountGiven, turnCount: session.turnCount }, 'Call ended');
}

async function handleRecordingReady(
  event: Extract<NormalizedVoiceEvent, { kind: 'recording.ready' }>,
): Promise<void> {
  const log = createCallLogger(event.callId);
  if (!event.recordingUrl && !event.stereoRecordingUrl && !event.recordingId) {
    return;
  }
  await prisma.call
    .update({
      where: { callId: event.callId },
      data: {
        recordingUrl: event.recordingUrl,
        stereoRecordingUrl: event.stereoRecordingUrl,
        providerRecordingId: event.recordingId,
      },
    })
    .catch((err) => log.error({ err }, 'Failed to persist recording URLs'));
}

export default async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      const parsed = JSON.parse((body as Buffer).toString()) as unknown;
      (_req as RequestWithRawBody).rawBody = body as Buffer;
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post(
    '/webhook',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 10_000,
          hook: 'preHandler',
          keyGenerator: (req: FastifyRequest) => {
            const body = req.body as { message?: { call?: { id?: string } } } | undefined;
            return body?.message?.call?.id ?? req.ip;
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = (request as RequestWithRawBody).rawBody;
      if (!rawBody) {
        return reply.status(400).send({ error: 'Missing body' });
      }

      // Auto-detect which provider this webhook is from by inspecting the
      // request headers. Both providers can hit the same /webhook URL —
      // Telnyx carries `telnyx-signature-ed25519`, Vapi carries Bearer.
      const providerName = detectWebhookProvider(request.headers);
      const provider = getVoiceProvider(providerName);

      // Dev-only: dump headers + body when we're in insecure mode, so we can
      // see what Telnyx actually sends and tighten the verifier.
      if (config.TELNYX_INSECURE_DEV === '1' && provider.name === 'telnyx') {
        logger.warn(
          {
            headers: request.headers,
            body_preview: rawBody.toString('utf8').slice(0, 2000),
          },
          'TELNYX_INSECURE_DEV: incoming webhook',
        );
      }

      const verification = provider.verifyWebhook(rawBody, request.headers);
      if (!verification.ok) {
        logger.warn(
          {
            ip: request.ip,
            reason: verification.reason,
            // Echo the keys (not values) so we can spot signature-header
            // naming mismatches without leaking sensitive data.
            header_keys: Object.keys(request.headers),
          },
          'Invalid webhook auth',
        );
        return reply
          .status(401)
          .send({ error: { code: 'INVALID_SIGNATURE', message: 'Unauthorized' } });
      }

      const events = provider.parseWebhook(rawBody, request.body);
      if (events.length === 0) {
        return reply.send({});
      }

      // Synchronous Vapi-only flow: if any event carries an assistantId to
      // echo back, send it now and skip the rest (Vapi's assistant-request
      // is a synchronous RPC and processing continues via Custom LLM).
      const initEvent = events.find(
        (e): e is Extract<NormalizedVoiceEvent, { kind: 'call.started' }> =>
          e.kind === 'call.started' && Boolean(e.respondWithAssistantId),
      );
      if (initEvent) {
        await handleCallStarted(initEvent);
        return reply.send({ assistantId: initEvent.respondWithAssistantId });
      }

      for (const event of events) {
        const log = createCallLogger(event.callId);
        log.info({ kind: event.kind, provider: provider.name }, 'webhook event');
        try {
          switch (event.kind) {
            case 'call.started':
              await handleCallStarted(event);
              break;
            case 'call.ended':
              await handleCallEnded(event);
              break;
            case 'recording.ready':
              await handleRecordingReady(event);
              break;
          }
        } catch (err) {
          log.error({ err, kind: event.kind }, 'webhook handler failed');
        }
      }

      return reply.send({});
    },
  );

  // Telnyx TeXML status callbacks: application/x-www-form-urlencoded, NOT the
  // JSON Voice API envelope handled by /webhook. The TeXML application's
  // `status_callback` field points here. Body is auto-decoded by @fastify/formbody.
  // No Ed25519 signature — TeXML uses Twilio-style HMAC on a different header
  // path; we skip verification here while wiring it up and rely on the
  // ngrok-only routing in dev.
  app.post('/webhook/telnyx', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<TelnyxTexmlStatusPayload> | undefined;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Missing form body' });
    }

    const events = parseTexmlStatusCallback(body);
    if (events.length === 0) {
      // Non-actionable status (ringing/answered/in-progress/analyzed) — ack
      // quickly so Telnyx doesn't retry.
      return reply.send({});
    }

    for (const event of events) {
      const log = createCallLogger(event.callId);
      log.info(
        { kind: event.kind, provider: 'telnyx', call_status: body.CallStatus },
        'TeXML status webhook',
      );
      try {
        switch (event.kind) {
          case 'call.started':
            await handleCallStarted(event);
            break;
          case 'call.ended':
            await handleCallEnded(event);
            break;
          case 'recording.ready':
            await handleRecordingReady(event);
            break;
        }
      } catch (err) {
        log.error({ err, kind: event.kind }, 'TeXML webhook handler failed');
      }
    }

    return reply.send({});
  });

  // Debug endpoint — dev only
  if (config.NODE_ENV === 'development') {
    app.get('/debug/session/:callId', async (request: FastifyRequest, reply: FastifyReply) => {
      const { callId } = request.params as { callId: string };
      const session = await getSession(callId);
      return reply.send(session ?? { error: 'Session not found' });
    });
  }
}
