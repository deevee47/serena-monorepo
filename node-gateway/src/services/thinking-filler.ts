/**
 * Thinking-fillers for the dead-air gap while observation tools run.
 *
 * When the brain emits a `thinking` event (right before it awaits a Postgres
 * lookup behind get_review_summary / get_recent_purchases / etc.), the gateway
 * fires one of these short fillers as a TTS-bound SSE delta. The customer
 * hears "ek minute, dekh ke batati hoon —" instead of 200-700ms of silence.
 *
 * Coordination with feature 5 (DISFLUENCY_AND_HUMOR): if the LLM already
 * started its turn with one of the disfluency openers ("hmm —", "lemme
 * think —"), we suppress the filler so the customer doesn't hear two
 * thinking-aloud cues stacked.
 */

const FILLERS_EN: Record<string, string> = {
  get_review_summary: " let me check what folks have said — ",
  get_recent_purchases: " one sec, pulling that up — ",
  get_review_summary_alt: " hmm, let me look — ",
  get_available_offers: " let me see what I can pair with that — ",
  check_inventory: " one sec, checking stock — ",
  get_delivery_eta: " let me check the shipping — ",
  list_products: " let me see what we have — ",
  default: " one sec — ",
};

const FILLERS_HI: Record<string, string> = {
  get_review_summary: " ek minute, dekh ke batati hoon — ",
  get_recent_purchases: " ek second, pull kar rahi hoon — ",
  get_available_offers: " ek minute, offers check kar rahi hoon — ",
  check_inventory: " ek second, stock dekh leti hoon — ",
  get_delivery_eta: " ek minute, delivery check karti hoon — ",
  list_products: " ek second, batati hoon kya kya hai — ",
  default: " ek second — ",
};

export type FillerLanguage = 'en' | 'hi';

/** Pick a filler for an observation tool. Picks Hindi for Hinglish/Hindi
 *  callers, English otherwise. The leading + trailing space matters — Vapi
 *  TTS streams these inline as SSE deltas. */
export function thinkingFillerFor(toolName: string, lang: FillerLanguage): string {
  const table = lang === 'hi' ? FILLERS_HI : FILLERS_EN;
  return table[toolName] ?? table['default']!;
}

/** Heuristic for which language to use for the filler. Indian timezones get
 *  Hindi by default; falls back to last-utterance content sniff (Devanagari
 *  or common Romanized-Hindi tokens). Customer's actual reply language wins
 *  over their timezone — same rule the prompt's LANGUAGE_RULES enforces. */
export function detectFillerLanguage(opts: {
  lastUtterance?: string | null;
  timezone?: string | null;
}): FillerLanguage {
  const utt = (opts.lastUtterance ?? '').trim().toLowerCase();
  // The customer's actual reply language wins over their saved timezone — same
  // rule the prompt's LANGUAGE_RULES enforces. Only fall back to timezone when
  // we have no utterance to read.
  if (utt) {
    if (/[ऀ-ॿ]/.test(utt)) return 'hi';
    if (/\b(haan|nahi|nahin|bhai|kya|kar|kyon|theek|ji|chahiye|abhi|matlab|bilkul|kitna|kitne|kahan|dekho|samajh|mujhe|aap|hum|hoon|rahi|bhej|karo|le|chalo|chalega|achha|sahi)\b/.test(utt))
      return 'hi';
    return 'en';
  }
  if (opts.timezone === 'Asia/Kolkata' || opts.timezone === 'Asia/Calcutta') return 'hi';
  return 'en';
}

/** Suppress the gateway's filler when the LLM's own text already opens with
 *  a disfluency cue (feature 5). Prevents stacked "hmm — let me check —". */
export function isDisfluencyOpener(text: string): boolean {
  if (!text) return false;
  const head = text.trimStart().slice(0, 32).toLowerCase();
  return /^(hmm|uhh?|umm|let me|lemme|okay so|right —|ek second|ek minute|haan toh|haan ji)/.test(head);
}
