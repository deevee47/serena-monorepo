/**
 * Spoken-vs-sent discount reconciliation.
 *
 * The discount the agent SPEAKS is free LLM text; only the WhatsApp link's
 * `discount_percent` is schema-clamped (≤ MAX_DISCOUNT_PERCENT, see
 * converse-dispatcher). A hallucinated or injected "I'll give you 30% off" is
 * TTS'd to the customer — a verbal commitment — even though the link still
 * sends ≤10%. We can't un-speak it mid-stream without buffering (latency), so
 * this detects the divergence after the turn so it can be alarmed/monitored.
 *
 * Pure + side-effect-free so it's unit-testable; the gateway calls it once the
 * agent text is assembled and logs an alarm on divergence.
 */

import { MAX_DISCOUNT_PERCENT } from './converse-dispatcher.js';

/** Words that mark a percentage as a *discount*, to avoid false positives like
 *  "100% satisfaction" or "90% of buyers". */
const DISCOUNT_CONTEXT = /\b(off|discount|knock|save|deal|concession|less|cut)\b/i;

/** Highest discount percentage spoken in `text`, or null if none is stated in
 *  a discount context. Scans every `N%` / `N percent` mention and keeps only
 *  those whose surrounding window reads as a discount. */
export function extractSpokenDiscountPercent(text: string): number | null {
  if (!text) return null;
  let maxPct: number | null = null;
  const re = /(\d{1,3})\s*(?:%|percent)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const pct = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(pct)) continue;
    const start = Math.max(0, m.index - 24);
    const end = Math.min(text.length, m.index + m[0].length + 24);
    if (DISCOUNT_CONTEXT.test(text.slice(start, end))) {
      if (maxPct === null || pct > maxPct) maxPct = pct;
    }
  }
  return maxPct;
}

export interface SpokenDiscountCheck {
  /** Highest discount % the agent spoke this turn (null if none). */
  spokenPercent: number | null;
  /** What the checkout link actually applied. */
  appliedPercent: number;
  /** Spoken discount exceeds the absolute cap — a hard divergence. */
  exceedsCap: boolean;
  /** Spoken discount exceeds what the link sent — customer expects more than
   *  they'll get. */
  exceedsApplied: boolean;
}

export function checkSpokenDiscount(
  agentText: string,
  appliedPercent: number,
  maxPercent: number = MAX_DISCOUNT_PERCENT,
): SpokenDiscountCheck {
  const spokenPercent = extractSpokenDiscountPercent(agentText);
  const exceedsCap = spokenPercent !== null && spokenPercent > maxPercent;
  const exceedsApplied = spokenPercent !== null && spokenPercent > appliedPercent;
  return { spokenPercent, appliedPercent, exceedsCap, exceedsApplied };
}
