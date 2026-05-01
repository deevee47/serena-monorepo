import { describe, it, expect } from 'bun:test';
import { buildDecideRequest } from '../../src/services/decide-request.builder.js';
import { ObjectionType, ConversationStage } from '../../src/types/session.types.js';

describe('buildDecideRequest', () => {
  const baseClassification = {
    objection_type: ObjectionType.PRICE,
    sentiment: 'NEGATIVE' as const,
    subtype: 'too_expensive',
  };

  const baseArgs = {
    callId: 'call-1',
    classification: baseClassification,
    stage: ConversationStage.OBJECTION,
    score: 45,
    turnCount: 4,
    priorObjections: [ObjectionType.PRICE],
    discountsOffered: [5],
    hasAlternativeProduct: true,
  };

  it('maps every CallSession + classification field into the wire shape', () => {
    const req = buildDecideRequest(baseArgs);

    expect(req).toEqual({
      call_id: 'call-1',
      objection_type: ObjectionType.PRICE,
      objection_subtype: 'too_expensive',
      sentiment: 'NEGATIVE',
      stage: ConversationStage.OBJECTION,
      score: 45,
      turn_count: 4,
      prior_objection_types: [ObjectionType.PRICE],
      discounts_offered: [5],
      has_alternative_product: true,
      // Signal fields default to null when no recent utterances are passed.
      utterance_length_trend: null,
      filler_density: null,
      response_latency_ms: null,
      // whatsapp_available defaults to false unless the caller opts in.
      whatsapp_available: false,
    });
  });

  it('serializes missing subtype as null', () => {
    const req = buildDecideRequest({
      ...baseArgs,
      classification: { ...baseClassification, subtype: undefined },
    });
    expect(req.objection_subtype).toBeNull();
  });

  it('passes prior_objection_types as full session history (not just last turn)', () => {
    const priors = [ObjectionType.TRUST, ObjectionType.PRICE, ObjectionType.PRICE];
    const req = buildDecideRequest({ ...baseArgs, priorObjections: priors });
    expect(req.prior_objection_types).toEqual(priors);
  });

  it('passes discounts as the cumulative ladder (not just current turn)', () => {
    const req = buildDecideRequest({ ...baseArgs, discountsOffered: [5, 10] });
    expect(req.discounts_offered).toEqual([5, 10]);
  });

  it('reflects has_alternative_product=false when no alternative was found', () => {
    const req = buildDecideRequest({ ...baseArgs, hasAlternativeProduct: false });
    expect(req.has_alternative_product).toBe(false);
  });

  it('forwards explicit null subtype unchanged', () => {
    const req = buildDecideRequest({
      ...baseArgs,
      classification: { ...baseClassification, subtype: null },
    });
    expect(req.objection_subtype).toBeNull();
  });

  it('returns null voice signals when no recent user utterances are provided', () => {
    const req = buildDecideRequest(baseArgs);
    expect(req.utterance_length_trend).toBeNull();
    expect(req.filler_density).toBeNull();
    expect(req.response_latency_ms).toBeNull();
  });

  it('derives utterance_length_trend from recent user utterances', () => {
    const req = buildDecideRequest({
      ...baseArgs,
      recentUserUtterances: ['one two three four', 'one two', 'yes'],
    });
    expect(req.utterance_length_trend).toBeLessThan(0); // shrinking
  });

  it('derives filler_density from recent user utterances', () => {
    const req = buildDecideRequest({
      ...baseArgs,
      recentUserUtterances: ['uh i guess maybe like sort of'],
    });
    expect(req.filler_density).toBeGreaterThan(0);
  });

  it('returns null filler density when no utterances supplied', () => {
    const req = buildDecideRequest({ ...baseArgs, recentUserUtterances: [] });
    expect(req.filler_density).toBeNull();
  });
});
