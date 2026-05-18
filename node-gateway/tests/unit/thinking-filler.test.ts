import { describe, it, expect } from 'bun:test';
import {
  detectFillerLanguage,
  isDisfluencyOpener,
  thinkingFillerFor,
} from '../../src/services/thinking-filler.js';

describe('thinkingFillerFor', () => {
  it('returns the english filler for known tools', () => {
    expect(thinkingFillerFor('get_review_summary', 'en')).toContain('what folks have said');
    expect(thinkingFillerFor('check_inventory', 'en')).toContain('checking stock');
  });

  it('returns the hindi filler when lang=hi', () => {
    expect(thinkingFillerFor('get_review_summary', 'hi')).toContain('dekh ke batati hoon');
    expect(thinkingFillerFor('check_inventory', 'hi')).toContain('stock');
  });

  it('falls back to a generic filler for unknown tools', () => {
    expect(thinkingFillerFor('something_new', 'en')).toMatch(/sec/);
    expect(thinkingFillerFor('something_new', 'hi')).toMatch(/ek second/);
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
