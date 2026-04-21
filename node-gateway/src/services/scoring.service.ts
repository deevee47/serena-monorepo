import { ObjectionType } from '../types/session.types.js';
import type { CallSession } from '../types/session.types.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';

export type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';

// Hardcoded fallbacks used when scoring_config table has no row for a given key
const SCORE_DELTAS: Record<ObjectionType, number> = {
  PRICE: -15,
  TRUST: -20,
  CONFUSION: -10,
  TIMING: -12,
  POSITIVE_SIGNAL: 12,
  NEUTRAL: 0,
};

const REPEAT_PENALTY = -10;
const REPEAT_PENALTY_TYPES: ReadonlySet<ObjectionType> = new Set([
  ObjectionType.PRICE,
  ObjectionType.TRUST,
  ObjectionType.CONFUSION,
  ObjectionType.TIMING,
]);

const DB_KEY: Record<ObjectionType, string> = {
  PRICE: 'delta_price',
  TRUST: 'delta_trust',
  CONFUSION: 'delta_confusion',
  TIMING: 'delta_timing',
  POSITIVE_SIGNAL: 'delta_positive_signal',
  NEUTRAL: 'delta_neutral',
};
const REPEAT_PENALTY_DB_KEY = 'repeat_penalty';

const configCache = new Map<string, number>();

async function loadScoringConfig(): Promise<void> {
  try {
    const rows = await prisma.scoringConfig.findMany();
    for (const row of rows) {
      configCache.set(row.key, Number(row.value));
    }
    logger.debug({ keys: rows.map((r) => r.key) }, 'Scoring config refreshed');
  } catch (err) {
    logger.error({ err }, 'Failed to load scoring config from DB — using cached/hardcoded values');
  }
}

export async function refreshScoringConfig(): Promise<void> {
  await loadScoringConfig();
}

export async function initScoringConfig(): Promise<void> {
  await loadScoringConfig();
  setInterval(() => { void loadScoringConfig(); }, 5 * 60 * 1000);
}

function getDelta(objectionType: ObjectionType): number {
  return configCache.get(DB_KEY[objectionType]) ?? SCORE_DELTAS[objectionType];
}

function getRepeatPenalty(): number {
  return configCache.get(REPEAT_PENALTY_DB_KEY) ?? REPEAT_PENALTY;
}

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
  let delta = getDelta(objectionType);

  if (REPEAT_PENALTY_TYPES.has(objectionType) && isRepeatObjection(session, objectionType)) {
    delta += getRepeatPenalty();
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
