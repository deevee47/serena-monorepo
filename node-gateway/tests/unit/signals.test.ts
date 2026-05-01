import { describe, it, expect } from 'bun:test';
import { fillerDensity, utteranceLengthTrend } from '../../src/services/signals.js';

describe('utteranceLengthTrend', () => {
  it('returns null for empty input', () => {
    expect(utteranceLengthTrend([])).toBeNull();
  });

  it('returns null for a single utterance (slope undefined)', () => {
    expect(utteranceLengthTrend(['hello there'])).toBeNull();
  });

  it('returns 0 when lengths are constant', () => {
    expect(utteranceLengthTrend(['a b c', 'd e f', 'g h i'])).toBe(0);
  });

  it('is positive when utterances are growing', () => {
    // Lengths 1, 2, 3 → slope 1.0
    expect(utteranceLengthTrend(['a', 'a b', 'a b c'])).toBe(1);
  });

  it('is negative when utterances are shrinking', () => {
    // Lengths 5, 3, 1 → slope -2.0
    const slope = utteranceLengthTrend([
      'this is the first utterance',
      'shorter reply now',
      'yes',
    ]);
    expect(slope).toBe(-2);
  });
});

describe('fillerDensity', () => {
  it('returns null for empty input', () => {
    expect(fillerDensity([])).toBeNull();
  });

  it('returns 0 when there are no fillers', () => {
    expect(fillerDensity(['the price is too high for me'])).toBe(0);
  });

  it('counts uh / um / like as fillers', () => {
    const d = fillerDensity(['uh um like yeah okay then'])!;
    expect(d).toBeGreaterThan(0.4);
  });

  it('counts multi-word phrases like "i guess"', () => {
    const d = fillerDensity(['yeah i guess that works for me'])!;
    expect(d).toBeGreaterThan(0);
  });

  it('caps the density at 1.0', () => {
    const d = fillerDensity(['uh uh uh'])!;
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(1.0);
  });

  it('aggregates across multiple utterances', () => {
    const d = fillerDensity(['the price is fair', 'uh i mean its a lot'])!;
    expect(d).toBeGreaterThan(0);
  });
});
