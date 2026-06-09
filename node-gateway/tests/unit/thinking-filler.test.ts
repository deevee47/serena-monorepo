import { describe, it, expect, beforeEach } from 'bun:test';
import {
  detectFillerLanguage,
  fillerPoolFor,
  isDisfluencyOpener,
  thinkingFillerFor,
  _resetFillerRotationForTest,
} from '../../src/services/thinking-filler.js';

describe('thinkingFillerFor', () => {
  beforeEach(() => _resetFillerRotationForTest());

  it('always returns a line from the tool/lang pool', () => {
    for (let i = 0; i < 30; i++) {
      const en = thinkingFillerFor('get_review_summary', 'en');
      expect(fillerPoolFor('get_review_summary', 'en')).toContain(en);
      const hi = thinkingFillerFor('check_inventory', 'hi');
      expect(fillerPoolFor('check_inventory', 'hi')).toContain(hi);
    }
  });

  it('uses the right language pool', () => {
    const hi = thinkingFillerFor('get_review_summary', 'hi');
    expect(fillerPoolFor('get_review_summary', 'hi')).toContain(hi);
    expect(fillerPoolFor('get_review_summary', 'en')).not.toContain(hi);
  });

  it('rotates for variety — not the same line every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add(thinkingFillerFor('get_available_offers', 'hi'));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never repeats the same line twice in a row', () => {
    let prev = '';
    for (let i = 0; i < 40; i++) {
      const next = thinkingFillerFor('get_review_summary', 'hi');
      expect(next).not.toBe(prev);
      prev = next;
    }
  });

  it('falls back to the generic pool for unknown tools', () => {
    const en = thinkingFillerFor('something_new', 'en');
    expect(fillerPoolFor('default', 'en')).toContain(en);
    const hi = thinkingFillerFor('something_new', 'hi');
    expect(fillerPoolFor('default', 'hi')).toContain(hi);
  });

  it('every filler keeps the leading + trailing space Vapi TTS needs', () => {
    for (const tool of ['get_review_summary', 'get_available_offers', 'default']) {
      for (const lang of ['en', 'hi'] as const) {
        for (const line of fillerPoolFor(tool, lang)) {
          expect(line.startsWith(' ')).toBe(true);
          expect(line.endsWith(' ')).toBe(true);
        }
      }
    }
  });
});

describe('detectFillerLanguage', () => {
  it('picks hindi for romanized hindi tokens in the utterance', () => {
    expect(detectFillerLanguage({ lastUtterance: 'haan bhej do', timezone: null })).toBe('hi');
    expect(detectFillerLanguage({ lastUtterance: 'price kitna hai?', timezone: null })).toBe('hi');
  });

  it('picks hindi for devanagari', () => {
    expect(detectFillerLanguage({ lastUtterance: 'हाँ', timezone: null })).toBe('hi');
  });

  it('falls back to timezone when utterance is empty', () => {
    expect(detectFillerLanguage({ lastUtterance: '', timezone: 'Asia/Kolkata' })).toBe('hi');
    expect(detectFillerLanguage({ lastUtterance: '', timezone: 'America/New_York' })).toBe('en');
  });

  it('lets the utterance language win over the timezone', () => {
    // Indian timezone but the customer is replying in English on this turn.
    expect(
      detectFillerLanguage({ lastUtterance: 'sure go ahead', timezone: 'Asia/Kolkata' }),
    ).toBe('en');
  });
});

describe('isDisfluencyOpener', () => {
  it('matches english disfluency openers', () => {
    expect(isDisfluencyOpener('hmm — let me see')).toBe(true);
    expect(isDisfluencyOpener('lemme think — okay')).toBe(true);
    expect(isDisfluencyOpener('Okay so — here is the thing')).toBe(true);
  });

  it('matches hinglish disfluency openers', () => {
    expect(isDisfluencyOpener('ek minute, dekh leti hoon')).toBe(true);
    expect(isDisfluencyOpener('haan toh — chaliye')).toBe(true);
  });

  it('returns false for plain content', () => {
    expect(isDisfluencyOpener('Sure thing!')).toBe(false);
    expect(isDisfluencyOpener('')).toBe(false);
    expect(isDisfluencyOpener('Hi Sarah, this is Serena from Muscleblaze')).toBe(false);
  });
});
