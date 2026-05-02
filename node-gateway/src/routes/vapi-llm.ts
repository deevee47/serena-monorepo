/**
 * Vapi Custom LLM adapter.
 *
 * Vapi's Custom LLM mode calls this endpoint as if it were OpenAI's
 * /v1/chat/completions API on each conversation turn. We unwrap the
 * Vapi-supplied messages, map them to a ConverseRequest, run the brain's
 * /converse/stream, and re-stream events back as OpenAI-compatible SSE
 * chunks so Vapi can TTS the result.
 *
 * Side-effect tool calls (send_whatsapp_*) are dispatched server-side; we
 * do NOT forward them to Vapi as OpenAI tool_calls. The agent's text — a
 * one-line confirmation — has already been streamed before the tool_call
 * event fires, so Vapi speaks the confirmation and we fire the WhatsApp
 * send out-of-band.
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { createCallLogger } from '../utils/logger.js';
import {
  createSession,
  getSession,
  updateSession,
  appendTurn,
} from '../services/session.service.js';
import {
  converseStream,
  type BrainConversationTurn,
  type CartContextPayload,
} from '../services/brain.service.js';
import { dispatchToolCall } from '../services/converse-dispatcher.js';
import {
  findAlternativeProduct,
  getProductById,
  toProductContext,
} from '../services/product.service.js';
import { createCallRecord, insertCallTurn } from '../services/db.service.js';
import { classifyAnalyticsQueue } from '../queues/index.js';

interface VapiCustomLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

interface VapiCustomLlmRequest {
  model?: string;
  messages: VapiCustomLlmMessage[];
  stream?: boolean;
  // Vapi includes call info on every Custom LLM request.
  call?: {
    id: string;
    customer?: { number?: string };
    metadata?: Record<string, unknown>;
  };
}

const HISTORY_TURNS_TO_INCLUDE = 4;

export default async function vapiLlmRoutes(app: FastifyInstance) {
  app.post(
    '/vapi-llm/chat/completions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Auth — DEV MODE: fully permissive. Vapi reaches us via an obscure
      // ngrok URL. We log whether the Authorization header matches
      // VAPI_WEBHOOK_SECRET but never reject on mismatch.
      // TODO: tighten before prod — accept-only-if-match with timing-safe
      // compare, identical to the /webhook handler.
      const authHeader = request.headers['authorization'] as string | undefined;
      if (authHeader !== undefined) {
        const expected = `Bearer ${config.VAPI_WEBHOOK_SECRET}`;
        const expBuf = Buffer.from(expected);
        const authBuf = Buffer.from(authHeader);
        const matches =
          authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
        if (!matches) {
          request.log.warn(
            {
              auth_header_starts_with_bearer: authHeader.startsWith('Bearer '),
              auth_header_length: authHeader.length,
              expected_length: expected.length,
            },
            'vapi-llm auth mismatch — proceeding anyway (DEV)',
          );
        }
      }

      const body = request.body as VapiCustomLlmRequest;
      const callId = body.call?.id;
      if (!callId) {
        return reply.status(400).send({
          error: { code: 'MISSING_CALL_ID', message: 'call.id is required' },
        });
      }
      const log = createCallLogger(callId);

      // Find or lazily create the session. For outbound calls Vapi never
      // fires `assistant-request`, so this is the first time we see callId.
      let session = await getSession(callId);
      if (!session) {
        const pendingRaw = await redis.get(`pending_call:${callId}`);
        let productId = 'prod-001';
        if (pendingRaw) {
          try {
            productId = (JSON.parse(pendingRaw) as { productId: string }).productId;
          } catch {
            /* ignore */
          }
        } else if (typeof body.call?.metadata?.['product_id'] === 'string') {
          productId = body.call.metadata['product_id'] as string;
        }
        const phoneNumber = body.call?.customer?.number ?? 'unknown';
        session = await createSession({ callId, phoneNumber, productId });
        createCallRecord(session).catch((err) =>
          log.error({ err }, 'createCallRecord failed'),
        );
        log.info({ productId, phoneNumber }, 'Vapi LLM: lazily created session');
      }

      const lastUserMessage = [...body.messages]
        .reverse()
        .find((m) => m.role === 'user' && typeof m.content === 'string');
      const utterance = lastUserMessage?.content ?? '';

      const product = getProductById(session.currentProductId);
      const productContext = product ? toProductContext(product) : null;

      let alternativeContext = null;
      let premiumContext = null;
      if (product) {
        // Cheaper + premium in parallel — both feed the prompt's anchor pattern.
        const [cheaperRes, premiumRes] = await Promise.allSettled([
          findAlternativeProduct(session.currentProductId, 'PRICE'),
          findAlternativeProduct(session.currentProductId, 'PREMIUM'),
        ]);
        if (cheaperRes.status === 'fulfilled') alternativeContext = cheaperRes.value;
        else log.warn({ err: cheaperRes.reason }, 'cheaper alt lookup failed (non-fatal)');
        if (premiumRes.status === 'fulfilled') premiumContext = premiumRes.value;
        else log.warn({ err: premiumRes.reason }, 'premium alt lookup failed (non-fatal)');
      }

      const cartContext: CartContextPayload | null = product
        ? {
            items: [
              {
                product_id: product.id,
                name: product.name,
                price: product.price,
                quantity: 1,
              },
            ],
            total: product.price,
            abandoned_minutes_ago: null,
          }
        : null;

      // Conversation history from Vapi's messages, excluding the latest user
      // utterance (we pass that as `utterance` separately to the brain).
      const history: BrainConversationTurn[] = body.messages
        .filter(
          (m) =>
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.length > 0,
        )
        .slice(0, -1)
        .slice(-HISTORY_TURNS_TO_INCLUDE)
        .map((m) => ({
          speaker: m.role === 'user' ? 'USER' : 'AGENT',
          utterance: m.content as string,
          timestamp: new Date().toISOString(),
        }));

      // ── Stream OpenAI-compatible SSE response ──────────────────────────
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const completionId = `chatcmpl-${callId}-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model ?? 'serena-converse';

      const sendChunk = (
        delta: { content?: string; role?: 'assistant' },
        finishReason: string | null = null,
      ) => {
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      sendChunk({ role: 'assistant' });

      let fullText = '';
      let dispatch: ReturnType<typeof dispatchToolCall> | null = null;

      try {
        const result = await converseStream(
          {
            call_id: callId,
            utterance,
            conversation_history: history,
            product_context: productContext,
            alternative_product_context: alternativeContext,
            premium_product_context: premiumContext,
            cart_context: cartContext,
            discounts_already_offered: session.discountsOffered,
          },
          (delta) => {
            fullText += delta;
            sendChunk({ content: delta });
          },
        );

        if (result.tool_call) {
          dispatch = dispatchToolCall(result.tool_call, {
            callId,
            phoneNumber: session.phoneNumber,
            product: product
              ? { id: product.id, name: product.name, price: product.price }
              : null,
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

        sendChunk({}, 'stop');
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (err) {
        log.error({ err }, 'Vapi LLM turn failed');
        try {
          sendChunk({ content: 'Give me just a moment.' });
          sendChunk({}, 'stop');
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        } catch {
          /* connection probably closed */
        }
        return;
      }

      // ── Persist turns and update session (best-effort, off the response path)
      const sessionUpdates: Parameters<typeof updateSession>[1] = {};
      if (dispatch?.toolName === 'send_whatsapp_checkout_link') {
        const offered =
          (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? 0;
        if (offered > 0 && !session.discountsOffered.includes(offered)) {
          sessionUpdates.discountsOffered = [...session.discountsOffered, offered];
        }
      }
      if (Object.keys(sessionUpdates).length > 0) {
        await updateSession(callId, sessionUpdates);
      }

      const now = new Date();
      await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now });
      await appendTurn(callId, {
        speaker: 'AGENT',
        utterance: fullText,
        timestamp: new Date(),
      });

      const turnBase = { scoreBefore: 0, scoreAfter: 0, stage: session.stage };

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
            .catch((err) =>
              log.warn({ err }, 'enqueue classify-analytics failed'),
            ),
        )
        .catch((err) => log.error({ err }, 'DB turn insert failed (user)'));

      const discountAmount =
        dispatch?.toolName === 'send_whatsapp_checkout_link'
          ? (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? null
          : null;

      insertCallTurn(callId, {
        turnNumber: session.turnCount + 2,
        speaker: 'AGENT',
        utterance: fullText,
        toolCalled: dispatch?.toolName ?? null,
        toolArgs: dispatch?.appliedArgs ?? null,
        discountOffered: discountAmount,
        ...turnBase,
      }).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));

      log.info(
        {
          text_len: fullText.length,
          tool: dispatch?.toolName ?? null,
          discount: discountAmount ?? undefined,
        },
        'Vapi LLM turn processed',
      );
    },
  );
}
