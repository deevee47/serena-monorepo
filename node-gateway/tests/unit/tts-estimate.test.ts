import { describe, it, expect } from 'bun:test';
import { estimateSpeechMs } from '../../src/lib/tts-estimate.js';

describe('estimateSpeechMs', () => {
  it('is 0 for empty or whitespace text', () => {
    expect(estimateSpeechMs('')).toBe(0);
    expect(estimateSpeechMs('   ')).toBe(0);
  });

  it('scales with word count', () => {
    const short = estimateSpeechMs('Yes, sounds good.');
    const long = estimateSpeechMs(Array(60).fill('word').join(' '));
    expect(long).toBeGreaterThan(short);
  });

  it('approximates a realistic speaking pace (~165 wpm)', () => {
    // 165 words should land near a minute.
    const ms = estimateSpeechMs(Array(165).fill('word').join(' '));
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThan(70_000);
  });

  it('returns several seconds for a typical 4-sentence agent reply', () => {
    const reply =
      'Achha, samajh gayi. Let me check if there are any offers available for the ' +
      'ZephyrChair Lite. Ek second, let me see what I can pair with that. Achha, ' +
      "here's an option: if you bundle the ZephyrChair Lite with the Anti-fatigue " +
      'Floor Mat, you get 5% off the whole order. Does that sound good?';
    const ms = estimateSpeechMs(reply);
    // ~55 words → on the order of 15-25s of speech, definitely not sub-second.
    expect(ms).toBeGreaterThan(10_000);
  });
});
