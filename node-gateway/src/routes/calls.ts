import crypto from 'crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { getVoiceProvider, voiceProvider, type ProviderName } from '../services/voice-provider/index.js';
import type { CallLocale } from '../services/voice-provider/types.js';
import { generateOpener, type CallMode } from '../services/opener.service.js';
import { getSession, updateSession } from '../services/session.service.js';

function parseProviderOverride(value: unknown): ProviderName | null {
  return value === 'vapi' || value === 'telnyx' ? value : null;
}

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
  /** Optional dashboard-driven override; falls back to VOICE_PROVIDER env. */
  provider: z.enum(['vapi', 'telnyx']).optional(),
});

const webContextSchema = z.object({
  call_id: z.string().min(1),
  /** Null/omitted for product-agnostic inbound web calls. */
  product_id: z.string().min(1).nullish(),
});

async function resolveLocale(phoneNumber: string): Promise<CallLocale> {
  // Pick voice based on the customer's timezone if we know them — Indian
  // numbers usually answer in Hindi/Hinglish, US in English. Falls back to
  // English when we have no record of the customer.
  const customerRow = await prisma.customer
    .findUnique({ where: { phone: phoneNumber }, select: { timezone: true } })
    .catch(() => null);
  const tz = customerRow?.timezone ?? null;
  return tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta' ? 'hi' : 'en';
}

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
    const { phone_number, product_id, trigger_reason, metadata, provider: providerOverride } =
      parsed.data;

    const today = new Date().toISOString().slice(0, 10);
    const limitKey = `call_limit:${phone_number}:${today}`;
    const callCount = await redis.get(limitKey);
    if (callCount !== null && parseInt(callCount as string, 10) >= 3) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Call limit reached for this number today' } });
    }

    const locale = await resolveLocale(phone_number);

    const provider = providerOverride ? getVoiceProvider(providerOverride) : voiceProvider();

    let callId: string;
    try {
      const result = await provider.createPhoneCall({
        phoneNumber: phone_number,
        productId: product_id,
        triggerReason: trigger_reason,
        locale,
        metadata,
      });
      callId = result.callId;
    } catch (err) {
      // Surface the underlying provider error so the curl response is debuggable.
      let providerBody: unknown = undefined;
      let providerStatus: number | undefined;
      if (typeof err === 'object' && err !== null && 'response' in err) {
        const resp = (err as { response?: { statusCode?: number; body?: unknown } }).response;
        providerStatus = resp?.statusCode;
        providerBody = resp?.body;
      }
      request.log.error(
        { err, provider_status: providerStatus, provider_body: providerBody },
        'Voice provider call initiation failed',
      );
      throw new AppError(
        502,
        'PROVIDER_REJECTED',
        `Voice provider rejected the call (HTTP ${providerStatus ?? '?'})`,
        providerBody,
      );
    }

    await redis.setex(
      `pending_call:${callId}`,
      60,
      JSON.stringify({ productId: product_id, triggerReason: trigger_reason }),
    );
    await redis.incr(limitKey);
    await redis.expire(limitKey, 86400);

    return reply.status(202).send({ call_id: callId });
  });

  app.get('/calls/web-config', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }
    const query = request.query as { provider?: string } | undefined;
    const override = parseProviderOverride(query?.provider);
    const activeProvider = override ? getVoiceProvider(override) : voiceProvider();
    try {
      const cfg = await activeProvider.getWebClientConfig();
      return reply.send({
        provider: cfg.provider,
        mode: cfg.mode,
        token: cfg.token,
        target: cfg.target,
        assistant_id: cfg.assistantId ?? cfg.target,
        // Legacy field names — preserve so older dashboard builds still work
        // for the Vapi path.
        public_key: cfg.token,
      });
    } catch (err) {
      request.log.error({ err }, 'web config unavailable');
      return reply.status(503).send({
        error: { code: 'NOT_CONFIGURED', message: 'Web client config not available' },
      });
    }
  });

  app.post('/calls/opener', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }
    const body = request.body as
      | { mode?: CallMode; product_id?: string | null; language?: string }
      | undefined;
    const mode = body?.mode === 'INBOUND_PRESALES' || body?.mode === 'OUTBOUND_RECOVERY'
      ? body.mode
      : null;
    if (!mode) {
      return reply.status(422).send({
        error: { code: ErrorCodes.INVALID_PAYLOAD, message: 'mode must be INBOUND_PRESALES or OUTBOUND_RECOVERY' },
      });
    }
    const language = body?.language === 'hi' ? 'hi' : 'en';
    const opener = await generateOpener({ mode, productId: body?.product_id ?? null, language });
    return reply.send({ opener });
  });

  // Web-call product binding. A browser Vapi call (the /talk page) is started
  // with a client-side `assistantId` and the selected product only in
  // `vapi.start` overrides — which Vapi does NOT reliably forward to our
  // Custom LLM endpoint (unlike a PSTN call created via POST /call/phone,
  // whose top-level `metadata` round-trips as `call.metadata`). Without this,
  // `ensureSessionForCall` sees no product and defaults to `prod-001`, so the
  // agent opens about the product the caller picked (client-rendered opener)
  // but answers about the default. The dashboard calls this right after
  // `vapi.start` returns the call id; we stash the same `pending_call:<id>`
  // entry `/calls/trigger` writes, which `ensureSessionForCall` reads first.
  app.post('/calls/web-context', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }
    const parsed = webContextSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: { code: ErrorCodes.INVALID_PAYLOAD, message: 'Invalid request body', details: parsed.error.flatten() },
      });
    }
    const { call_id, product_id } = parsed.data;
    if (!product_id) {
      // Inbound web calls start product-agnostic — nothing to bind.
      return reply.status(204).send();
    }

    await redis.setex(
      `pending_call:${call_id}`,
      60,
      JSON.stringify({ productId: product_id, triggerReason: 'web_talk' }),
    );

    // Race guard: the first LLM turn normally lands several seconds after
    // `vapi.start` (opener TTS + the caller's first reply), so the binding
    // above is read at session-create time. But if a session already exists
    // (reconnect, or an unusually fast first turn) the pending_call entry will
    // never be re-read — patch the live session directly so the product still
    // takes effect.
    const existing = await getSession(call_id).catch(() => null);
    if (existing && existing.currentProductId !== product_id) {
      await updateSession(call_id, { currentProductId: product_id }).catch((err) =>
        request.log.warn({ err, call_id }, 'web-context: live session product patch failed'),
      );
    }

    return reply.status(204).send();
  });

  app.get(
    '/calls/by-bridge/:uuid',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!checkAdminSecret(request.headers)) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
      }
      const { uuid } = request.params as { uuid: string };
      const callId = await redis.get(`web_call_bridge:${uuid}`).catch(() => null);
      if (!callId) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'No bridge entry for that uuid (yet?)' },
        });
      }
      return reply.send({ call_id: callId });
    },
  );

  app.get('/calls/:id/recording', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminSecret(request.headers)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid admin secret' } });
    }
    const { id } = request.params as { id: string };

    const row = await prisma.call.findUnique({
      where: { callId: id },
      select: { recordingUrl: true, stereoRecordingUrl: true, providerRecordingId: true },
    });

    // Always fetch fresh from the provider. Telnyx's recording URLs are
    // presigned S3 links with a ~10min expiry, so caching the URL in
    // `Call.recordingUrl` would hand the player a stale link the second
    // time the page is opened. We DO cache `providerRecordingId` (a stable
    // UUID) so subsequent lookups skip the list-filter step and hit the
    // singular endpoint instead.
    const lookupId = row?.providerRecordingId ?? id;
    try {
      const recording = await voiceProvider().getCall(lookupId);
      // Persist the recording_id when we discover one — turns a v3:...
      // call_control_id lookup into a UUID lookup on the next request.
      if (recording.recordingId && recording.recordingId !== row?.providerRecordingId) {
        await prisma.call
          .update({
            where: { callId: id },
            data: { providerRecordingId: recording.recordingId },
          })
          .catch(() => undefined);
      }
      return reply.send({
        recording_url: recording.recordingUrl,
        stereo_recording_url: recording.stereoRecordingUrl,
        // ISO timestamp the provider began recording (Telnyx: `recording_started_at`).
        // The dashboard scrubber uses this as the timeline anchor so turn
        // positions match the audio file instead of our late-bound
        // `Call.createdAt`. Null when the provider doesn't expose it.
        recording_started_at: recording.recordingStartedAt ?? null,
      });
    } catch (err) {
      let status: number | undefined;
      if (typeof err === 'object' && err !== null && 'response' in err) {
        status = (err as { response?: { statusCode?: number } }).response?.statusCode;
      }
      if (status === 404) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Call not found at provider' } });
      }
      request.log.error({ err, callId: id }, 'provider recording fetch failed');
      return reply
        .status(502)
        .send({ error: { code: 'PROVIDER_ERROR', message: 'Failed to fetch recording from provider' } });
    }
  });
}
