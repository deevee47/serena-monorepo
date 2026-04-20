// IMPORTANT: These thresholds encode product and sales strategy assumptions.
// Review and tune after analyzing real call data.
// Consider moving to DB config in v2.

import { ConversationStage, ObjectionType } from '../types/session.types.js';
import type { CallSession } from '../types/session.types.js';

const REAL_OBJECTIONS: ReadonlySet<ObjectionType> = new Set([
  ObjectionType.PRICE,
  ObjectionType.TRUST,
  ObjectionType.CONFUSION,
  ObjectionType.TIMING,
]);

function lastObjection(session: CallSession): ObjectionType | undefined {
  return session.objectionsEncountered[session.objectionsEncountered.length - 1];
}

function hasRealObjection(session: CallSession): boolean {
  const last = lastObjection(session);
  return last !== undefined && REAL_OBJECTIONS.has(last);
}

export function getNextStage(session: CallSession): ConversationStage {
  const { stage, score, turnCount, discountsOffered, closeAttempted } = session;

  switch (stage) {
    case ConversationStage.INTRO:
      return ConversationStage.PITCH;

    case ConversationStage.PITCH:
      if (score >= 80 && turnCount >= 2) return ConversationStage.CLOSE;
      if (score >= 65 && turnCount >= 2 && lastObjection(session) === ObjectionType.PRICE) {
        return ConversationStage.NEGOTIATION;
      }
      if (score < 65 || hasRealObjection(session)) return ConversationStage.OBJECTION;
      return ConversationStage.PITCH;

    case ConversationStage.OBJECTION:
      if (score < 20) return ConversationStage.END;
      if (score >= 40) return ConversationStage.NEGOTIATION;
      return ConversationStage.OBJECTION;

    case ConversationStage.NEGOTIATION:
      if (score >= 60) return ConversationStage.CLOSE;
      if (score < 25 || discountsOffered.length >= 2) return ConversationStage.END;
      return ConversationStage.NEGOTIATION;

    case ConversationStage.CLOSE:
      if (!closeAttempted && hasRealObjection(session)) return ConversationStage.NEGOTIATION;
      return ConversationStage.END;

    case ConversationStage.END:
      return ConversationStage.END;
  }
}

export function shouldTransition(session: CallSession): boolean {
  return getNextStage(session) !== session.stage;
}

export function isTerminalStage(stage: ConversationStage): boolean {
  return stage === ConversationStage.END;
}

export function getStageDescription(stage: ConversationStage): string {
  switch (stage) {
    case ConversationStage.INTRO:
      return 'Introduction — agent opening, establishing context';
    case ConversationStage.PITCH:
      return 'Pitch — presenting product value and benefits';
    case ConversationStage.OBJECTION:
      return 'Objection handling — addressing user concerns';
    case ConversationStage.NEGOTIATION:
      return 'Negotiation — discount offers and trade-offs';
    case ConversationStage.CLOSE:
      return 'Close — finalising the sale';
    case ConversationStage.END:
      return 'End — call concluded';
  }
}
