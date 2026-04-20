import { ObjectionType } from '../types/session.types.js';
import type { CallSession } from '../types/session.types.js';

export type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';

// Tune based on real call outcome data after 100 calls
const SCORE_DELTAS: Record<ObjectionType, number> = {
  PRICE: -15,         // tune after 100 calls
  TRUST: -20,         // tune after 100 calls
  CONFUSION: -10,     // tune after 100 calls
  TIMING: -12,        // tune after 100 calls
  POSITIVE_SIGNAL: 12, // tune after 100 calls
  NEUTRAL: 0,         // tune after 100 calls
};

const REPEAT_PENALTY = -10; // tune after 100 calls

export function isRepeatObjection(session: CallSession, objectionType: ObjectionType): boolean {
  return session.objectionsEncountered.includes(objectionType);
}

export function applyScoreDelta(currentScore: number, delta: number): number {
  return Math.round(Math.max(0, Math.min(100, currentScore + delta)));
}

export function calculateScoreAfterTurn(
  session: CallSession,
  objectionType: ObjectionType,
  sentiment: Sentiment = 'NEUTRAL',
): number {
  let delta = SCORE_DELTAS[objectionType];

  if (isRepeatObjection(session, objectionType)) {
    delta += REPEAT_PENALTY;
  }

  // Positive sentiment halves negative deltas only — never amplifies positive ones
  if (sentiment === 'POSITIVE' && delta < 0) {
    delta = Math.ceil(delta / 2);
  }

  return applyScoreDelta(session.score, delta);
}

export function getScoreCategory(score: number): 'HOT' | 'WARM' | 'COLD' | 'LOST' {
  if (score >= 70) return 'HOT';
  if (score >= 45) return 'WARM';
  if (score >= 20) return 'COLD';
  return 'LOST';
}

export function shouldEscalateDiscount(session: CallSession): boolean {
  const category = getScoreCategory(session.score);
  const lastObjection = session.objectionsEncountered[session.objectionsEncountered.length - 1];
  return (
    (category === 'COLD' || category === 'LOST') &&
    lastObjection === ObjectionType.PRICE &&
    session.discountsOffered.length < 2
  );
}
