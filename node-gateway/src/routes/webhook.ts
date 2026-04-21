import crypto from 'crypto';
import got from 'got';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { createCallLogger, logger } from '../utils/logger.js';
import type { VapiWebhookEvent } from '../types/vapi.types.js';
import { redis } from '../lib/redis.js';
import {
  createSession,
  getSession,
  getSessionOrThrow,
  updateSession,
  appendTurn,
  getRecentHistory,
  endSession,
  deleteSession,
} from '../services/session.service.js';
import {
  classifyObjection,
  generateResponse,
  FALLBACK_RESPONSES,
  type BrainConversationTurn,
} from '../services/brain.service.js';
import { calculateScoreAfterTurn } from '../services/scoring.service.js';
import { getNextStage } from '../services/stage.service.js';
import {
  shouldOfferDiscount,
  getAvailableDiscount,
  recordDiscountOffered,
  detectFollowUpRequest,
} from '../services/negotiation.service.js';
import { getProductById, toProductContext } from '../services/product.service.js';
import { createCallRecord, updateCallRecord, insertCallTurn } from '../services/db.service.js';
import { ConversationStage, ObjectionType } from '../types/session.types.js';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

// Per-call concurrency lock — chains processTranscript without blocking the HTTP response
const callLocks = new Map<string, Promise<void>>();

async function processTranscript(callId: string, utterance: string): Promise<void> {
  const log = createCallLogger(callId);

  let session;
  try {
    session = await getSessionOrThrow(callId);
  } catch {
    log.warn('processTranscript: session not found, skipping');
    return;
  }

  // Classify utterance
  let classify: { objection_type: (typeof ObjectionType)[keyof typeof ObjectionType]; sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; confidence: number };
  try {
    classify = await classifyObjection({
      call_id: callId,
      utterance,
      stage: session.stage,
      score: session.score,
    });
  } catch (err) {
    log.error({ err }, 'classifyObjection threw — using neutral fallback');
    classify = { objection_type: ObjectionType.NEUTRAL, sentiment: 'NEUTRAL', confidence: 0 };
  }

  const newScore = calculateScoreAfterTurn(session, classify.objection_type, classify.sentiment);

  const updatedObjections = [...session.objectionsEncountered, classify.objection_type];

  await updateSession(callId, { score: newScore, objectionsEncountered: updatedObjections });
  const currentSession = await getSessionOrThrow(callId);

  const nextStage = getNextStage(currentSession);

  const stageUpdates: Parameters<typeof updateSession>[1] = { stage: nextStage };
  if (nextStage === ConversationStage.CLOSE && !session.closeAttempted) {
    stageUpdates.closeAttempted = true;
  }

  let discountAmount = 0;
  const decisionSession = { ...currentSession, stage: nextStage };
  if (shouldOfferDiscount(decisionSession)) {
    discountAmount = getAvailableDiscount(decisionSession);
    Object.assign(stageUpdates, recordDiscountOffered(decisionSession, discountAmount));
  }

  if (detectFollowUpRequest(utterance)) {
    stageUpdates.followUpRequested = true;
    log.info({ utterance }, 'Follow-up requested — BullMQ job stub (Phase 4)');
  }

  const product = getProductById(currentSession.currentProductId);
  const productContext = product ? toProductContext(product) : null;

  const rawHistory = await getRecentHistory(callId, 4);
  const history: BrainConversationTurn[] = rawHistory.map((t) => ({
    speaker: t.speaker,
    utterance: t.utterance,
    timestamp: t.timestamp.toISOString(),
  }));

  let generatedText: string;
  try {
    const generated = await generateResponse({
      call_id: callId,
      utterance,
      stage: nextStage,
      score: newScore,
      discount_available: discountAmount,
      objection_type: classify.objection_type,
      conversation_history: history,
      product_context: productContext,
    });
    generatedText = generated.text;
  } catch (err) {
    log.error({ err }, 'generateResponse threw — using fallback text');
    generatedText = FALLBACK_RESPONSES[nextStage] ?? 'Give me just a moment.';
  }

  await updateSession(callId, stageUpdates);

  const now = new Date();
  await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now, objectionType: classify.objection_type });
  await appendTurn(callId, { speaker: 'AGENT', utterance: generatedText, timestamp: new Date() });

  // Inject response text into the live Vapi call (fire-and-forget)
  // Using /say to trigger TTS speech. Fallback attempt with /message if /say doesn't exist.
  got
    .post(`https://api.vapi.ai/call/${callId}/say`, {
      headers: { Authorization: `Bearer ${config.VAPI_API_KEY}` },
      json: { message: generatedText },
    })
    .catch((err) => log.error({ err }, 'Vapi say failed'));

  // Non-blocking DB writes
  const turnBase = { scoreBefore: session.score, scoreAfter: newScore, stage: nextStage };
  insertCallTurn(callId, {
    turnNumber: session.turnCount + 1,
    speaker: 'USER',
    utterance,
    objectionType: classify.objection_type,
    sentiment: classify.sentiment,
    discountOffered: discountAmount || undefined,
    ...turnBase,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (user)'));
  insertCallTurn(callId, {
    turnNumber: session.turnCount + 2,
    speaker: 'AGENT',
    utterance: generatedText,
    ...turnBase,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));

  log.info(
    { stage: nextStage, score: newScore, objection: classify.objection_type, discount: discountAmount || undefined },
    'Turn processed',
  );
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

    const authHeader = request.headers['authorization'] as string | undefined;
    const expected = `Bearer ${config.VAPI_WEBHOOK_SECRET}`;
    const expBuf = Buffer.from(expected);
    const authBuf = Buffer.from(authHeader ?? '');
    const valid = authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
    if (!valid) {
      logger.warn({ ip: request.ip }, 'Invalid webhook auth');
      return reply.status(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Unauthorized' } });
    }

    const event = request.body as VapiWebhookEvent;
    const type = event?.message?.type;
    const callId = event?.message?.call?.id ?? 'unknown';
    const log = createCallLogger(callId);

    log.info({ type }, 'Vapi webhook received');

    // ── assistant-request ──────────────────────────────────────────────────
    if (type === 'assistant-request') {
      let productId = (event.message.call.metadata?.['product_id'] as string | undefined) ?? 'prod-001';
      try {
        const raw = await redis.get(`pending_call:${callId}`);
        if (raw) {
          const pending = JSON.parse(raw) as { productId: string; triggerReason: string };
          productId = pending.productId;
        } else if (!event.message.call.metadata?.['product_id']) {
          log.warn('No pending_call found in Redis — using default product');
        }
      } catch (err) {
        log.error({ err }, 'Redis get pending_call failed — using request metadata or default product');
      }

      const phoneNumber = (event.message.call as { customer?: { number?: string } }).customer?.number ?? 'unknown';
      const session = await createSession({ callId, phoneNumber, productId });

      createCallRecord(session).catch((err) => log.error({ err }, 'createCallRecord failed'));

      return reply.send({ assistantId: config.VAPI_ASSISTANT_ID });
    }

    // ── transcript ────────────────────────────────────────────────────────
    if (type === 'transcript') {
      const msg = event.message as { role?: string; transcriptType?: string; transcript?: string };
      if (msg.role === 'user' && msg.transcriptType === 'final' && msg.transcript) {
        const utterance = msg.transcript;
        const existing = callLocks.get(callId) ?? Promise.resolve();
        const next = existing.then(() => processTranscript(callId, utterance));
        callLocks.set(callId, next.catch(() => {}));
      }
      return reply.send({});
    }

    // ── status-update ─────────────────────────────────────────────────────
    if (type === 'status-update') {
      const status = (event.message as { status?: string }).status;
      log.info({ status }, 'Call status update');
      return reply.send({});
    }

    // ── end-of-call-report ────────────────────────────────────────────────
    if (type === 'end-of-call-report') {
      const session = await getSession(callId);
      if (!session) {
        log.warn('end-of-call-report: session not found');
        return reply.send({});
      }

      const outcome: 'CONVERTED' | 'DROPPED' =
        session.stage === ConversationStage.CLOSE && session.score >= 60 ? 'CONVERTED' : 'DROPPED';

      const report = event.message as { durationSeconds?: number };
      await endSession(callId);

      updateCallRecord(callId, {
        endedAt: new Date(),
        outcome,
        finalScore: session.score,
        discountGiven: session.discountsOffered.length > 0 ? Math.max(...session.discountsOffered) : 0,
        stageReached: session.stage,
        durationSeconds: report.durationSeconds,
      }).catch((err) => log.error({ err }, 'updateCallRecord failed'));

      await deleteSession(callId);
      callLocks.delete(callId);

      log.info({ outcome, finalScore: session.score }, 'Call ended');
      return reply.send({});
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
