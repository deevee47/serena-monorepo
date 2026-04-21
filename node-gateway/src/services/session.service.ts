import { redis } from '../lib/redis.js';
import { ConversationStage } from '../types/session.types.js';
import type { CallSession, ConversationTurn, SessionCreateInput } from '../types/session.types.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

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
    objectionsEncountered: [],
    conversationHistory: [],
    turnCount: 0,
    currentProductId: input.productId,
    closeAttempted: false,
    followUpRequested: false,
    followUpNote: null,
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
  await redis.expire(key(callId), SESSION_TTL);
  return deserialize(raw as string);
}

export async function getSessionOrThrow(callId: string): Promise<CallSession> {
  const session = await getSession(callId);
  if (!session) {
    throw new AppError(404, ErrorCodes.SESSION_NOT_FOUND, `Session not found for call ${callId}`);
  }
  return session;
}

export async function updateSession(callId: string, updates: Partial<CallSession>): Promise<CallSession> {
  // GET-merge-SET is not atomic.
  // TODO: Use Redis MULTI/EXEC or Lua script for atomicity in multi-instance deployment.
  const session = await getSessionOrThrow(callId);
  const updated: CallSession = { ...session, ...updates, lastUpdatedAt: new Date() };
  await redis.set(key(callId), serialize(updated), 'EX', SESSION_TTL);
  return updated;
}

export async function appendTurn(callId: string, turn: ConversationTurn): Promise<void> {
  const session = await getSessionOrThrow(callId);
  const updated: CallSession = {
    ...session,
    conversationHistory: [...session.conversationHistory, turn],
    turnCount: session.turnCount + 1,
    lastUpdatedAt: new Date(),
  };
  await redis.set(key(callId), serialize(updated), 'EX', SESSION_TTL);
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
