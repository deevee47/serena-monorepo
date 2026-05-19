import type { CallSession } from '../types/session.types.js';
import { appendTurn, updateSession } from './session.service.js';
import { insertCallTurn } from './db.service.js';
import { classifyAnalyticsQueue } from '../queues/index.js';
import type { DispatchResult } from './converse-dispatcher.js';
import { createCallLogger } from '../utils/logger.js';

/**
 * Persist a USER/AGENT turn pair from one conversation round to Redis
 * (in-memory dialog) and Postgres (audit trail), enqueue async classify
 * for the USER turn, and update the session's discounts-offered set when
 * the checkout tool fired.
 *
 * Fire-and-forget except for the session/discount update. The Postgres
 * writes and queue add are intentionally off the response path so a slow
 * DB doesn't block the next TTS chunk.
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
}): Promise<void> {
  const { callId, session, utterance, agentText, dispatch, observations } = params;
  const log = createCallLogger(callId);

  // Track checkout-link discount on session so the next prompt knows the LLM
  // already offered that tier and shouldn't repeat it.
  if (dispatch?.toolName === 'send_whatsapp_checkout_link') {
    const offered = (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? 0;
    if (offered > 0 && !session.discountsOffered.includes(offered)) {
      await updateSession(callId, {
        discountsOffered: [...session.discountsOffered, offered],
      });
    }
  }

  const now = new Date();
  await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now });
  await appendTurn(callId, { speaker: 'AGENT', utterance: agentText, timestamp: new Date() });

  // Score/stage no longer drive routing under the converse pipeline, but the
  // columns are still NOT NULL — write stable defaults so analytics queries
  // don't break.
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
    utterance: agentText,
    toolCalled: dispatch?.toolName ?? null,
    toolArgs: dispatch?.appliedArgs ?? null,
    discountOffered: discountAmount,
    observationsCalled: observations && observations.length > 0 ? observations : null,
    ...turnBase,
  }).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));
}
