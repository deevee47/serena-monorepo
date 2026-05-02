import crypto from 'crypto';
import got from 'got';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { createCallLogger, logger } from '../utils/logger.js';
import type { VapiWebhookEvent } from '../types/vapi.types.js';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
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
  converseStream,
  type BrainConversationTurn,
  type CartContextPayload,
} from '../services/brain.service.js';
import { dispatchToolCall } from '../services/converse-dispatcher.js';
import { findAlternativeProduct, getProductById, toProductContext } from '../services/product.service.js';
import { createCallRecord, insertCallTurn } from '../services/db.service.js';
import {
  callEndQueue,
  analyticsQueue,
  crmQueue,
  classifyAnalyticsQueue,
} from '../queues/index.js';
import { ConversationStage } from '../types/session.types.js';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

// Per-call concurrency lock — chains processTranscript without blocking the HTTP response.
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

  const product = getProductById(session.currentProductId);
  const productContext = product ? toProductContext(product) : null;

  // Best-effort alternative product lookup. The LLM uses this for the
  // alt-vs-discount choice when price comes up. Cheap enough to attempt
  // every turn (Pinecone hit ~50-100ms, breaker fallback is empty list).
  let alternativeContext = null;
  if (product) {
    try {
      alternativeContext = await findAlternativeProduct(session.currentProductId, 'PRICE');
    } catch (err) {
      log.warn({ err }, 'alternative product lookup failed (non-fatal)');
    }
  }

  // Demo cart: under the converse pipeline the agent should reference what's
  // in the cart, not just the current product. Real integrations source this
  // from the storefront cart service. For now the cart contains the current
  // product as a single line item.
  const cartContext: CartContextPayload | null = product
    ? {
        items: [{ product_id: product.id, name: product.name, price: product.price, quantity: 1 }],
        total: product.price,
        abandoned_minutes_ago: null,
      }
    : null;

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

  // Single LLM call. The model decides whether to talk, call a tool, or both.
  const result = await converseStream(
    {
      call_id: callId,
      utterance,
      conversation_history: history,
      product_context: productContext,
      alternative_product_context: alternativeContext,
      cart_context: cartContext,
      discounts_already_offered: session.discountsOffered,
    },
    fireVapiSayOnFirstChunk,
  );

  // Dispatch any tool the LLM picked. The dispatcher clamps discount_percent
  // and routes to the matching whatsapp.service function.
  let dispatch: ReturnType<typeof dispatchToolCall> | null = null;
  if (result.tool_call) {
    dispatch = dispatchToolCall(result.tool_call, {
      callId,
      phoneNumber: session.phoneNumber,
      product: product ? { id: product.id, name: product.name, price: product.price } : null,
    });
    log.info(
      {
        tool: dispatch.toolName,
        applied_args: dispatch.appliedArgs,
        whatsapp_message_id: dispatch.whatsapp?.messageId,
        skipped: dispatch.skipped,
      },
      'Tool dispatched',
    );
  }

  // Track checkout-link discount in session so the next prompt knows the LLM
  // already offered that tier and shouldn't repeat it.
  const sessionUpdates: Parameters<typeof updateSession>[1] = {};
  if (dispatch?.toolName === 'send_whatsapp_checkout_link') {
    const offered = (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? 0;
    if (offered > 0 && !session.discountsOffered.includes(offered)) {
      sessionUpdates.discountsOffered = [...session.discountsOffered, offered];
    }
  }
  if (Object.keys(sessionUpdates).length > 0) {
    await updateSession(callId, sessionUpdates);
  }

  // Persist turns to Redis (in-memory dialog) and Postgres (audit trail).
  const now = new Date();
  await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now });
  await appendTurn(callId, { speaker: 'AGENT', utterance: result.text, timestamp: new Date() });

  // Score/stage are no longer used for routing under the converse pipeline,
  // but we keep them in the schema for backwards-compat with existing rows.
  // Persist stable defaults so analytics queries don't break.
  const turnBase = { scoreBefore: 0, scoreAfter: 0, stage: session.stage };

  // Insert USER turn first; on success enqueue classify-analytics so the row
  // gets objection_type + subtype tagged after-the-fact.
  insertCallTurn(callId, {
    turnNumber: session.turnCount + 1,
    speaker: 'USER',
    utterance,
    ...turnBase,
  })
    .then((userTurnId) =>
      classifyAnalyticsQueue
        .add('classify', {
          callId,
          callTurnId: userTurnId,
          utterance,
          stage: session.stage,
          score: 50,
        })
        .catch((err) => log.warn({ err }, 'enqueue classify-analytics failed')),
    )
    .catch((err) => log.error({ err }, 'DB turn insert failed (user)'));

  const discountAmount =
    dispatch?.toolName === 'send_whatsapp_checkout_link'
      ? (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? null
      : null;

  insertCallTurn(callId, {
    turnNumber: session.turnCount + 2,
    speaker: 'AGENT',
    utterance: result.text,
    toolCalled: dispatch?.toolName ?? null,
    toolArgs: dispatch?.appliedArgs ?? null,
    discountOffered: discountAmount,
    ...turnBase,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));

  log.info(
    {
      text_len: result.text.length,
      tool: dispatch?.toolName ?? null,
      finish_reason: result.finish_reason,
      discount: discountAmount ?? undefined,
    },
    'Turn processed',
  );
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

      const authHeader = request.headers['authorization'] as string | undefined;
      const expected = `Bearer ${config.VAPI_WEBHOOK_SECRET}`;
      const expBuf = Buffer.from(expected);
      const authBuf = Buffer.from(authHeader ?? '');
      const valid = authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
      if (!valid) {
        logger.warn({ ip: request.ip }, 'Invalid webhook auth');
        return reply
          .status(401)
          .send({ error: { code: 'INVALID_SIGNATURE', message: 'Unauthorized' } });
      }

      const event = request.body as VapiWebhookEvent;
      const type = event?.message?.type;
      const callId = event?.message?.call?.id ?? 'unknown';
      const log = createCallLogger(callId);

      log.info({ type }, 'Vapi webhook received');

      // ── assistant-request ──────────────────────────────────────────────
      if (type === 'assistant-request') {
        let productId =
          (event.message.call.metadata?.['product_id'] as string | undefined) ?? 'prod-001';
        try {
          const raw = await redis.get(`pending_call:${callId}`);
          if (raw) {
            const pending = JSON.parse(raw) as { productId: string; triggerReason: string };
            productId = pending.productId;
          } else if (!event.message.call.metadata?.['product_id']) {
            log.warn('No pending_call found in Redis — using default product');
          }
        } catch (err) {
          log.error(
            { err },
            'Redis get pending_call failed — using request metadata or default product',
          );
        }

        const phoneNumber =
          (event.message.call as { customer?: { number?: string } }).customer?.number ?? 'unknown';
        const session = await createSession({ callId, phoneNumber, productId });

        createCallRecord(session).catch((err) => log.error({ err }, 'createCallRecord failed'));

        return reply.send({ assistantId: config.VAPI_ASSISTANT_ID });
      }

      // ── transcript ─────────────────────────────────────────────────────
      // Under Custom LLM mode (the supported flow), every turn is handled by
      // /vapi-llm/chat/completions. The transcript event arrives here as
      // well, but we ignore it — processing it would duplicate every
      // call_turn row and run the brain twice per turn.
      if (type === 'transcript') {
        return reply.send({});
      }

      // ── status-update ─────────────────────────────────────────────────
      if (type === 'status-update') {
        const status = (event.message as { status?: string }).status;
        log.info({ status }, 'Call status update');
        return reply.send({});
      }

      // ── end-of-call-report ────────────────────────────────────────────
      if (type === 'end-of-call-report') {
        const session = await getSession(callId);
        if (!session) {
          log.warn('end-of-call-report: session not found');
          return reply.send({});
        }

        // Outcome under the converse pipeline: CONVERTED iff the LLM ever
        // fired the checkout tool during the call. Anything else is DROPPED.
        const checkoutTurn = await prisma.callTurn.findFirst({
          where: { callId, toolCalled: 'send_whatsapp_checkout_link' },
          select: { id: true, toolArgs: true },
        });
        const outcome: 'CONVERTED' | 'DROPPED' = checkoutTurn ? 'CONVERTED' : 'DROPPED';

        const report = event.message as { durationSeconds?: number };
        await endSession(callId);

        const discountGiven =
          session.discountsOffered.length > 0 ? Math.max(...session.discountsOffered) : 0;

        await callEndQueue.add('call-end', {
          callId,
          outcome,
          finalScore: 0, // deprecated under converse pipeline
          discountGiven,
          stageReached: outcome === 'CONVERTED' ? 'CONVERTED' : 'DROPPED',
          turnCount: session.turnCount,
          phoneNumber: session.phoneNumber,
          productId: session.currentProductId,
          durationSeconds: report.durationSeconds,
        });

        await analyticsQueue.add('analytics', {
          callId,
          outcome,
          finalScore: 0,
          discountGiven,
          stageReached: outcome,
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

        log.info({ outcome, discountGiven, turnCount: session.turnCount }, 'Call ended');
        return reply.send({});
      }

      return reply.send({});
    },
  );

  // Debug endpoint — dev only
  if (config.NODE_ENV === 'development') {
    app.get('/debug/session/:callId', async (request: FastifyRequest, reply: FastifyReply) => {
      const { callId } = request.params as { callId: string };
      const session = await getSession(callId);
      return reply.send(session ?? { error: 'Session not found' });
    });
  }
}

// Suppress unused-import warning — ConversationStage is referenced via
// session.stage typing implicitly.
void ConversationStage;
