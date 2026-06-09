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

// Each tool gets a POOL of interchangeable fillers, not one fixed line — so
// the agent doesn't say the exact same "offers check kar rahi hoon —" every
// single time. thinkingFillerFor() picks one at random and avoids repeating
// the previous pick for that tool (see lastPickIndex below). Combined with the
// one-filler-per-turn rule in routes/llm.ts, this kills the "ek minute… —
// ek second… — check kar rahi hoon…" stacking the customer used to hear.
const FILLERS_EN: Record<string, string[]> = {
  get_review_summary: [
    " let me check what folks have said — ",
    " lemme pull up the reviews — ",
    " one sec, seeing what buyers think — ",
  ],
  get_recent_purchases: [
    " one sec, pulling that up — ",
    " hold on, looking that up — ",
  ],
  get_available_offers: [
    " let me see what I can pair with that — ",
    " hold on, checking the deals — ",
    " lemme look at the bundles — ",
  ],
  check_inventory: [
    " one sec, checking stock — ",
    " hold on, checking what's in stock — ",
  ],
  get_delivery_eta: [
    " let me check the shipping — ",
    " one sec, checking delivery — ",
  ],
  list_products: [
    " let me see what we have — ",
    " one sec, pulling up the options — ",
  ],
  default: [" one sec — ", " hold on — ", " gimme a sec — "],
};

const FILLERS_HI: Record<string, string[]> = {
  get_review_summary: [
    " ek minute, dekh ke batati hoon — ",
    " ruko zara, reviews dekh rahi hoon — ",
    " ek second, log kya keh rahe hain dekhti hoon — ",
  ],
  get_recent_purchases: [
    " ek second, pull kar rahi hoon — ",
    " ruko zara, dekh rahi hoon — ",
  ],
  get_available_offers: [
    " offers dekh rahi hoon — ",
    " ruko, kya bundle ban sakta hai dekhti hoon — ",
    " ek second, deals check kar rahi hoon — ",
  ],
  check_inventory: [
    " ek second, stock dekh leti hoon — ",
    " ruko, stock dekh rahi hoon — ",
  ],
  get_delivery_eta: [
    " ek minute, delivery check karti hoon — ",
    " ruko, shipping dekh rahi hoon — ",
  ],
  list_products: [
    " ek second, batati hoon kya kya hai — ",
    " ruko, options dekh rahi hoon — ",
  ],
  default: [" ek second — ", " ruko zara — ", " haan, dekhti hoon — "],
};

export type FillerLanguage = 'en' | 'hi';

/** The candidate fillers for a tool in a language. Falls back to the generic
 *  pool for tools we don't have bespoke lines for. */
export function fillerPoolFor(toolName: string, lang: FillerLanguage): readonly string[] {
  const table = lang === 'hi' ? FILLERS_HI : FILLERS_EN;
  return table[toolName] ?? table['default']!;
}

/** Remembers the last pool index used per `lang:tool` so we never play the
 *  exact same line twice in a row. Process-local and best-effort — it only
 *  drives phrasing variety, so a reset (or a race across concurrent calls)
 *  costs nothing but a slightly less varied filler. */
const lastPickIndex: Map<string, number> = new Map();

/** Pick a filler for an observation tool. Hindi for Hinglish/Hindi callers,
 *  English otherwise. Rotates within the tool's pool, skipping the previous
 *  pick so it doesn't immediately repeat. The leading + trailing space
 *  matters — Vapi TTS streams these inline as SSE deltas. */
export function thinkingFillerFor(toolName: string, lang: FillerLanguage): string {
  const pool = fillerPoolFor(toolName, lang);
  if (pool.length === 1) return pool[0]!;
  const key = `${lang}:${toolName}`;
  const prev = lastPickIndex.get(key);
  let idx = Math.floor(Math.random() * pool.length);
  if (idx === prev) idx = (idx + 1) % pool.length; // avoid an immediate repeat
  lastPickIndex.set(key, idx);
  return pool[idx]!;
}

/** Test-only: reset the rotation memory so variety assertions are deterministic. */
export function _resetFillerRotationForTest(): void {
  lastPickIndex.clear();
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

// ─── Rolling per-tool latency tracker ─────────────────────────────────────
// We measure how long each observation tool's full round-trip takes (from
// the brain emitting `thinking` to the brain emitting `observation`). When
// a tool's p50 sits under SUPPRESS_THRESHOLD_MS, the dead-air filler arrives
// AFTER the answer would have anyway — stacking a "let me check —" on top
// of an already-fast result sounds robotic, so we skip it.
//
// In-memory sliding window per tool. Process-local — fine for the
// single-instance gateway we run today. If we ever shard, this needs to
// move to Redis (HGET p50 per tool); the API surface stays identical.

const WINDOW_SIZE = 8;
/** Below this median latency, suppress the filler. Headroom over the typical
 *  TTS-cue latency (~150-250ms): if the tool answers faster than that, the
 *  filler is just noise. */
const SUPPRESS_THRESHOLD_MS = 280;
/** Need at least this many samples before the suppression decision becomes
 *  authoritative. Below it, we always emit — better to risk one redundant
 *  filler than to drop one during a tool's first warmup invocation. */
const MIN_SAMPLES_TO_SUPPRESS = 3;

const latencyWindow: Map<string, number[]> = new Map();

/** Record an observation-tool round-trip latency for the rolling window. */
export function recordObservationLatency(toolName: string, ms: number): void {
  if (!toolName || !Number.isFinite(ms) || ms < 0) return;
  const buf = latencyWindow.get(toolName) ?? [];
  buf.push(ms);
  if (buf.length > WINDOW_SIZE) buf.shift();
  latencyWindow.set(toolName, buf);
}

function p50(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  return sorted[mid] ?? 0;
}

/** True iff the gateway should emit a thinking-filler for this tool. False
 *  when the rolling p50 says we'll get the result back before the filler
 *  would finish reading. Test seam: latency window is process-local. */
export function shouldEmitFiller(toolName: string): boolean {
  const buf = latencyWindow.get(toolName) ?? [];
  if (buf.length < MIN_SAMPLES_TO_SUPPRESS) return true;
  return p50(buf) >= SUPPRESS_THRESHOLD_MS;
}

/** Test-only: reset the in-memory window. Not exported via the index. */
export function _resetLatencyWindowForTest(): void {
  latencyWindow.clear();
}
