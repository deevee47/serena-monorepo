import { describe, it, expect } from 'bun:test';
import {
  detectFollowUpRequest,
  formatDiscountMessage,
  getAvailableDiscount,
  recordDiscountOffered,
  shouldOfferDiscount,
} from '../../src/services/negotiation.service.js';
import { ConversationStage, ObjectionType } from '../../src/types/session.types.js';
import type { CallSession } from '../../src/types/session.types.js';

function mockSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'test-call-1',
    phoneNumber: '+1234567890',
    productId: 'prod-001',
    stage: ConversationStage.OBJECTION,
    score: 40,
    discountsOffered: [],
    objectionsEncountered: [ObjectionType.PRICE],
    conversationHistory: [],
    turnCount: 2,
    currentProductId: 'prod-001',
    closeAttempted: false,
    followUpRequested: false,
    followUpNote: null,
    createdAt: new Date(),
    lastUpdatedAt: new Date(),
    isActive: true,
    ...overrides,
  };
}

describe('getAvailableDiscount', () => {
  it('returns 5 when no discounts offered yet', () => {
    expect(getAvailableDiscount(mockSession({ discountsOffered: [] }))).toBe(5);
  });

  it('returns 10 after 5% has been offered', () => {
    expect(getAvailableDiscount(mockSession({ discountsOffered: [5] }))).toBe(10);
  });

  it('returns 0 when both discounts offered', () => {
    expect(getAvailableDiscount(mockSession({ discountsOffered: [5, 10] }))).toBe(0);
  });

  it('never returns more than MAX_DISCOUNT (10)', () => {
    const result = getAvailableDiscount(mockSession({ discountsOffered: [] }));
    expect(result).toBeLessThanOrEqual(10);
  });

  it('returns 0 and does not crash when discount exceeds MAX_DISCOUNT (safety check)', () => {
    // If somehow an out-of-range discount was recorded, safety returns 0
    expect(getAvailableDiscount(mockSession({ discountsOffered: [15] }))).toBe(0);
  });
});

describe('shouldOfferDiscount', () => {
  it('returns true when OBJECTION stage, last objection PRICE, discounts available', () => {
    const session = mockSession({
      stage: ConversationStage.OBJECTION,
      objectionsEncountered: [ObjectionType.PRICE],
      discountsOffered: [],
    });
    expect(shouldOfferDiscount(session)).toBe(true);
  });

  it('returns true when NEGOTIATION stage with same conditions', () => {
    const session = mockSession({
      stage: ConversationStage.NEGOTIATION,
      objectionsEncountered: [ObjectionType.PRICE],
      discountsOffered: [],
    });
    expect(shouldOfferDiscount(session)).toBe(true);
  });

  it('returns false when stage is INTRO', () => {
    const session = mockSession({
      stage: ConversationStage.INTRO,
      objectionsEncountered: [ObjectionType.PRICE],
    });
    expect(shouldOfferDiscount(session)).toBe(false);
  });

  it('returns false when stage is PITCH', () => {
    const session = mockSession({
      stage: ConversationStage.PITCH,
      objectionsEncountered: [ObjectionType.PRICE],
    });
    expect(shouldOfferDiscount(session)).toBe(false);
  });

  it('returns false when last objection is TRUST (not PRICE)', () => {
    const session = mockSession({
      stage: ConversationStage.OBJECTION,
      objectionsEncountered: [ObjectionType.TRUST],
    });
    expect(shouldOfferDiscount(session)).toBe(false);
  });

  it('returns false when no discounts remain', () => {
    const session = mockSession({
      stage: ConversationStage.OBJECTION,
      objectionsEncountered: [ObjectionType.PRICE],
      discountsOffered: [5, 10],
    });
    expect(shouldOfferDiscount(session)).toBe(false);
  });
});

describe('recordDiscountOffered', () => {
  it('returns update with discount appended', () => {
    const session = mockSession({ discountsOffered: [] });
    const update = recordDiscountOffered(session, 5);
    expect(update.discountsOffered).toEqual([5]);
  });

  it('does not mutate the input session', () => {
    const session = mockSession({ discountsOffered: [5] });
    recordDiscountOffered(session, 10);
    expect(session.discountsOffered).toEqual([5]); // unchanged
  });

  it('appends to existing discounts', () => {
    const session = mockSession({ discountsOffered: [5] });
    const update = recordDiscountOffered(session, 10);
    expect(update.discountsOffered).toEqual([5, 10]);
  });
});

describe('formatDiscountMessage', () => {
  it('first discount → "5% off today"', () => {
    const session = mockSession({ discountsOffered: [] });
    expect(formatDiscountMessage(session, 5)).toBe('5% off today');
  });

  it('second discount → "an additional 5% discount (10% total)"', () => {
    const session = mockSession({ discountsOffered: [5] });
    expect(formatDiscountMessage(session, 10)).toBe('an additional 5% discount (10% total)');
  });
});

describe('detectFollowUpRequest', () => {
  it('detects "call me back"', () => expect(detectFollowUpRequest('please call me back later')).toBe(true));
  it('detects "next week"', () => expect(detectFollowUpRequest('try me next week')).toBe(true));
  it('detects "tomorrow"', () => expect(detectFollowUpRequest('call me tomorrow')).toBe(true));
  it('detects "not right now"', () => expect(detectFollowUpRequest("it's not right now for me")).toBe(true));
  it('detects "schedule"', () => expect(detectFollowUpRequest('can you schedule a callback')).toBe(true));
  it('returns false for unrelated utterance', () => {
    expect(detectFollowUpRequest("yes I'm interested, how much is it")).toBe(false);
  });
});
