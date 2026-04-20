import { prisma } from '../lib/prisma.js';
import type { CallSession } from '../types/session.types.js';

export interface CallTurnData {
  turnNumber: number;
  speaker: 'USER' | 'AGENT';
  utterance: string;
  objectionType?: string;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  scoreBefore: number;
  scoreAfter: number;
  stage: string;
  discountOffered?: number;
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

export async function insertCallTurn(callId: string, turn: CallTurnData): Promise<void> {
  await prisma.callTurn.create({
    data: {
      callId,
      turnNumber: turn.turnNumber,
      speaker: turn.speaker,
      utterance: turn.utterance,
      objectionType: turn.objectionType,
      sentiment: turn.sentiment,
      scoreBefore: turn.scoreBefore,
      scoreAfter: turn.scoreAfter,
      stage: turn.stage,
      discountOffered: turn.discountOffered,
    },
  });
}
