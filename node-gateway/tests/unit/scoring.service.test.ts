import { describe, it, expect } from 'bun:test';
import {
  applyScoreDelta,
  calculateScoreAfterTurn,
  getScoreCategory,
  isRepeatObjection,
  shouldEscalateDiscount,
} from '../../src/services/scoring.service.js';
import { ObjectionType, ConversationStage } from '../../src/types/session.types.js';
import type { CallSession } from '../../src/types/session.types.js';

function mockSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'test-call-1',
    phoneNumber: '+1234567890',
    productId: 'prod-001',
    stage: ConversationStage.PITCH,
    score: 50,
    discountsOffered: [],
    objectionsEncountered: [],
    conversationHistory: [],
    turnCount: 1,
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

describe('applyScoreDelta', () => {
  it('adds positive delta', () => {
    expect(applyScoreDelta(50, 10)).toBe(60);
  });

  it('adds negative delta', () => {
    expect(applyScoreDelta(50, -15)).toBe(35);
  });

  it('clamps at 0 — large negative delta', () => {
    expect(applyScoreDelta(5, -20)).toBe(0);
  });

  it('clamps at 100 — large positive delta', () => {
    expect(applyScoreDelta(95, 20)).toBe(100);
  });

  it('rounds fractional result', () => {
    expect(applyScoreDelta(50, 3)).toBe(53);
  });
});

describe('calculateScoreAfterTurn — objection deltas', () => {
  it('PRICE applies -15 delta', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.PRICE)).toBe(35);
  });

  it('TRUST applies -20 delta', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.TRUST)).toBe(30);
  });

  it('CONFUSION applies -10 delta', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.CONFUSION)).toBe(40);
  });

  it('TIMING applies -12 delta', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.TIMING)).toBe(38);
  });

  it('POSITIVE_SIGNAL applies +12 delta', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.POSITIVE_SIGNAL)).toBe(62);
  });

  it('NEUTRAL applies 0 delta — score unchanged', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.NEUTRAL)).toBe(50);
  });
});

describe('calculateScoreAfterTurn — repeat objections', () => {
  it('adds REPEAT_PENALTY (-10) on top of base delta for repeat objection', () => {
    const session = mockSession({
      score: 50,
      objectionsEncountered: [ObjectionType.PRICE],
    });
    // PRICE (-15) + repeat penalty (-10) = -25 → 50 - 25 = 25
    expect(calculateScoreAfterTurn(session, ObjectionType.PRICE)).toBe(25);
  });

  it('no repeat penalty for first occurrence', () => {
    const session = mockSession({ score: 50, objectionsEncountered: [] });
    expect(calculateScoreAfterTurn(session, ObjectionType.PRICE)).toBe(35);
  });

  it('clamps to 0 when repeat pushes score negative', () => {
    const session = mockSession({
      score: 10,
      objectionsEncountered: [ObjectionType.TRUST],
    });
    // TRUST (-20) + repeat (-10) = -30 → clamped to 0
    expect(calculateScoreAfterTurn(session, ObjectionType.TRUST)).toBe(0);
  });
});

describe('calculateScoreAfterTurn — sentiment modifier', () => {
  it('POSITIVE sentiment halves negative PRICE delta', () => {
    const session = mockSession({ score: 50 });
    // PRICE (-15) → halved → ceil(-7.5) = -7 → 50 - 7 = 43
    expect(calculateScoreAfterTurn(session, ObjectionType.PRICE, 'POSITIVE')).toBe(43);
  });

  it('POSITIVE sentiment does not amplify positive POSITIVE_SIGNAL delta', () => {
    const session = mockSession({ score: 50 });
    // POSITIVE_SIGNAL (+12) stays +12 — sentiment only modifies negative deltas
    expect(calculateScoreAfterTurn(session, ObjectionType.POSITIVE_SIGNAL, 'POSITIVE')).toBe(62);
  });

  it('NEGATIVE sentiment applies delta as-is', () => {
    const session = mockSession({ score: 50 });
    expect(calculateScoreAfterTurn(session, ObjectionType.PRICE, 'NEGATIVE')).toBe(35);
  });
});

describe('isRepeatObjection', () => {
  it('returns false when objectionsEncountered is empty', () => {
    const session = mockSession({ objectionsEncountered: [] });
    expect(isRepeatObjection(session, ObjectionType.PRICE)).toBe(false);
  });

  it('returns true when objection already in list', () => {
    const session = mockSession({ objectionsEncountered: [ObjectionType.PRICE] });
    expect(isRepeatObjection(session, ObjectionType.PRICE)).toBe(true);
  });

  it('returns false for a different objection in list', () => {
    const session = mockSession({ objectionsEncountered: [ObjectionType.TRUST] });
    expect(isRepeatObjection(session, ObjectionType.PRICE)).toBe(false);
  });
});

describe('getScoreCategory — boundaries', () => {
  it('score 100 → HOT', () => expect(getScoreCategory(100)).toBe('HOT'));
  it('score 70 → HOT', () => expect(getScoreCategory(70)).toBe('HOT'));
  it('score 69 → WARM', () => expect(getScoreCategory(69)).toBe('WARM'));
  it('score 45 → WARM', () => expect(getScoreCategory(45)).toBe('WARM'));
  it('score 44 → COLD', () => expect(getScoreCategory(44)).toBe('COLD'));
  it('score 20 → COLD', () => expect(getScoreCategory(20)).toBe('COLD'));
  it('score 19 → LOST', () => expect(getScoreCategory(19)).toBe('LOST'));
  it('score 0 → LOST', () => expect(getScoreCategory(0)).toBe('LOST'));
});

describe('shouldEscalateDiscount', () => {
  it('returns true when COLD score, last objection PRICE, discounts available', () => {
    const session = mockSession({
      score: 30,
      objectionsEncountered: [ObjectionType.PRICE],
      discountsOffered: [],
    });
    expect(shouldEscalateDiscount(session)).toBe(true);
  });

  it('returns false when score is HOT', () => {
    const session = mockSession({
      score: 80,
      objectionsEncountered: [ObjectionType.PRICE],
      discountsOffered: [],
    });
    expect(shouldEscalateDiscount(session)).toBe(false);
  });

  it('returns false when last objection is not PRICE', () => {
    const session = mockSession({
      score: 30,
      objectionsEncountered: [ObjectionType.TRUST],
      discountsOffered: [],
    });
    expect(shouldEscalateDiscount(session)).toBe(false);
  });

  it('returns false when all discounts exhausted', () => {
    const session = mockSession({
      score: 30,
      objectionsEncountered: [ObjectionType.PRICE],
      discountsOffered: [5, 10],
    });
    expect(shouldEscalateDiscount(session)).toBe(false);
  });
});
