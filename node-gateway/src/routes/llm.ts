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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { createCallLogger } from '../utils/logger.js';
import { redis } from '../lib/redis.js';
import {
  ensureSessionForCall,
  getSession,
  updateSession,
  getRecentHistory,
} from '../services/session.service.js';
import {
  converseStream,
  type BrainConversationTurn,
  type CartContextPayload,
} from '../services/brain.service.js';
import { dispatchToolCall } from '../services/converse-dispatcher.js';
import { checkSpokenDiscount } from '../services/discount-guard.js';
import { estimateSpeechMs } from '../lib/tts-estimate.js';
import {
  findAlternativeProduct,
  getProductById,
  toProductContext,
} from '../services/product.service.js';
import { getCachedCallContext, getRecentTurnSignals } from '../services/db.service.js';
import { persistOpenerIfMissing, persistTurnPair } from '../services/turn-persist.service.js';
import {
  detectFillerLanguage,
  isDisfluencyOpener,
  recordObservationLatency,
  shouldEmitFiller,
  thinkingFillerFor,
} from '../services/thinking-filler.js';
import { detectLlmProvider, getVoiceProvider } from '../services/voice-provider/index.js';

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

/** Matches WEB_BRIDGE_TTL_SECONDS in routes/webhook.ts. Kept inline rather
 *  than imported because cross-route imports invite circular-dep accidents. */
const WEB_BRIDGE_TTL_SECONDS = 300;

/**
 * Per-call Redis pub/sub channel for live deltas. The dashboard's SSE route
 * subscribes to this and forwards each message as an SSE event so LiveTail
 * can stream agent text chunk-by-chunk instead of waiting for the next
 * 1.5s Postgres poll.
 */
function liveChannel(callId: string): string {
  return `live:${callId}`;
}

function publishLive(callId: string, event: Record<string, unknown>): void {
  // Fire-and-forget. A failed publish should never block the LLM response —
  // the dashboard's Postgres poll will still pick up the persisted turn,
  // just with the usual ~1.5s delay.
  const payload = JSON.stringify({ ...event, ts: new Date().toISOString() });
  redis.publish(liveChannel(callId), payload).catch(() => undefined);
}

/**
 * Pull a bridge UUID out of provider-supplied metadata. Telnyx forwards custom
 * headers (`X-Bridge-UUID`) as dynamic variables, and the exact field name
 * varies across portal toggles (`X-Bridge-UUID`, `x-bridge-uuid`,
 * `bridge_uuid`, …). Try every variant — first non-empty string wins.
 */
function extractBridgeUuid(metadata: Record<string, unknown>): string | null {
  const candidates = [
    'bridge_uuid',
    'bridgeUuid',
    'X-Bridge-UUID',
    'x-bridge-uuid',
    'X_Bridge_UUID',
  ];
  for (const key of candidates) {
    const v = metadata[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

async function llmCompletionsHandler(request: FastifyRequest, reply: FastifyReply) {
  // Auto-detect the provider per-request. Both providers can hit this same
  // /llm/chat/completions URL — Telnyx supplies `x-telnyx-call-control-id`
  // in headers (or a `telnyx_call` block in body), Vapi puts the call info
  // inside `body.call.*`.
  const providerName = detectLlmProvider(request.headers, request.body);
  const provider = getVoiceProvider(providerName);

  // Dev-only: dump headers + body so we can see Telnyx's exact envelope and
  // tighten parseLlmEnvelope when needed.
  if (config.TELNYX_INSECURE_DEV === '1' && provider.name === 'telnyx') {
    request.log.warn(
      {
        headers: request.headers,
        body_preview: JSON.stringify(request.body).slice(0, 2000),
      },
      'TELNYX_INSECURE_DEV: incoming LLM request',
    );
  }

  // Auth — DEV-friendly: log mismatches but proceed. Tighten when the
  // public ngrok/staging URL is replaced by a stable prod URL.
  const auth = provider.verifyLlmAuth(request.headers);
  if (!auth.ok) {
    request.log.warn({ reason: auth.reason }, 'llm auth mismatch — proceeding anyway (DEV)');
  }

  const env = provider.parseLlmEnvelope(request.headers, request.body);
  const callId = env.callId;
  if (!callId) {
    // Telnyx's portal "Validate LLM connection" button POSTs a probe with
    // no call envelope. Treat any callId-less request as a connectivity
    // check and stream back a minimal OpenAI-compatible response so the
    // validator passes. Real calls always carry a call_id; if this fires
    // during a live call, parseLlmEnvelope needs an extra candidate field —
    // turn on TELNYX_INSECURE_DEV to dump the full request shape.
    request.log.info(
      { provider: provider.name, header_keys: Object.keys(request.headers) },
      'LLM probe (no call id) — returning stub validation response',
    );
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const stubId = `chatcmpl-probe-${Date.now()}`;
    const stubCreated = Math.floor(Date.now() / 1000);
    const reqBody = request.body as
      | { model?: string; stream_options?: { include_usage?: boolean } }
      | null;
    const stubModel = reqBody?.model ?? 'serena-converse';
    const includeUsage = reqBody?.stream_options?.include_usage === true;

    const writeChunk = (
      delta: Record<string, unknown>,
      finishReason: string | null = null,
    ) => {
      reply.raw.write(
        `data: ${JSON.stringify({
          id: stubId,
          object: 'chat.completion.chunk',
          created: stubCreated,
          model: stubModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(includeUsage ? { usage: null } : {}),
        })}\n\n`,
      );
    };

    writeChunk({ role: 'assistant' });
    writeChunk({ content: 'ok' });
    writeChunk({}, 'stop');

    // Per OpenAI's stream_options.include_usage contract, send a final
    // usage-only chunk (empty choices) right before [DONE]. Telnyx's
    // validator requests this — without it, the integration may pass the
    // "connection test" but get rejected by stricter call-time checks.
    if (includeUsage) {
      reply.raw.write(
        `data: ${JSON.stringify({
          id: stubId,
          object: 'chat.completion.chunk',
          created: stubCreated,
          model: stubModel,
          choices: [],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 1,
            total_tokens: 1,
          },
        })}\n\n`,
      );
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return;
  }
  const log = createCallLogger(callId);

  const body = request.body as VapiCustomLlmRequest;

  // Find or lazily create the session. For outbound calls the provider may
  // not fire an init webhook before the first LLM turn, so this is often
  // the first time we see callId.
  const phoneNumber = env.phoneNumber ?? 'unknown';
  const metadataProductId =
    typeof env.metadata['product_id'] === 'string'
      ? (env.metadata['product_id'] as string)
      : null;
  // Call-completion offer from the trigger (X-Discount-Pct → dynamic var →
  // extra_metadata). Arrives as a string; clamp to the authorized 0-10 range.
  // Null when the trigger didn't set one → the brain falls back to its 5%
  // default. We never let it exceed the 10% absolute cap.
  const rawDiscount = env.metadata['discount_pct'];
  const parsedDiscount =
    typeof rawDiscount === 'string' || typeof rawDiscount === 'number'
      ? Number(rawDiscount)
      : NaN;
  const openingOfferPercent = Number.isFinite(parsedDiscount)
    ? Math.min(10, Math.max(0, Math.round(parsedDiscount)))
    : null;
  // Call mode from the trigger (X-Call-Mode → dynamic var → extra_metadata).
  // Only the two known modes are forwarded; anything else → null so the brain
  // falls back to its OUTBOUND_RECOVERY default.
  const rawCallMode = env.metadata['call_mode'];
  const callMode =
    rawCallMode === 'INBOUND_PRESALES' || rawCallMode === 'OUTBOUND_RECOVERY'
      ? rawCallMode
      : null;
  const ensured = await ensureSessionForCall({
    callId,
    phoneNumber,
    metadataProductId,
    voiceProvider: provider.name,
  });
  let session = ensured.session;
  const triggerProvidedProduct = ensured.productFromTrigger;
  if (ensured.isNew) {
    log.info(
      { productId: session.currentProductId, phoneNumber, provider: provider.name },
      'LLM: lazily created session',
    );
  }

  // Bridge map for the dashboard's LiveTail. TeXML-routed WebRTC calls don't
  // surface `client_state` in our webhooks, so we write the bridge entry from
  // here on every LLM turn (idempotent via SETEX). The bridgeUuid was passed
  // as the `X-Bridge-UUID` custom header in the browser's startConversation.
  const bridgeUuid = extractBridgeUuid(env.metadata);
  if (bridgeUuid) {
    // Fire-and-forget: this is a dashboard-only convenience write and must not
    // sit on the per-turn dead-air path before the first spoken token.
    void redis
      .setex(`web_call_bridge:${bridgeUuid}`, WEB_BRIDGE_TTL_SECONDS, callId)
      .catch((err) =>
        log.warn({ err, bridgeUuid }, 'web_call_bridge write failed (non-fatal)'),
      );
  }

      const lastUserMessage = [...body.messages]
        .reverse()
        .find((m) => m.role === 'user' && typeof m.content === 'string');
      const utterance = lastUserMessage?.content ?? '';

      // Pre-response latency = gap between the previous AGENT turn finishing
      // TTS and this USER turn arriving. `lastAgentFinishedAt` is the ESTIMATED
      // TTS-playback-end of the prior turn (generation time + estimated speech
      // duration — see where it's set below), so this approximates the
      // customer's actual think-time rather than counting the agent's speech as
      // silence. Still imperfect: turnReceivedAt is when the user's utterance
      // POSTs (after they finish speaking), so their own speech duration is
      // included — but the dominant agent-message-length confound is removed.
      // Skip the first turn (no prior agent reply to anchor against).
      const turnReceivedAt = Date.now();
      let currentUserLatencyMs: number | null;
      if (typeof session.pendingResponseLatencyMs === 'number') {
        // Provider-measured think-time (user-started − agent-stopped, from
        // speech.boundary webhooks) — the accurate value. Clear it so a later
        // turn that gets no speech events doesn't reuse a stale number.
        currentUserLatencyMs = session.pendingResponseLatencyMs;
        void updateSession(callId, { pendingResponseLatencyMs: null }).catch((err) =>
          log.warn({ err }, 'clear pendingResponseLatencyMs failed (non-fatal)'),
        );
      } else if (session.lastAgentFinishedAt) {
        // Fallback: estimate from generation-end + estimated TTS playback.
        currentUserLatencyMs = Math.max(
          0,
          turnReceivedAt - new Date(session.lastAgentFinishedAt).getTime(),
        );
      } else {
        currentUserLatencyMs = null;
      }

      // ── Live customer + cart context ───────────────────────────────────
      // Cached per-call on Redis so we hit Postgres once per call, not once
      // per turn. The cart loaded here is the actual abandoned cart for this
      // phone number, not a synthetic single-product placeholder.
      const loaded = await getCachedCallContext(callId, session.phoneNumber);

      // If the call was triggered without an explicit product_id, prefer
      // the customer's actually-abandoned product over the prod-001 default.
      if (!triggerProvidedProduct && loaded.primaryProductId && session.currentProductId === 'prod-001') {
        // Update the in-memory session synchronously (this turn uses it), but
        // persist fire-and-forget — the Redis write must not gate first-token.
        // It's idempotent: if the next turn races ahead of the write, it just
        // re-applies the same override.
        session = { ...session, currentProductId: loaded.primaryProductId };
        void updateSession(callId, { currentProductId: loaded.primaryProductId }).catch((err) =>
          log.warn({ err }, 'product-override updateSession failed (non-fatal)'),
        );
      }

      const product = getProductById(session.currentProductId);
      const productContext = product ? toProductContext(product) : null;

      // Recent USER signals (sentiment streak, repeated objection, filler density,
      // length trend). The classify-analytics worker writes sentiment async, so
      // turn N-1's sentiment is usually in by turn N+1. Cheap query, in parallel.
      let alternativeContext = null;
      let premiumContext = null;
      let recentSignals: Awaited<ReturnType<typeof getRecentTurnSignals>> | null = null;
      const signalLookups: Promise<unknown>[] = [
        getRecentTurnSignals(callId, 3)
          .then((s) => {
            recentSignals = s;
          })
          .catch((err) => {
            log.warn({ err }, 'getRecentTurnSignals failed (non-fatal)');
          }),
      ];
      if (product) {
        // Cheaper + premium in parallel — both feed the prompt's anchor pattern.
        signalLookups.push(
          findAlternativeProduct(session.currentProductId, 'PRICE')
            .then((v) => {
              alternativeContext = v;
            })
            .catch((err) =>
              log.warn({ err }, 'cheaper alt lookup failed (non-fatal)'),
            ),
          findAlternativeProduct(session.currentProductId, 'PREMIUM')
            .then((v) => {
              premiumContext = v;
            })
            .catch((err) =>
              log.warn({ err }, 'premium alt lookup failed (non-fatal)'),
            ),
        );
      }
      await Promise.allSettled(signalLookups);

      // Layer session-derived signals onto whatever the DB-derived snapshot
      // gave us. The DB only knows about persisted USER turns, so:
      //   - push_attempt comes from session state (incremented at turn
      //     persistence time, never inferred from transcript).
      //   - response_latency_ms is the gap we just measured for THIS turn
      //     (fresher than whatever was on the previous USER row).
      if (recentSignals === null) {
        recentSignals = { sentiments: [] };
      }
      recentSignals = {
        ...recentSignals,
        push_attempt: session.pushAttempt > 0 ? session.pushAttempt : null,
        response_latency_ms: currentUserLatencyMs,
      };

      // Real abandoned cart from DB when we have one; otherwise fall back to
      // the synthetic single-product cart so the agent still has something
      // to reference.
      const cartContext: CartContextPayload | null =
        loaded.cart ??
        (product
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
          : null);

      // Backfill Vapi's locally-spoken first message (its `firstMessage`
      // assistant-config line, e.g. "Hi, this is Sera from Muscleblaze...")
      // as AGENT turn 1. Vapi TTSes that line itself and never round-trips
      // it through this endpoint, so without this hook the opener is
      // missing from the chat + transcript + live tail.
      //
      // Detection: on the very first turn (session.turnCount === 0), any
      // assistant message in body.messages before the first user message
      // is Vapi's opener. We persist it once, idempotently, then refresh
      // the session snapshot so isOpener no longer fires for the response
      // we're about to compute.
      if (session.turnCount === 0) {
        const vapiOpener = body.messages.find(
          (m) =>
            m.role === 'assistant' &&
            typeof m.content === 'string' &&
            m.content.trim().length > 0,
        );
        if (vapiOpener && typeof vapiOpener.content === 'string') {
          await persistOpenerIfMissing(callId, vapiOpener.content);
          const refreshed = await getSession(callId).catch(() => null);
          if (refreshed) session = refreshed;
        }
      }

      // Conversation history. Prefer Redis session history (authoritative —
      // contains the agent's actually-streamed text, including turns the
      // customer interrupted). Fall back to Vapi's body.messages when Redis
      // is empty (very first turn). Without this, an interrupted opener
      // disappears from history and the LLM thinks it hasn't opened yet,
      // causing it to re-introduce on every turn.
      const sessionHistory = await getRecentHistory(
        callId,
        HISTORY_TURNS_TO_INCLUDE,
      ).catch(() => [] as Awaited<ReturnType<typeof getRecentHistory>>);

      let history: BrainConversationTurn[];
      if (sessionHistory.length > 0) {
        history = sessionHistory.map((t) => ({
          speaker: t.speaker,
          utterance: t.utterance,
          timestamp: t.timestamp.toISOString(),
        }));
      } else {
        history = body.messages
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
      }

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
      // Captured from the brain's `observation` stream events. Persisted on
      // the AGENT turn so LiveTail surfaces an observation chip for each
      // tool invocation (list_products, get_offer, etc.).
      const observations: Array<{
        name: string;
        args: Record<string, unknown>;
        result: Record<string, unknown>;
      }> = [];
      // Per-observation latency in ms — measured from the brain's `thinking`
      // event (just before it awaits the tool) to the corresponding
      // `observation` event (when the result arrives). Persisted on the
      // AGENT turn for the dashboard + for the thinking-filler trimmer's
      // rolling p50.
      const observationLatencies: Array<{ name: string; ms: number }> = [];
      // pending thinking-event timestamps keyed by tool name — popped on the
      // matching observation event. Tools that don't fire `thinking` (none
      // today, but future-safe) just won't produce a latency entry.
      const pendingThinking: Map<string, number> = new Map();
      // At most ONE spoken filler per turn. A turn that fires several tools
      // (e.g. get_review_summary + get_available_offers) would otherwise stack
      // "ek minute… — ek second… —" into one breath, which sounds repetitive.
      let fillerEmittedThisTurn = false;

      // Filler language: prefer the customer's actual reply, fall back to timezone.
      const fillerLang = detectFillerLanguage({
        lastUtterance: utterance,
        timezone: loaded.customer?.timezone ?? null,
      });

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
            customer_context: loaded.customer,
            recent_user_signals: recentSignals,
            discounts_already_offered: session.discountsOffered,
            ...(openingOfferPercent !== null
              ? { opening_offer_percent: openingOfferPercent }
              : {}),
            ...(callMode !== null ? { call_mode: callMode } : {}),
          },
          {
            onTextDelta: (delta) => {
              fullText += delta;
              sendChunk({ content: delta });
              publishLive(callId, { type: 'text_delta', delta });
            },
            onThinking: (toolName) => {
              // Always record the timestamp so EVERY tool's latency is measured,
              // even tools whose filler we end up suppressing below.
              pendingThinking.set(toolName, Date.now());
              // One filler per turn — don't stack a second "checking…" cue when
              // the brain fires multiple tools in the same turn.
              if (fillerEmittedThisTurn) return;
              // Suppress if the LLM already opened with its own disfluency cue —
              // stacked "hmm — let me check —" sounds wrong.
              if (isDisfluencyOpener(fullText)) return;
              // Suppress also if the rolling p50 latency for this tool is
              // fast enough that the filler would arrive AFTER the result
              // and just sound robotic. Trims dead-air openers on
              // cache-warm get_review_summary / check_inventory hits.
              if (!shouldEmitFiller(toolName)) {
                log.debug({ tool: toolName }, 'thinking filler skipped (fast tool)');
                return;
              }
              const filler = thinkingFillerFor(toolName, fillerLang);
              fullText += filler;
              fillerEmittedThisTurn = true;
              sendChunk({ content: filler });
              publishLive(callId, { type: 'text_delta', delta: filler });
              publishLive(callId, { type: 'status', status: 'thinking', tool: toolName });
              log.info({ tool: toolName, lang: fillerLang }, 'thinking filler sent');
            },
            onObservation: (obs) => {
              // Note: NOT published over live: pub/sub. The dashboard's SSE
              // route emits `observation` events when it polls the persisted
              // `CallTurn.observationsCalled`, and double-publishing would
              // duplicate the chip via LiveTail's pendingObservationsRef.
              observations.push(obs);
              const start = pendingThinking.get(obs.name);
              if (start !== undefined) {
                const ms = Math.max(0, Date.now() - start);
                observationLatencies.push({ name: obs.name, ms });
                recordObservationLatency(obs.name, ms);
                pendingThinking.delete(obs.name);
              }
            },
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
          // Note: NOT published over live: pub/sub for the same reason as
          // observations — the SSE-route poll re-emits `tool_call` from
          // CallTurn.toolCalled and would double-fire the chip update.
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

      // Anchor for the NEXT turn's pre-response latency. We finished
      // generating the text now, but the provider's TTS still has to speak it
      // to the customer — they can't reply until they've heard it. Timing from
      // "now" would count the whole TTS playback as customer silence, and that
      // inflation grows with how much the agent said. So advance the anchor by
      // the estimated speech duration to approximate when the customer finished
      // hearing the turn. (Heuristic; the exact value would need a provider
      // speech-end event, which isn't reliably available per turn. A barge-in
      // lands before this estimate → clamped to 0 by the reader, which reads
      // correctly as an eager/instant reply.)
      const agentSpeechEndsAt = new Date(Date.now() + estimateSpeechMs(fullText)).toISOString();
      updateSession(callId, { lastAgentFinishedAt: agentSpeechEndsAt }).catch((err) =>
        log.warn({ err }, 'lastAgentFinishedAt update failed (non-fatal)'),
      );

      // ── Persist turns and update session (best-effort, off the response path)
      await persistTurnPair({
        callId,
        session,
        utterance,
        agentText: fullText,
        dispatch,
        observations,
        userResponseLatencyMs: currentUserLatencyMs,
        observationLatenciesMs:
          observationLatencies.length > 0 ? observationLatencies : null,
        recentSignals,
      });

      const discountAmount =
        dispatch?.toolName === 'send_whatsapp_checkout_link'
          ? (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? null
          : null;

      // Reconcile the SPOKEN discount (free LLM text, now TTS'd to the
      // customer) against what the link actually applied + the absolute cap.
      // We can't un-speak it, but a divergence is a verbal-commitment liability
      // worth alarming on. Fires even with no checkout (a bare verbal promise).
      const discountCheck = checkSpokenDiscount(fullText, discountAmount ?? 0);
      if (discountCheck.exceedsCap || discountCheck.exceedsApplied) {
        log.warn(
          {
            spoken_discount_percent: discountCheck.spokenPercent,
            applied_discount_percent: discountCheck.appliedPercent,
            exceeds_cap: discountCheck.exceedsCap,
            exceeds_applied: discountCheck.exceedsApplied,
            tool: dispatch?.toolName ?? null,
          },
          'discount_divergence: agent spoke a discount above the cap or above what the link applied',
        );
      }

  log.info(
    {
      text_len: fullText.length,
      tool: dispatch?.toolName ?? null,
      discount: discountAmount ?? undefined,
    },
    'LLM turn processed',
  );
}

/**
 * OpenAI-compatible model listing. Telnyx's Custom LLM portal hits
 * `<base>/models` to populate its model picker — if the request 404s the
 * portal surfaces `Failed to fetch models from external LLM: 404` and forces
 * manual entry. Our handler ignores the `model` field (the brain decides),
 * so any single advertised id will do; pick one descriptive.
 */
async function llmModelsHandler(_req: FastifyRequest, reply: FastifyReply) {
  const created = Math.floor(Date.now() / 1000);
  return reply.send({
    object: 'list',
    data: [
      {
        id: 'serena-converse',
        object: 'model',
        created,
        owned_by: 'serena',
      },
    ],
  });
}

export default async function vapiLlmRoutes(app: FastifyInstance) {
  // Mounted at both paths: the legacy /vapi-llm/* preserves the existing
  // Vapi assistant config without touching the portal, and /llm/* is the
  // provider-agnostic canonical name that Telnyx assistants point at.
  app.post('/vapi-llm/chat/completions', llmCompletionsHandler);
  app.post('/llm/chat/completions', llmCompletionsHandler);
  app.get('/vapi-llm/models', llmModelsHandler);
  app.get('/llm/models', llmModelsHandler);
}
