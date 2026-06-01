import { redis } from '../lib/redis.js';
import { withKeyLock } from '../lib/key-mutex.js';
import { ConversationStage } from '../types/session.types.js';
import type { CallSession, ConversationTurn, SessionCreateInput } from '../types/session.types.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { createCallRecord } from './db.service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';

const DEFAULT_PRODUCT_ID = 'prod-001';

const SESSION_TTL = 7200; // 2 hours
const key = (callId: string) => `session:${callId}`;

// Serialized form — Date fields stored as ISO strings
type SerializedTurn = Omit<ConversationTurn, 'timestamp'> & { timestamp: string };
type SerializedSession = Omit<CallSession, 'createdAt' | 'lastUpdatedAt' | 'conversationHistory'> & {
  createdAt: string;
  lastUpdatedAt: string;
  conversationHistory: SerializedTurn[];
};

function serialize(session: CallSession): string {
  const s: SerializedSession = {
    ...session,
    createdAt: session.createdAt.toISOString(),
    lastUpdatedAt: session.lastUpdatedAt.toISOString(),
    conversationHistory: session.conversationHistory.map((t) => ({
      ...t,
      timestamp: t.timestamp.toISOString(),
    })),
  };
  return JSON.stringify(s);
}

function deserialize(raw: string): CallSession {
  const s = JSON.parse(raw) as SerializedSession;
  return {
    ...s,
    createdAt: new Date(s.createdAt),
    lastUpdatedAt: new Date(s.lastUpdatedAt),
    conversationHistory: s.conversationHistory.map((t) => ({
      ...t,
      timestamp: new Date(t.timestamp),
    })),
  };
}

export async function createSession(input: SessionCreateInput): Promise<CallSession> {
  const now = new Date();
  const session: CallSession = {
    callId: input.callId,
    phoneNumber: input.phoneNumber,
    productId: input.productId,
    stage: ConversationStage.INTRO,
    score: 50,
    discountsOffered: [],
    pushAttempt: 0,
    objectionsEncountered: [],
    conversationHistory: [],
    turnCount: 0,
    currentProductId: input.productId,
    closeAttempted: false,
    followUpRequested: false,
    followUpNote: null,
    lastAgentFinishedAt: null,
    createdAt: now,
    lastUpdatedAt: now,
    isActive: true,
  };
  await redis.set(key(input.callId), serialize(session), 'EX', SESSION_TTL);
  return session;
}

export async function getSession(callId: string): Promise<CallSession | null> {
  const raw = await redis.get(key(callId));
  if (!raw) return null;
  // No EXPIRE-on-read: every mutation (createSession/mutateSession) already
  // rewrites the key with the full TTL, and a live call writes on every turn,
  // so an active session's TTL is continually refreshed. A read-side slide is
  // a redundant Redis round-trip on the hot path (getSession runs several
  // times per turn). Calls are minutes; the 2h TTL won't lapse mid-call.
  return deserialize(raw as string);
}

export async function getSessionOrThrow(callId: string): Promise<CallSession> {
  const session = await getSession(callId);
  if (!session) {
    throw new AppError(404, ErrorCodes.SESSION_NOT_FOUND, `Session not found for call ${callId}`);
  }
  return session;
}

/**
 * Atomic read-modify-write for a session. The whole GET → apply → SET runs
 * inside a per-call lock so concurrent turns can't interleave and lose an
 * update (e.g. one turn's pushAttempt/turnCount increment clobbering another's
 * — see `lib/key-mutex.ts`). `mutator` is called exactly once with the freshly
 * read session and returns the fields to merge.
 */
export async function mutateSession(
  callId: string,
  mutator: (current: CallSession) => Partial<CallSession>,
): Promise<CallSession> {
  return withKeyLock(key(callId), async () => {
    const session = await getSessionOrThrow(callId);
    const updated: CallSession = { ...session, ...mutator(session), lastUpdatedAt: new Date() };
    await redis.set(key(callId), serialize(updated), 'EX', SESSION_TTL);
    return updated;
  });
}

export async function updateSession(callId: string, updates: Partial<CallSession>): Promise<CallSession> {
  return mutateSession(callId, () => updates);
}

export async function appendTurn(callId: string, turn: ConversationTurn): Promise<void> {
  await mutateSession(callId, (session) => ({
    conversationHistory: [...session.conversationHistory, turn],
    turnCount: session.turnCount + 1,
  }));
}

export async function getRecentHistory(callId: string, n: number = 4): Promise<ConversationTurn[]> {
  const session = await getSessionOrThrow(callId);
  return session.conversationHistory.slice(-n);
}

export async function endSession(callId: string): Promise<CallSession> {
  return updateSession(callId, { isActive: false });
}

export async function deleteSession(callId: string): Promise<void> {
  await redis.del(key(callId));
}

export interface EnsureSessionResult {
  session: CallSession;
  isNew: boolean;
  /**
   * True iff the product was supplied via /calls/trigger's pending_call entry
   * or via webhook/LLM-envelope metadata. False when we defaulted because
   * neither source provided one. For existing sessions where the original
   * source is unknown, returns false — callers that gate behavior on this
   * (e.g. the LLM endpoint's primary-product override) should additionally
   * check `session.currentProductId === DEFAULT_PRODUCT_ID`.
   */
  productFromTrigger: boolean;
}

/**
 * Idempotent session lookup-or-create for a call.
 *
 * Used both by webhook handlers (eagerly creating on call.started) and by the
 * LLM endpoint (lazy create when no prior init event arrived — typical for
 * outbound where the provider doesn't fire an init webhook before the first
 * LLM turn). Uses a short-lived Redis lock so a race between those two paths
 * doesn't produce two sessions.
 *
 * Resolution order for the product:
 *   1. `pending_call:{callId}` written by /calls/trigger (~60s TTL)
 *   2. `metadataProductId` supplied by the caller
 *   3. DEFAULT_PRODUCT_ID
 */
export async function ensureSessionForCall(params: {
  callId: string;
  phoneNumber: string;
  metadataProductId: string | null;
  /** Provider that actually initiated this call. Falls back to the global
   *  env default when omitted (legacy callers). Threaded through so a
   *  Vapi-initiated call doesn't get tagged "telnyx" just because the env
   *  default points there. */
  voiceProvider?: string;
}): Promise<EnsureSessionResult> {
  const { callId, phoneNumber, metadataProductId, voiceProvider } = params;

  const existing = await getSession(callId);
  if (existing) {
    return { session: existing, isNew: false, productFromTrigger: false };
  }

  const lockKey = `session_init_lock:${callId}`;
  const acquired = await redis
    .set(lockKey, '1', 'NX', 'EX', '5')
    .catch(() => null);
  if (acquired !== 'OK') {
    // Another worker may be creating right now. Brief retry-read window.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const s = await getSession(callId);
      if (s) return { session: s, isNew: false, productFromTrigger: false };
    }
    // Fall through and create anyway — lock may be stale (holder crashed).
  }

  let productId = DEFAULT_PRODUCT_ID;
  let productFromTrigger = false;
  try {
    const raw = await redis.get(`pending_call:${callId}`);
    if (raw) {
      try {
        const pending = JSON.parse(raw as string) as { productId?: string };
        if (typeof pending.productId === 'string' && pending.productId.length > 0) {
          productId = pending.productId;
          productFromTrigger = true;
        }
      } catch {
        // Malformed pending entry — fall through to metadata/default.
      }
    }
    if (!productFromTrigger && metadataProductId && metadataProductId.length > 0) {
      productId = metadataProductId;
      productFromTrigger = true;
    }
  } catch (err) {
    logger.error(
      { err, callId },
      'pending_call lookup failed in ensureSessionForCall — using metadata or default',
    );
    if (metadataProductId && metadataProductId.length > 0) {
      productId = metadataProductId;
      productFromTrigger = true;
    }
  }

  const session = await createSession({ callId, phoneNumber, productId });

  createCallRecord(session, voiceProvider ?? config.VOICE_PROVIDER).catch((err) =>
    logger.error({ err, callId }, 'createCallRecord failed in ensureSessionForCall'),
  );

  return { session, isNew: true, productFromTrigger };
}
