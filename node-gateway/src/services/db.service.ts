import { prisma } from '../lib/prisma.js';
import type { CallSession } from '../types/session.types.js';

export interface CallTurnData {
  turnNumber: number;
  speaker: 'USER' | 'AGENT';
  utterance: string;
  objectionType?: string | null;
  objectionSubtype?: string | null;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  scoreBefore: number;
  scoreAfter: number;
  stage: string;
  discountOffered?: number | null;
  // Tool attribution under the converse pipeline. Only set on AGENT turns
  // when the LLM picked a tool. Null for text-only turns and USER turns.
  toolCalled?: string | null;
  toolArgs?: Record<string, unknown> | null;
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
  finalScore?: number;
  discountGiven?: number;
  stageReached?: string;
}

export async function createCallRecord(session: CallSession): Promise<void> {
  await prisma.call.create({
    data: {
      callId: session.callId,
      phoneNumber: session.phoneNumber,
      productId: session.productId,
    },
  });
}

export async function updateCallRecord(callId: string, updates: CallEndUpdate): Promise<void> {
  await prisma.call.update({
    where: { callId },
    data: updates,
  });
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
      scoreBefore: turn.scoreBefore,
      scoreAfter: turn.scoreAfter,
      stage: turn.stage,
      discountOffered: turn.discountOffered ?? null,
      toolCalled: turn.toolCalled ?? null,
      toolArgs: (turn.toolArgs ?? null) as never,
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
