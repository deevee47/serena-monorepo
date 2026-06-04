/**
 * Estimate how long it takes TTS to *speak* a piece of agent text.
 *
 * Used to anchor pre-response latency. The gateway finishes generating an
 * agent turn well before the provider has finished speaking it to the
 * customer, so timing the next user turn from "generation done" inflates the
 * measured pause by the entire TTS playback — and that inflation grows with
 * how much the agent said, which is a misleading confound. Advancing the
 * anchor by this estimate approximates "when the customer finished hearing the
 * agent", so the latency reads closer to the customer's actual think-time.
 *
 * Heuristic (word count ÷ speaking rate). The exact value would come from a
 * provider speech-end / VAD event; those aren't reliably available per turn.
 */
const WORDS_PER_MINUTE = 165;

export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.round((words / WORDS_PER_MINUTE) * 60_000);
}
