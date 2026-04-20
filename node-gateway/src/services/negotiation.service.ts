import { ConversationStage, ObjectionType } from '../types/session.types.js';
import type { CallSession } from '../types/session.types.js';

const DISCOUNT_LADDER = [5, 10] as const;
const MAX_DISCOUNT = 10;

export function getAvailableDiscount(session: CallSession): number {
  if (session.discountsOffered.some((d) => d > MAX_DISCOUNT)) {
    console.warn('[negotiation] Discount exceeds MAX_DISCOUNT — safety check triggered', session.discountsOffered);
    return 0;
  }
  if (session.discountsOffered.length === 0) return DISCOUNT_LADDER[0];
  if (session.discountsOffered.length === 1 && session.discountsOffered[0] === 5) return DISCOUNT_LADDER[1];
  return 0;
}

export function shouldOfferDiscount(session: CallSession): boolean {
  const stage = session.stage;
  if (stage !== ConversationStage.OBJECTION && stage !== ConversationStage.NEGOTIATION) return false;
  const lastObjection = session.objectionsEncountered[session.objectionsEncountered.length - 1];
  if (lastObjection !== ObjectionType.PRICE) return false;
  return getAvailableDiscount(session) > 0;
}

export function recordDiscountOffered(session: CallSession, discount: number): Partial<CallSession> {
  return { discountsOffered: [...session.discountsOffered, discount] };
}

export function formatDiscountMessage(session: CallSession, discount: number): string {
  if (discount === 5 && session.discountsOffered.length === 0) return '5% off today';
  if (discount === 10) return 'an additional 5% discount (10% total)';
  return `${discount}% off`;
}

const FOLLOW_UP_KEYWORDS = [
  'call me back',
  'next week',
  'tomorrow',
  'later',
  'not right now',
  'another time',
  'call again',
  'schedule',
] as const;

export function detectFollowUpRequest(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  return FOLLOW_UP_KEYWORDS.some((kw) => lower.includes(kw));
}
