import { ConversationStage } from '../types/session.types.js';
import type { CallSession, ConversationTurn, SessionCreateInput } from '../types/session.types.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

// TODO: Replace with Redis. Key format: `session:{callId}`. TTL: 1h.
// Serialization: JSON.stringify/parse with Date revival (handle Date fields explicitly).
const sessions = new Map<string, CallSession>();

export function createSession(input: SessionCreateInput): CallSession {
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
  // TODO: Replace with Redis SETEX `session:{callId}` 3600 JSON.stringify(session)
  sessions.set(input.callId, session);
  return session;
}

export function getSession(callId: string): CallSession | null {
  // TODO: Replace with Redis GET `session:{callId}` + JSON.parse with Date revival
  return sessions.get(callId) ?? null;
}

export function getSessionOrThrow(callId: string): CallSession {
  const session = getSession(callId);
  if (!session) {
    throw new AppError(404, ErrorCodes.SESSION_NOT_FOUND, `Session not found for call ${callId}`);
  }
  return session;
}

export function updateSession(callId: string, updates: Partial<CallSession>): CallSession {
  const session = getSessionOrThrow(callId);
  const updated: CallSession = { ...session, ...updates, lastUpdatedAt: new Date() };
  // TODO: Replace with Redis SETEX `session:{callId}` 3600 JSON.stringify(updated)
  sessions.set(callId, updated);
  return updated;
}

export function appendTurn(callId: string, turn: ConversationTurn): void {
  const session = getSessionOrThrow(callId);
  const updated: CallSession = {
    ...session,
    conversationHistory: [...session.conversationHistory, turn],
    turnCount: session.turnCount + 1,
    lastUpdatedAt: new Date(),
  };
  // TODO: Replace with Redis — append to list key `turns:{callId}`, INCR `turncount:{callId}`
  sessions.set(callId, updated);
}

export function getRecentHistory(callId: string, n: number = 4): ConversationTurn[] {
  const session = getSessionOrThrow(callId);
  // TODO: Replace with Redis LRANGE `turns:{callId}` -n -1 + JSON.parse
  return session.conversationHistory.slice(-n);
}

export function endSession(callId: string): CallSession {
  return updateSession(callId, { isActive: false });
}

export function deleteSession(callId: string): void {
  // TODO: Replace with Redis DEL `session:{callId}` `turns:{callId}` `turncount:{callId}`
  sessions.delete(callId);
}
