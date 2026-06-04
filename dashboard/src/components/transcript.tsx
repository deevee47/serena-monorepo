import { Wrench } from '@phosphor-icons/react/dist/ssr';
import { Badge } from '@/components/ui/badge';
import { SEEK_AUDIO_EVENT, type SeekAudioDetail } from '@/components/call-scrubber';
import { cn } from '@/lib/utils';

export interface TranscriptTurn {
  /** Source row number — used by the call scrubber to scroll the matching
   *  bubble / row into view. Optional so live / in-flight transcripts that
   *  don't know their final ordering can still render. */
  turnNumber?: number;
  speaker: 'USER' | 'AGENT';
  utterance: string;
  objectionType?: string | null;
  /** Classifier read of the caller's emotional register on this turn.
   *  Captured for caller turns by the BullMQ classify worker. */
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  /** Side-effect tool (WhatsApp send / support handoff) that ended this turn. */
  toolCalled?: string | null;
  toolArgs?: unknown;
  /** Observation tools the LLM invoked DURING this agent turn (look-ups it ran
   *  before / after speaking the visible utterance). */
  observations?: Array<{ name: string; args?: Record<string, unknown> }>;
  /** Explicit 1..5 persistence counter on AGENT turns. Surfaced as a chip
   *  so operators can see how persistent the agent is being at a glance. */
  pushAttempt?: number | null;
  /** Pre-response latency on USER turns, ms. Surfaced as a faint sub-chip
   *  to give the post-mortem reader a sense of how fast/slow the caller
   *  was reacting to each agent line. */
  responseLatencyMs?: number | null;
  /** Discount % the agent committed to on this turn (only present when the
   *  checkout tool fired with a non-zero discount). Drives the ladder
   *  rendering in the KPI strip + an inline chip on the bubble. */
  discountOffered?: number | null;
  timestamp?: string | Date | null;
  /** Seconds from the start of the call recording, computed on the page
   *  from (turn.timestamp - call.createdAt). When present, the row becomes
   *  clickable and seeks `CallRecordingPlayer` to that offset. */
  offsetSec?: number | null;
}

/** Inline chip showing how many push-attempts the agent has burned through.
 *  Color escalates 1-2 = muted, 3 = warning, 4-5 = orange (the "you're almost
 *  out of legitimate pushes" signal). Renders nothing for null/0. */
export function PushAttemptChip({ attempt }: { attempt?: number | null }) {
  if (!attempt || attempt <= 0) return null;
  const tone =
    attempt >= 4
      ? 'border-ff-orange/70 text-ff-orange'
      : attempt === 3
        ? 'border-amber-500/60 text-amber-600 dark:text-amber-500'
        : 'border-border/60 text-muted-foreground';
  return (
    <span
      title={`Persistence: push attempt ${attempt} of 5`}
      className={cn(
        'inline-flex items-center gap-1 border bg-transparent px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em]',
        tone,
      )}
    >
      Push {attempt}/5
    </span>
  );
}

/** Inline chip surfacing pre-response latency. Faint by default — just a
 *  data point. Goes a touch louder at the extremes (<500ms visceral,
 *  >5000ms distracted) so eye can spot meaningful moments. */
export function LatencyChip({ ms }: { ms?: number | null }) {
  if (!ms || ms <= 0) return null;
  const tone =
    ms < 500 || ms > 5000
      ? 'text-foreground/80'
      : 'text-muted-foreground/70';
  const label = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  return (
    <span
      title="Caller reply latency (TTS-end → user speech start)"
      className={cn(
        'inline-flex items-center font-mono text-[9px] tabular-nums uppercase tracking-[0.18em]',
        tone,
      )}
    >
      ↳ {label}
    </span>
  );
}

/** Inline chip showing the discount the agent committed to on this turn. */
export function DiscountChip({ pct }: { pct?: number | null }) {
  if (!pct || pct <= 0) return null;
  return (
    <span
      title={`Discount offered on this turn: ${pct}%`}
      className="inline-flex items-center bg-ff-orange/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-ff-orange"
    >
      −{pct}%
    </span>
  );
}

/** Click handler shared by Transcript + ChatView rows. Dispatches the
 *  seek-audio event the player listens for. Wrapped so behavior stays
 *  consistent between the two views. */
function seekAudioTo(offsetSec: number | null | undefined): void {
  if (typeof offsetSec !== 'number') return;
  window.dispatchEvent(
    new CustomEvent<SeekAudioDetail>(SEEK_AUDIO_EVENT, {
      detail: { offsetSec },
    }),
  );
}

/** Colored dot next to the objection chip — telegraphs caller emotional state
 *  at a glance. Green=POSITIVE, red=NEGATIVE, gray-muted=NEUTRAL/none. */
export function SentimentDot({
  sentiment,
  className,
}: {
  sentiment?: string | null;
  className?: string;
}) {
  if (!sentiment) return null;
  const cls =
    sentiment === 'POSITIVE'
      ? 'bg-emerald-500'
      : sentiment === 'NEGATIVE'
        ? 'bg-destructive'
        : 'bg-muted-foreground/50';
  return (
    <span
      title={`sentiment: ${sentiment.toLowerCase()}`}
      aria-label={`sentiment ${sentiment.toLowerCase()}`}
      className={cn('inline-block size-1.5 shrink-0', cls, className)}
    />
  );
}

interface TranscriptProps {
  turns: TranscriptTurn[];
  emptyHint?: string;
  /** When true the transcript fills its parent's height (with internal
   *  scroll) instead of letting the document scroll. Parent must be a
   *  flex container that supplies a definite height. */
  fill?: boolean;
}

export function Transcript({ turns, emptyHint, fill = false }: TranscriptProps) {
  const visible = turns.filter((t) => {
    const hasText = t.utterance.trim().length > 0;
    const hasChips =
      !!t.toolCalled ||
      (t.observations && t.observations.length > 0) ||
      !!t.objectionType;
    return hasText || hasChips;
  });
  if (visible.length === 0) {
    return (
      <p
        className={cn(
          'px-6 py-12 text-center text-sm text-muted-foreground',
          fill && 'flex min-h-0 flex-1 items-center justify-center py-0',
        )}
      >
        {emptyHint ?? 'No turns yet.'}
      </p>
    );
  }
  return (
    <ul
      className={cn(
        'divide-y',
        fill && 'min-h-0 flex-1 overflow-y-auto',
      )}
    >
      {visible.map((turn, i) => {
        const seekable = typeof turn.offsetSec === 'number';
        return (
        <li
          key={i}
          data-turn-index={turn.turnNumber ?? undefined}
          onClick={seekable ? () => seekAudioTo(turn.offsetSec) : undefined}
          onKeyDown={
            seekable
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    seekAudioTo(turn.offsetSec);
                  }
                }
              : undefined
          }
          role={seekable ? 'button' : undefined}
          tabIndex={seekable ? 0 : undefined}
          title={seekable ? 'Click to play this moment in the recording' : undefined}
          className={cn(
            'turn-row flex gap-4 px-6 py-4 transition-colors',
            turn.speaker === 'AGENT' ? 'bg-secondary/30' : '',
            seekable && 'cursor-pointer hover:bg-secondary/60 focus:outline-none focus:ring-1 focus:ring-ring',
          )}
        >
          <div className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {turn.speaker === 'AGENT' ? (
              <span className="text-ff-orange">Agent</span>
            ) : (
              <span>Caller</span>
            )}
          </div>
          <div className="flex-1 space-y-2">
            {turn.utterance.trim() ? (
              <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                {turn.utterance}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {turn.objectionType ? (
                <Badge variant="outline" className="font-normal">
                  <SentimentDot sentiment={turn.sentiment} className="mr-1.5" />
                  {turn.objectionType.replaceAll('_', ' ')}
                </Badge>
              ) : turn.sentiment ? (
                <Badge variant="outline" className="font-normal text-[10px] uppercase tracking-wide">
                  <SentimentDot sentiment={turn.sentiment} className="mr-1.5" />
                  {turn.sentiment.toLowerCase()}
                </Badge>
              ) : null}
              {turn.speaker === 'AGENT' ? <PushAttemptChip attempt={turn.pushAttempt} /> : null}
              {turn.speaker === 'USER' ? <LatencyChip ms={turn.responseLatencyMs} /> : null}
              <DiscountChip pct={turn.discountOffered} />
              {(turn.observations ?? []).map((obs, idx) => (
                <Badge key={`${obs.name}-${idx}`} variant="info" className="font-normal">
                  <Wrench className="mr-1 size-3" />
                  {obs.name}
                  {obs.args
                    ? ` (${Object.entries(obs.args)
                        .filter(([, v]) => v !== null && v !== undefined && v !== '')
                        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                        .join(', ')})`
                    : ''}
                </Badge>
              ))}
              {turn.toolCalled ? (
                <Badge variant="ff" className="font-normal">
                  <Wrench className="mr-1 size-3" />
                  {turn.toolCalled}
                  {turn.toolArgs
                    ? ` (${Object.entries(turn.toolArgs as Record<string, unknown>)
                        .filter(([, v]) => v !== null && v !== undefined && v !== '')
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(', ')})`
                    : ''}
                </Badge>
              ) : null}
              {turn.timestamp ? (
                <span
                  className="ml-auto text-xs text-muted-foreground tabular-nums"
                  suppressHydrationWarning
                >
                  {new Date(turn.timestamp).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          </div>
        </li>
        );
      })}
    </ul>
  );
}
