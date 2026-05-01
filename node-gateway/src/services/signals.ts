/**
 * Voice-channel signal derivation — mirrors fastapi-brain/app/services/signals.py.
 * Pure functions: take recent user utterances, return engagement signals the
 * Decision rules can react to.
 */

const FILLER_TOKENS = new Set(['uh', 'um', 'uhh', 'ehh', 'like', 'i', 'guess']);
const FILLER_PHRASES = ['i guess', 'you know', 'kind of', 'sort of', 'i mean'];

/**
 * Slope of token-count across recent USER utterances.
 * - Positive = lengths growing (engaging more)
 * - Negative = shrinking (disengaging)
 * - null when fewer than 2 utterances.
 */
export function utteranceLengthTrend(recentUserUtterances: string[]): number | null {
  if (recentUserUtterances.length < 2) return null;
  const lengths = recentUserUtterances.map((u) => u.split(/\s+/).filter(Boolean).length);
  const n = lengths.length;
  const meanX = (n - 1) / 2;
  const meanY = lengths.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (i - meanX) * (lengths[i]! - meanY);
    varX += (i - meanX) ** 2;
  }
  if (varX === 0) return 0.0;
  return cov / varX;
}

/**
 * Ratio of filler tokens (uh, um, like, "i guess", ...) to total tokens
 * across recent USER utterances. Returns null if no utterances. Values >0.15
 * typically indicate hesitation.
 */
export function fillerDensity(recentUserUtterances: string[]): number | null {
  if (recentUserUtterances.length === 0) return null;
  let totalTokens = 0;
  let fillerCount = 0;
  for (const utterance of recentUserUtterances) {
    let text = utterance.toLowerCase();
    // Phrases first so "i guess" counts once instead of "i" + "guess"
    for (const phrase of FILLER_PHRASES) {
      const occurrences = (text.match(new RegExp(escapeRegExp(phrase), 'g')) || []).length;
      fillerCount += occurrences;
      text = text.replaceAll(phrase, ' ');
    }
    const tokens = text
      .split(/\s+/)
      .map((t) => t.replace(/[.,!?;:]+/g, ''))
      .filter(Boolean);
    totalTokens += tokens.length;
    for (const tok of tokens) {
      if (FILLER_TOKENS.has(tok)) fillerCount++;
    }
  }
  if (totalTokens === 0) return 0.0;
  return Math.min(1.0, fillerCount / totalTokens);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
