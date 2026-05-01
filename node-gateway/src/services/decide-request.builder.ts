import type { ConversationStage, ObjectionType } from '../types/session.types.js';

// Local definition matches DecideRequest in brain.service.ts; kept inline so
// this module has zero runtime dependency on brain.service (which transitively
// loads env config, breaking unit tests).
export interface DecideRequest {
  call_id: string;
  objection_type: (typeof ObjectionType)[keyof typeof ObjectionType] | null;
  objection_subtype?: string | null;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  stage: ConversationStage;
  score: number;
  turn_count: number;
  prior_objection_types: (typeof ObjectionType)[keyof typeof ObjectionType][];
  discounts_offered: number[];
  has_alternative_product: boolean;
}

/**
 * Build the DecideRequest payload from live session state plus the latest
 * classification. Pure function — no I/O, no env, no transitive imports —
 * so it's trivially unit-testable.
 */
export function buildDecideRequest(args: {
  callId: string;
  classification: {
    objection_type: (typeof ObjectionType)[keyof typeof ObjectionType];
    sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    subtype?: string | null;
  };
  stage: ConversationStage;
  score: number;
  turnCount: number;
  priorObjections: (typeof ObjectionType)[keyof typeof ObjectionType][];
  discountsOffered: number[];
  hasAlternativeProduct: boolean;
}): DecideRequest {
  return {
    call_id: args.callId,
    objection_type: args.classification.objection_type,
    objection_subtype: args.classification.subtype ?? null,
    sentiment: args.classification.sentiment,
    stage: args.stage,
    score: args.score,
    turn_count: args.turnCount,
    prior_objection_types: args.priorObjections,
    discounts_offered: args.discountsOffered,
    has_alternative_product: args.hasAlternativeProduct,
  };
}
