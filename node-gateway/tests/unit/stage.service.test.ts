import { describe, it, expect } from 'bun:test';
import {
  getNextStage,
  getStageDescription,
  isTerminalStage,
  shouldTransition,
} from '../../src/services/stage.service.js';
import { ConversationStage, ObjectionType } from '../../src/types/session.types.js';
import type { CallSession } from '../../src/types/session.types.js';

function mockSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'test-call-1',
    phoneNumber: '+1234567890',
    productId: 'prod-001',
    stage: ConversationStage.INTRO,
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

describe('INTRO transitions', () => {
  it('INTRO → PITCH always', () => {
    const session = mockSession({ stage: ConversationStage.INTRO });
    expect(getNextStage(session)).toBe(ConversationStage.PITCH);
  });
});

describe('PITCH transitions', () => {
  it('PITCH → OBJECTION when score < 65', () => {
    const session = mockSession({ stage: ConversationStage.PITCH, score: 40 });
    expect(getNextStage(session)).toBe(ConversationStage.OBJECTION);
  });

  it('PITCH → OBJECTION when real objection raised (score >= 65)', () => {
    const session = mockSession({
      stage: ConversationStage.PITCH,
      score: 70,
      objectionsEncountered: [ObjectionType.TRUST],
    });
    expect(getNextStage(session)).toBe(ConversationStage.OBJECTION);
  });

  it('PITCH → NEGOTIATION when score >= 65, turnCount >= 2, last objection PRICE', () => {
    const session = mockSession({
      stage: ConversationStage.PITCH,
      score: 65,
      turnCount: 2,
      objectionsEncountered: [ObjectionType.PRICE],
    });
    expect(getNextStage(session)).toBe(ConversationStage.NEGOTIATION);
  });

  it('PITCH → CLOSE when score >= 80 and turnCount >= 2', () => {
    const session = mockSession({
      stage: ConversationStage.PITCH,
      score: 80,
      turnCount: 2,
      objectionsEncountered: [],
    });
    expect(getNextStage(session)).toBe(ConversationStage.CLOSE);
  });

  it('PITCH stays PITCH when score >= 65 and no clear signal', () => {
    const session = mockSession({
      stage: ConversationStage.PITCH,
      score: 65,
      turnCount: 1,
      objectionsEncountered: [],
    });
    expect(getNextStage(session)).toBe(ConversationStage.PITCH);
  });
});

describe('OBJECTION transitions', () => {
  it('OBJECTION → NEGOTIATION when score >= 40', () => {
    const session = mockSession({
      stage: ConversationStage.OBJECTION,
      score: 40,
    });
    expect(getNextStage(session)).toBe(ConversationStage.NEGOTIATION);
  });

  it('OBJECTION → END when score < 20 (lost lead)', () => {
    const session = mockSession({
      stage: ConversationStage.OBJECTION,
      score: 15,
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });

  it('OBJECTION stays OBJECTION when score 20–39', () => {
    const session = mockSession({
      stage: ConversationStage.OBJECTION,
      score: 30,
    });
    expect(getNextStage(session)).toBe(ConversationStage.OBJECTION);
  });
});

describe('NEGOTIATION transitions', () => {
  it('NEGOTIATION → CLOSE when score >= 60', () => {
    const session = mockSession({
      stage: ConversationStage.NEGOTIATION,
      score: 60,
    });
    expect(getNextStage(session)).toBe(ConversationStage.CLOSE);
  });

  it('NEGOTIATION → END when score < 25', () => {
    const session = mockSession({
      stage: ConversationStage.NEGOTIATION,
      score: 24,
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });

  it('NEGOTIATION → END when all discounts exhausted', () => {
    const session = mockSession({
      stage: ConversationStage.NEGOTIATION,
      score: 40,
      discountsOffered: [5, 10],
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });

  it('NEGOTIATION stays NEGOTIATION when score 25–59 and discounts remain', () => {
    const session = mockSession({
      stage: ConversationStage.NEGOTIATION,
      score: 45,
      discountsOffered: [5],
    });
    expect(getNextStage(session)).toBe(ConversationStage.NEGOTIATION);
  });
});

describe('CLOSE transitions', () => {
  it('CLOSE → NEGOTIATION when closeAttempted=false and real objection raised', () => {
    const session = mockSession({
      stage: ConversationStage.CLOSE,
      closeAttempted: false,
      objectionsEncountered: [ObjectionType.PRICE],
    });
    expect(getNextStage(session)).toBe(ConversationStage.NEGOTIATION);
  });

  it('CLOSE → END when closeAttempted=true (prevents infinite loop)', () => {
    const session = mockSession({
      stage: ConversationStage.CLOSE,
      closeAttempted: true,
      objectionsEncountered: [ObjectionType.PRICE],
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });

  it('CLOSE → END when no real objection raised (NEUTRAL last)', () => {
    const session = mockSession({
      stage: ConversationStage.CLOSE,
      closeAttempted: false,
      objectionsEncountered: [ObjectionType.NEUTRAL],
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });

  it('CLOSE → END when no objections at all', () => {
    const session = mockSession({
      stage: ConversationStage.CLOSE,
      closeAttempted: false,
      objectionsEncountered: [],
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });

  it('CLOSE → END on POSITIVE_SIGNAL (happy path conversion)', () => {
    const session = mockSession({
      stage: ConversationStage.CLOSE,
      closeAttempted: false,
      objectionsEncountered: [ObjectionType.POSITIVE_SIGNAL],
    });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });
});

describe('END is terminal', () => {
  it('END → END always', () => {
    const session = mockSession({ stage: ConversationStage.END });
    expect(getNextStage(session)).toBe(ConversationStage.END);
  });
});

describe('isTerminalStage', () => {
  it('INTRO is not terminal', () => expect(isTerminalStage(ConversationStage.INTRO)).toBe(false));
  it('PITCH is not terminal', () => expect(isTerminalStage(ConversationStage.PITCH)).toBe(false));
  it('OBJECTION is not terminal', () => expect(isTerminalStage(ConversationStage.OBJECTION)).toBe(false));
  it('NEGOTIATION is not terminal', () => expect(isTerminalStage(ConversationStage.NEGOTIATION)).toBe(false));
  it('CLOSE is not terminal', () => expect(isTerminalStage(ConversationStage.CLOSE)).toBe(false));
  it('END is terminal', () => expect(isTerminalStage(ConversationStage.END)).toBe(true));
});

describe('shouldTransition', () => {
  it('returns true when stage will change', () => {
    const session = mockSession({ stage: ConversationStage.INTRO });
    expect(shouldTransition(session)).toBe(true);
  });

  it('returns false when no transition fires', () => {
    const session = mockSession({
      stage: ConversationStage.PITCH,
      score: 65,
      turnCount: 1,
      objectionsEncountered: [],
    });
    expect(shouldTransition(session)).toBe(false);
  });
});

describe('getStageDescription', () => {
  it('returns a non-empty string for each stage', () => {
    for (const stage of Object.values(ConversationStage)) {
      expect(getStageDescription(stage).length).toBeGreaterThan(0);
    }
  });
});
