import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import type { CallSession } from '../types/session.types.js';
import type {
  CartContextPayload,
  CustomerContextPayload,
  CustomerSegment,
  RecentUserSignalsPayload,
} from './brain.service.js';

export interface CallTurnData {
  turnNumber: number;
  speaker: 'USER' | 'AGENT';
  utterance: string;
  objectionType?: string | null;
  objectionSubtype?: string | null;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  discountOffered?: number | null;
  // Side-effect tool attribution. Only set on AGENT turns when the LLM
  // picked a tool. Null for text-only turns and USER turns.
  toolCalled?: string | null;
  toolArgs?: Record<string, unknown> | null;
  // Read-only tool invocations (list_products, get_offer, etc.) the brain
  // ran during this AGENT turn. Stored as JSON array; the SSE route emits
  // one `observation` event per entry, which the LiveTail folds into the
  // turn as observation chips.
  observationsCalled?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }> | null;
  // Turn-quality signals (migration 20260522120000).
  pushAttempt?: number | null;          // AGENT turns only — 1..5
  responseLatencyMs?: number | null;    // USER turns only — ms
  observationLatenciesMs?: Array<{ name: string; ms: number }> | null;
}

export interface CallTurnAnalyticsUpdate {
  objectionType?: string | null;
  objectionSubtype?: string | null;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
}

export interface CallEndUpdate {
  endedAt?: Date;
  durationSeconds?: number;
  outcome?: 'CONVERTED' | 'DROPPED' | 'NO_ANSWER' | 'ERROR';
  discountGiven?: number;
}

export async function createCallRecord(
  session: CallSession,
  voiceProvider?: string,
): Promise<void> {
  await prisma.call.create({
    data: {
      callId: session.callId,
      phoneNumber: session.phoneNumber,
      productId: session.productId,
      voiceProvider: voiceProvider ?? null,
    },
  });
}

export async function updateCallRecord(callId: string, updates: CallEndUpdate): Promise<void> {
  try {
    await prisma.call.update({
      where: { callId },
      data: updates,
    });
  } catch (err) {
    // P2025: Call row missing — usually an orphan call-end job from a run
    // where assistant-request never landed. Log and skip rather than retry
    // forever; there's no row to update and never will be.
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2025') {
      return;
    }
    throw err;
  }
}

export async function insertCallTurn(callId: string, turn: CallTurnData): Promise<string> {
  const created = await prisma.callTurn.create({
    data: {
      callId,
      turnNumber: turn.turnNumber,
      speaker: turn.speaker,
      utterance: turn.utterance,
      objectionType: turn.objectionType ?? null,
      objectionSubtype: turn.objectionSubtype ?? null,
      sentiment: turn.sentiment ?? null,
      discountOffered: turn.discountOffered ?? null,
      toolCalled: turn.toolCalled ?? null,
      toolArgs: (turn.toolArgs ?? null) as never,
      observationsCalled: (turn.observationsCalled ?? null) as never,
      pushAttempt: turn.pushAttempt ?? null,
      responseLatencyMs: turn.responseLatencyMs ?? null,
      observationLatenciesMs: (turn.observationLatenciesMs ?? null) as never,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Update objection_type / subtype / sentiment on an existing CallTurn row.
 * Used by the classify-analytics worker after the conversational turn has
 * already been persisted.
 */
export async function updateCallTurnAnalytics(
  callTurnId: string,
  updates: CallTurnAnalyticsUpdate,
): Promise<void> {
  await prisma.callTurn.update({
    where: { id: callTurnId },
    data: {
      objectionType: updates.objectionType ?? null,
      objectionSubtype: updates.objectionSubtype ?? null,
      sentiment: updates.sentiment ?? null,
    },
  });
}

/** Bump prior_calls_count for whichever Customer matches this phone, if any.
 *  Best-effort — anonymous callers / unknown numbers just get skipped. */
export async function incrementCustomerCallsCount(phoneNumber: string): Promise<void> {
  if (!phoneNumber || phoneNumber === 'unknown') return;
  await prisma.customer.updateMany({
    where: { phone: phoneNumber },
    data: { priorCallsCount: { increment: 1 } },
  });
}

/** Load the customer profile + most-recent abandoned cart for an inbound
 *  phone number. Returns nulls when the caller is unknown — the brain's
 *  prompt builder degrades gracefully (treats them as a first-time visitor).
 *
 *  Mirrors the lookup pattern in scripts/interactive-cli.py:128-180 so the
 *  live Vapi flow gets the same context the type-and-talk CLI does. */
export interface LoadedCallContext {
  customer: CustomerContextPayload | null;
  cart: CartContextPayload | null;
  /** First product in the abandoned cart — used to seed product_context
   *  when the call wasn't triggered with an explicit product_id. */
  primaryProductId: string | null;
}

const CALL_CONTEXT_TTL_SECONDS = 1800;

/**
 * Per-call cache of customer + cart context. The underlying loadCallContext
 * hits Postgres for one customer row, up-to-5 purchases, and the active
 * abandoned cart — too expensive to repeat on every turn. Cache for the
 * call's lifetime (30 min TTL covers the longest realistic call).
 *
 * Errors are swallowed and a null context is returned: the brain's prompt
 * builder degrades gracefully when customer/cart are missing.
 */
export async function getCachedCallContext(
  callId: string,
  phoneNumber: string,
): Promise<LoadedCallContext> {
  const ctxKey = `call_ctx:${callId}`;
  const cached = await redis.get(ctxKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached as string) as LoadedCallContext;
    } catch {
      // Malformed cache entry — fall through and re-load.
    }
  }
  const loaded = await loadCallContext(phoneNumber).catch(
    () => ({ customer: null, cart: null, primaryProductId: null } as LoadedCallContext),
  );
  await redis.setex(ctxKey, CALL_CONTEXT_TTL_SECONDS, JSON.stringify(loaded)).catch(() => {});
  return loaded;
}

export async function loadCallContext(phoneNumber: string): Promise<LoadedCallContext> {
  if (!phoneNumber || phoneNumber === 'unknown') {
    return { customer: null, cart: null, primaryProductId: null };
  }

  const customerRow = await prisma.customer.findUnique({ where: { phone: phoneNumber } });
  if (!customerRow) {
    return { customer: null, cart: null, primaryProductId: null };
  }

  const purchases = await prisma.purchase.findMany({
    where: { customerId: customerRow.id },
    orderBy: { purchasedAt: 'desc' },
    take: 5,
    include: { product: true },
  });
  const now = new Date();
  const pastOrders = purchases
    .filter((p) => p.product !== null)
    .map((p) => ({
      product_id: p.product!.id,
      product_name: p.product!.name,
      price: Number(p.price),
      days_ago: Math.max(0, Math.floor((now.getTime() - p.purchasedAt.getTime()) / 86_400_000)),
    }));

  const customer: CustomerContextPayload = {
    phone: customerRow.phone,
    name: customerRow.name,
    email: customerRow.email,
    segment: customerRow.segment as CustomerSegment,
    lifetime_value: Number(customerRow.lifetimeValue),
    prior_calls_count: customerRow.priorCallsCount,
    timezone: customerRow.timezone,
    preferred_contact: customerRow.preferredContact,
    past_orders: pastOrders,
  };

  const cartRow = await prisma.cart.findFirst({
    where: { customerId: customerRow.id, status: 'ABANDONED' },
    orderBy: { abandonedAt: 'desc' },
    include: { items: { include: { product: true } } },
  });

  if (!cartRow || cartRow.items.length === 0) {
    return { customer, cart: null, primaryProductId: null };
  }

  let total = 0;
  let primaryProductId: string | null = null;
  const items = cartRow.items
    .filter((it) => it.product !== null)
    .map((it) => {
      const priceAtAdd = Number(it.priceAtAdd);
      total += priceAtAdd * it.quantity;
      if (primaryProductId === null) primaryProductId = it.product!.id;
      return {
        product_id: it.product!.id,
        name: it.product!.name,
        price: priceAtAdd,
        quantity: it.quantity,
      };
    });

  const abandonedMinutesAgo =
    cartRow.abandonedAt !== null
      ? Math.max(0, Math.floor((now.getTime() - cartRow.abandonedAt.getTime()) / 60_000))
      : null;

  const cart: CartContextPayload = {
    items,
    total: Math.round(total * 100) / 100,
    abandoned_minutes_ago: abandonedMinutesAgo,
  };

  return { customer, cart, primaryProductId };
}

/** Read the last n USER turns and derive a small RecentUserSignals snapshot
 *  the brain can react to. The classifier-analytics worker writes
 *  `sentiment` + `objectionType` async — by turn N+1, turn N-1's tags are
 *  usually in place. Missing values just degrade the signal, never block.
 *
 *  Also surfaces the most recent USER `responseLatencyMs` (set by the
 *  gateway from provider webhook timestamps when available) so the prompt
 *  can fold pre-response latency into its adaptive behavior. */
export async function getRecentTurnSignals(
  callId: string,
  n: number = 3,
): Promise<RecentUserSignalsPayload> {
  const rows = await prisma.callTurn.findMany({
    where: { callId, speaker: 'USER' },
    orderBy: { turnNumber: 'desc' },
    take: n,
    select: {
      utterance: true,
      sentiment: true,
      objectionType: true,
      responseLatencyMs: true,
    },
  });

  // Reverse so callers see oldest-first (the natural reading order).
  const ordered = rows.reverse();
  const sentiments = ordered
    .map((r) => r.sentiment)
    .filter((s): s is 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' => s !== null);

  // Same objection_type on the most recent two USER turns => last response
  // didn't land. Surface so the prompt can switch tactic.
  let repeatedObjection: string | null = null;
  if (ordered.length >= 2) {
    const last = ordered[ordered.length - 1]?.objectionType;
    const prev = ordered[ordered.length - 2]?.objectionType;
    if (last && prev && last === prev) repeatedObjection = last;
  }

  // Filler density + length trend reuse the existing `signals.py` pattern,
  // implemented locally to avoid a brain roundtrip.
  const utterances = ordered.map((r) => r.utterance);
  const fillerDensity = computeFillerDensity(utterances);
  const lengthTrend = computeUtteranceLengthTrend(utterances);

  // Most recent user latency — the one that just landed, if we measured it.
  const latestLatency =
    ordered.length > 0 ? ordered[ordered.length - 1]?.responseLatencyMs ?? null : null;

  return {
    sentiments,
    filler_density: fillerDensity,
    length_trend: lengthTrend,
    repeated_objection: repeatedObjection,
    response_latency_ms: latestLatency,
    // push_attempt is layered in by the caller from session state — this
    // function doesn't know which AGENT turns "burned" an attempt and which
    // were FAST_TRACK confirmations.
  };
}

const FILLER_TOKENS = new Set(['uh', 'um', 'uhh', 'ehh', 'like', 'i', 'guess']);
const FILLER_PHRASES = ['i guess', 'you know', 'kind of', 'sort of', 'i mean'];

function computeFillerDensity(utterances: string[]): number | null {
  if (utterances.length === 0) return null;
  let totalTokens = 0;
  let fillerCount = 0;
  for (const u of utterances) {
    let text = u.toLowerCase();
    for (const phrase of FILLER_PHRASES) {
      const occurrences = text.split(phrase).length - 1;
      fillerCount += occurrences;
      text = text.split(phrase).join(' ');
    }
    const tokens = text
      .split(/\s+/)
      .map((t) => t.replace(/[.,!?;:]/g, ''))
      .filter(Boolean);
    totalTokens += tokens.length;
    for (const tok of tokens) if (FILLER_TOKENS.has(tok)) fillerCount += 1;
  }
  if (totalTokens === 0) return 0;
  return Math.min(1, fillerCount / totalTokens);
}

function computeUtteranceLengthTrend(utterances: string[]): number | null {
  if (utterances.length < 2) return null;
  const lengths = utterances.map((u) => u.split(/\s+/).filter(Boolean).length);
  const n = lengths.length;
  const meanX = (n - 1) / 2;
  const meanY = lengths.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    const li = lengths[i] ?? 0;
    cov += (i - meanX) * (li - meanY);
    varX += (i - meanX) ** 2;
  }
  if (varX === 0) return 0;
  return cov / varX;
}

/** Count how many times each side-effect tool fired during the call.
 *  Returns { send_whatsapp_checkout_link: 1, send_whatsapp_product_info: 0 }-shaped object. */
export async function getToolDispatchSummary(callId: string): Promise<Record<string, number>> {
  const rows = await prisma.callTurn.findMany({
    where: { callId, toolCalled: { not: null } },
    select: { toolCalled: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (r.toolCalled) counts[r.toolCalled] = (counts[r.toolCalled] ?? 0) + 1;
  }
  return counts;
}
