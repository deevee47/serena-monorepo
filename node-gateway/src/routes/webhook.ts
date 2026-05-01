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
} from '../services/session.service.js';
import {
  classifyObjection,
  generateResponseStream,
  decide as decideTactic,
  generateTacticStream,
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
import {
  findAlternativeProduct,
  getProductById,
  toProductContext,
} from '../services/product.service.js';
import { createCallRecord, insertCallTurn } from '../services/db.service.js';
import { callEndQueue, analyticsQueue, crmQueue } from '../queues/index.js';
import { ConversationStage, ObjectionType } from '../types/session.types.js';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

import { buildDecideRequest } from '../services/decide-request.builder.js';
import {
  sendCheckoutLinkOnWhatsApp,
  sendProductInfoOnWhatsApp,
} from '../services/whatsapp.service.js';

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
  let classify: { objection_type: (typeof ObjectionType)[keyof typeof ObjectionType]; sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; confidence: number; subtype?: string | null };
  try {
    classify = await classifyObjection({
      call_id: callId,
      utterance,
      stage: session.stage,
      score: session.score,
    });
  } catch (err) {
    log.error({ err }, 'classifyObjection threw — using neutral fallback');
    classify = { objection_type: ObjectionType.NEUTRAL, sentiment: 'NEUTRAL', confidence: 0, subtype: null };
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

  // Pre-compute the would-be discount amount for the legacy /generate path.
  // Under the tactic pipeline, this is replaced below — only granted when
  // the chosen tactic actually uses a discount, so the LLM can't hallucinate
  // a price cut on tactics like REFRAME or ISOLATE.
  let discountAmount = 0;
  const decisionSession = { ...currentSession, stage: nextStage };
  if (!config.USE_TACTIC_PIPELINE && shouldOfferDiscount(decisionSession)) {
    discountAmount = getAvailableDiscount(decisionSession);
    Object.assign(stageUpdates, recordDiscountOffered(decisionSession, discountAmount));
  }

  if (detectFollowUpRequest(utterance)) {
    stageUpdates.followUpRequested = true;
    log.info({ utterance }, 'Follow-up requested — BullMQ job stub (Phase 4)');
  }

  const product = getProductById(currentSession.currentProductId);
  const productContext = product ? toProductContext(product) : null;
  let alternativeProductContext = null;
  if (classify.objection_type === ObjectionType.PRICE && product) {
    try {
      alternativeProductContext = await findAlternativeProduct(currentSession.currentProductId, 'PRICE');
      if (alternativeProductContext) {
        log.info(
          {
            current_product_id: currentSession.currentProductId,
            alternative_product_id: alternativeProductContext.product_id,
          },
          'Alternative product loaded from Pinecone',
        );
      }
    } catch (err) {
      log.error({ err, current_product_id: currentSession.currentProductId }, 'Failed to load alternative product');
    }
  }

  const rawHistory = await getRecentHistory(callId, 4);
  const history: BrainConversationTurn[] = rawHistory.map((t) => ({
    speaker: t.speaker,
    utterance: t.utterance,
    timestamp: t.timestamp.toISOString(),
  }));

  let vapiSayFired = false;
  const fireVapiSayOnFirstChunk = (chunk: string) => {
    if (!vapiSayFired) {
      vapiSayFired = true;
      got
        .post(`https://api.vapi.ai/call/${callId}/say`, {
          headers: { Authorization: `Bearer ${config.VAPI_API_KEY}` },
          json: { message: chunk },
        })
        .catch((err) => log.error({ err }, 'Vapi say (first chunk) failed'));
    }
  };

  let generatedText: string;
  let chosenTactic: string | null = null;
  let tacticReasoning: string | null = null;

  if (config.USE_TACTIC_PIPELINE) {
    // New pipeline: classify → decide → generate-tactic
    // Gather the last few USER utterances (including the current one) for
    // voice-channel signal derivation. Recent first → reverse to oldest-first.
    const recentUserUtterances = [
      ...rawHistory.filter((t) => t.speaker === 'USER').map((t) => t.utterance),
      utterance,
    ].slice(-5);

    const decideReq = buildDecideRequest({
      callId,
      classification: classify,
      stage: nextStage,
      score: newScore,
      turnCount: currentSession.turnCount,
      priorObjections: session.objectionsEncountered, // pre-this-turn history
      discountsOffered: currentSession.discountsOffered,
      hasAlternativeProduct: alternativeProductContext !== null,
      recentUserUtterances,
      // Phone is the WhatsApp identity for the demo. Always true for a real
      // Vapi call (phone is required for the call to exist). Use 'unknown'
      // sentinel from session.service when the number wasn't captured.
      whatsappAvailable: currentSession.phoneNumber !== 'unknown',
    });

    const decision = await decideTactic(decideReq);
    chosenTactic = decision.tactic;
    tacticReasoning = decision.reasoning;
    log.info(
      { tactic: decision.tactic, reasoning: decision.reasoning },
      'Decision made',
    );

    // Discount authority is gated on the chosen tactic. Only CONCESSION_REAL
    // adds a NEW tier from the ladder; SEND_CHECKOUT_LINK_WHATSAPP reflects
    // any discount already offered. Anything else gets 0 so the LLM cannot
    // invent a price cut.
    if (decision.tactic === 'CONCESSION_REAL' && shouldOfferDiscount(decisionSession)) {
      discountAmount = getAvailableDiscount(decisionSession);
      Object.assign(stageUpdates, recordDiscountOffered(decisionSession, discountAmount));
    } else if (decision.tactic === 'SEND_CHECKOUT_LINK_WHATSAPP') {
      discountAmount = currentSession.discountsOffered.length
        ? Math.max(...currentSession.discountsOffered)
        : 0;
    }

    // Tool dispatch — fire the WhatsApp demo function in parallel with
    // generation. The Speech layer's micro-guidance has the agent
    // verbally confirm the same action.
    if (decision.tactic === 'SEND_CHECKOUT_LINK_WHATSAPP' && product) {
      sendCheckoutLinkOnWhatsApp({
        to: currentSession.phoneNumber,
        productId: product.id,
        productName: product.name,
        price: product.price,
        discountPercent: discountAmount,
      });
    } else if (decision.tactic === 'SEND_PRODUCT_INFO_WHATSAPP' && product) {
      sendProductInfoOnWhatsApp({
        to: currentSession.phoneNumber,
        productId: product.id,
        productName: product.name,
        price: product.price,
      });
    }

    generatedText = await generateTacticStream(
      {
        call_id: callId,
        utterance,
        tactic: decision.tactic,
        micro_guidance: decision.micro_guidance,
        conversation_history: history,
        product_context: productContext,
        alternative_product_context: alternativeProductContext,
        discount_available: discountAmount,
      },
      fireVapiSayOnFirstChunk,
    );
  } else {
    // Legacy pipeline: classify → generate (persona prompt)
    generatedText = await generateResponseStream(
      {
        call_id: callId,
        utterance,
        stage: nextStage,
        score: newScore,
        discount_available: discountAmount,
        objection_type: classify.objection_type,
        conversation_history: history,
        product_context: productContext,
        alternative_product_context: alternativeProductContext,
      },
      fireVapiSayOnFirstChunk,
    );
  }

  await updateSession(callId, stageUpdates);

  const now = new Date();
  await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now, objectionType: classify.objection_type });
  await appendTurn(callId, { speaker: 'AGENT', utterance: generatedText, timestamp: new Date() });

  // Non-blocking DB writes
  const turnBase = { scoreBefore: session.score, scoreAfter: newScore, stage: nextStage };
  const pipeline: 'tactic' | 'legacy' = config.USE_TACTIC_PIPELINE ? 'tactic' : 'legacy';
  insertCallTurn(callId, {
    turnNumber: session.turnCount + 1,
    speaker: 'USER',
    utterance,
    objectionType: classify.objection_type,
    objectionSubtype: classify.subtype ?? null,
    sentiment: classify.sentiment,
    discountOffered: discountAmount || undefined,
    ...turnBase,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (user)'));
  insertCallTurn(callId, {
    turnNumber: session.turnCount + 2,
    speaker: 'AGENT',
    utterance: generatedText,
    tactic: chosenTactic,
    tacticReasoning: tacticReasoning,
    pipeline,
    ...turnBase,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));

  log.info(
    {
      stage: nextStage,
      score: newScore,
      objection: classify.objection_type,
      subtype: classify.subtype ?? undefined,
      discount: discountAmount || undefined,
      tactic: chosenTactic ?? undefined,
      pipeline: config.USE_TACTIC_PIPELINE ? 'tactic' : 'legacy',
    },
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

  app.post('/webhook', {
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
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

      const discountGiven =
        session.discountsOffered.length > 0 ? Math.max(...session.discountsOffered) : 0;

      // Enqueue async post-call jobs — return 200 to Vapi immediately
      await callEndQueue.add('call-end', {
        callId,
        outcome,
        finalScore: session.score,
        discountGiven,
        stageReached: session.stage,
        turnCount: session.turnCount,
        phoneNumber: session.phoneNumber,
        productId: session.currentProductId,
        durationSeconds: report.durationSeconds,
      });

      await analyticsQueue.add('analytics', {
        callId,
        outcome,
        finalScore: session.score,
        discountGiven,
        stageReached: session.stage,
        turnCount: session.turnCount,
      });

      await crmQueue.add('crm-update', {
        callId,
        phoneNumber: session.phoneNumber,
        outcome,
        discount: discountGiven,
        productId: session.currentProductId,
      });

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
