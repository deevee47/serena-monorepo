import type { CallSession } from '../types/session.types.js';
import { appendTurn, getSession, updateSession } from './session.service.js';
import type { RecentUserSignalsPayload } from './brain.service.js';
import { insertCallTurn } from './db.service.js';
import { classifyAnalyticsQueue } from '../queues/index.js';
import type { DispatchResult } from './converse-dispatcher.js';
import { createCallLogger } from '../utils/logger.js';

const MAX_PUSH_ATTEMPT = 5;

/** Cheap text match for the soft-no signals enumerated in the brain prompt's
 *  PERSISTENT PROBE list. Used to decide whether the agent's response on this
 *  turn is a real push (reacting to rejection) vs. a pure clarification. */
const SOFT_NO_PATTERNS =
  /\b(no|not\s+interested|just\s+browsing|just\s+looking|maybe\s+later|not\s+sure|not\s+now|nahin|nahi|nahi\s+chahiye|mat\s+karo|mat\s+bhejo|baad\s+mein|baad\s+me|abhi\s+nahi)\b/i;

/** Decide whether the AGENT turn we're about to persist counts as a real
 *  persuasion push. Only real pushes burn an attempt — pure clarifications,
 *  acknowledgments, and answers to factual questions leave the counter alone.
 *
 *  Heuristic (intentionally generous to avoid undercount-then-over-exit):
 *    - The agent fired any observation tool (brought new info) → push
 *    - The agent offered a discount on this turn → push
 *    - The agent fired a graceful-exit tool → push (this is exit, count it)
 *    - The just-said USER turn contains a soft-no signal → push (agent is
 *      pushing back against rejection regardless of tool use, e.g. a
 *      diagnostic question like "what's holding you back?")
 *    - Recent USER sentiment streak is NEGATIVE → push (same logic)
 *    - Repeated objection just surfaced → push (switching tactic)
 *
 *  Everything else (small talk, factual answer, identity clarification on
 *  early turns) leaves push_attempt unchanged.
 */
function isRealPush(args: {
  isOpener: boolean;
  dispatch: DispatchResult | null;
  observations?: Array<{ name: string }>;
  discountAmount: number | null;
  currentUserUtterance: string;
  recentSignals?: RecentUserSignalsPayload | null;
}): boolean {
  const { isOpener, dispatch, observations, discountAmount, currentUserUtterance, recentSignals } = args;
  if (isOpener) return false;
  if (observations && observations.length > 0) return true;
  if (dispatch?.toolName) return true;
  if ((discountAmount ?? 0) > 0) return true;
  if (currentUserUtterance && SOFT_NO_PATTERNS.test(currentUserUtterance)) return true;
  const sentiments = recentSignals?.sentiments ?? [];
  const lastSentiment = sentiments.length > 0 ? sentiments[sentiments.length - 1] : null;
  if (lastSentiment === 'NEGATIVE') return true;
  if (recentSignals?.repeated_objection) return true;
  return false;
}

/**
 * Persist Vapi's locally-spoken first message (the assistant `firstMessage`
 * in the assistant config) as AGENT turn 1, exactly once per call. Vapi
 * TTSes that line itself and never round-trips it through our LLM endpoint,
 * so without this hook the opener is invisible to the dashboard + the
 * persistence-counter math. Detection is by inspecting `body.messages` on
 * the FIRST `/llm/chat/completions` call — any assistant message that lands
 * there before the user spoke is treated as the opener.
 */
export async function persistOpenerIfMissing(
  callId: string,
  openerText: string,
): Promise<void> {
  if (!openerText.trim()) return;
  const session = await getSession(callId);
  if (!session) return;
  // turnCount > 0 means we already persisted something for this call; nothing
  // to backfill. The check here is cheap and keeps the function idempotent
  // even if the caller's session snapshot was slightly stale.
  if (session.turnCount > 0) return;

  const now = new Date();
  await appendTurn(callId, { speaker: 'AGENT', utterance: openerText, timestamp: now });
  // Best-effort Postgres insert. If a race puts a turn 1 here from somewhere
  // else, the unique-ish (callId, turnNumber) collision will surface as a
  // log line — the live conversation continues either way.
  insertCallTurn(callId, {
    turnNumber: 1,
    speaker: 'AGENT',
    utterance: openerText,
    // No pushAttempt — opener never burns one.
  }).catch((err) =>
    createCallLogger(callId).warn({ err }, 'persistOpenerIfMissing: insertCallTurn failed'),
  );
}

/**
 * Persist a USER/AGENT turn pair from one conversation round to Redis
 * (in-memory dialog) and Postgres (audit trail), enqueue async classify
 * for the USER turn, and update the session's discounts-offered set when
 * the checkout tool fired.
 *
 * Also derives the new turn-quality signals:
 *   - pushAttempt: incremented for "selling" turns (no side-effect tool),
 *     reset on checkout. The opener (turnCount===0) does not burn an
 *     attempt. Capped at MAX_PUSH_ATTEMPT.
 *   - userResponseLatencyMs persisted on the USER row.
 *   - observationLatenciesMs persisted on the AGENT row.
 *
 * Fire-and-forget except for the session updates. The Postgres writes and
 * queue add are intentionally off the response path so a slow DB doesn't
 * block the next TTS chunk.
 */
export async function persistTurnPair(params: {
  callId: string;
  session: CallSession;
  utterance: string;
  agentText: string;
  dispatch: DispatchResult | null;
  /** Observation-tool invocations that ran during this AGENT turn (e.g.
   *  list_products, get_offer). Persisted on the agent CallTurn so the
   *  dashboard's LiveTail can render an observation chip per invocation. */
  observations?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>;
  /** Pre-response latency on this USER turn (ms). Null on the first turn. */
  userResponseLatencyMs?: number | null;
  /** Per-observation tool-call latency for this AGENT turn. */
  observationLatenciesMs?: Array<{ name: string; ms: number }> | null;
  /** The same snapshot we passed into the brain on this turn — feeds the
   *  push-attempt heuristic so reactive turns count and clarifications don't. */
  recentSignals?: RecentUserSignalsPayload | null;
}): Promise<void> {
  const {
    callId,
    session,
    utterance,
    agentText,
    dispatch,
    observations,
    userResponseLatencyMs,
    observationLatenciesMs,
    recentSignals,
  } = params;
  const log = createCallLogger(callId);

  // Compute next pushAttempt. Opener doesn't count. Checkout resets. Otherwise
  // only increment when the agent actually pushed — see isRealPush() for the
  // full heuristic. Pure clarifications / acknowledgments leave the counter
  // unchanged so PUSH chips reflect real persuasion attempts.
  const isOpener = session.turnCount === 0;
  const checkoutFired = dispatch?.toolName === 'send_whatsapp_checkout_link';
  const discountAmount = checkoutFired
    ? ((dispatch?.appliedArgs['discount_percent'] as number | undefined) ?? 0)
    : 0;
  let nextPushAttempt: number;
  if (checkoutFired) {
    nextPushAttempt = 0;
  } else if (isOpener) {
    nextPushAttempt = 0;
  } else if (
    isRealPush({
      isOpener,
      dispatch,
      observations,
      discountAmount,
      currentUserUtterance: utterance,
      recentSignals,
    })
  ) {
    nextPushAttempt = Math.min(MAX_PUSH_ATTEMPT, session.pushAttempt + 1);
  } else {
    nextPushAttempt = session.pushAttempt;
  }
  const agentTurnPushAttempt = nextPushAttempt > 0 ? nextPushAttempt : null;

  // Track checkout-link discount on session so the next prompt knows the LLM
  // already offered that tier and shouldn't repeat it.
  const sessionUpdates: Partial<CallSession> = { pushAttempt: nextPushAttempt };
  if (checkoutFired) {
    const offered = (dispatch?.appliedArgs['discount_percent'] as number | undefined) ?? 0;
    if (offered > 0 && !session.discountsOffered.includes(offered)) {
      sessionUpdates.discountsOffered = [...session.discountsOffered, offered];
    }
  }
  await updateSession(callId, sessionUpdates);

  const now = new Date();
  await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now });
  await appendTurn(callId, { speaker: 'AGENT', utterance: agentText, timestamp: new Date() });

  insertCallTurn(callId, {
    turnNumber: session.turnCount + 1,
    speaker: 'USER',
    utterance,
    responseLatencyMs: userResponseLatencyMs ?? null,
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

  insertCallTurn(callId, {
    turnNumber: session.turnCount + 2,
    speaker: 'AGENT',
    utterance: agentText,
    toolCalled: dispatch?.toolName ?? null,
    toolArgs: dispatch?.appliedArgs ?? null,
    discountOffered: discountAmount > 0 ? discountAmount : null,
    observationsCalled: observations && observations.length > 0 ? observations : null,
    pushAttempt: agentTurnPushAttempt,
    observationLatenciesMs:
      observationLatenciesMs && observationLatenciesMs.length > 0
        ? observationLatenciesMs
        : null,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));
}
