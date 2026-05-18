'use client';

import * as React from 'react';
import { Wrench } from '@phosphor-icons/react/dist/ssr';
import { cn } from '@/lib/utils';

export interface ScrubberTurn {
  turnNumber: number;
  speaker: 'USER' | 'AGENT';
  utterance: string;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  toolCalled?: string | null;
  observations?: Array<{ name: string }> | null;
  timestamp: string | Date;
}

interface CallScrubberProps {
  callStartedAt: string | Date;
  callEndedAt?: string | Date | null;
  durationSeconds?: number | null;
  outcome?: string | null;
  turns: ScrubberTurn[];
}

/** Custom event the scrubber dispatches when a turn is selected.
 *  ConversationTabs listens for this and scrolls the matching bubble
 *  / row into view. */
export const SCRUB_EVENT = 'ff:scrub-to-turn';

interface Bar {
  pct: number;
  h: number;
  speaker: 'USER' | 'AGENT';
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  toolCalled: string | null;
  observations: Array<{ name: string }>;
  turnNumber: number;
  utterance: string;
}

function mmss(s: number): string {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(Math.round(s));
  return `${sign}${Math.floor(a / 60)
    .toString()
    .padStart(2, '0')}:${(a % 60).toString().padStart(2, '0')}`;
}

function nearest(bars: Bar[], pct: number): Bar | null {
  let best: Bar | null = null;
  let bestD = Infinity;
  for (const b of bars) {
    const d = Math.abs(b.pct - pct);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

export function CallScrubber({
  callStartedAt,
  callEndedAt,
  durationSeconds,
  outcome,
  turns,
}: CallScrubberProps) {
  const [hoverPct, setHoverPct] = React.useState<number | null>(null);

  const startMs = new Date(callStartedAt).getTime();
  const endMs = callEndedAt
    ? new Date(callEndedAt).getTime()
    : durationSeconds != null && durationSeconds > 0
      ? startMs + durationSeconds * 1000
      : turns.length
        ? new Date(turns[turns.length - 1].timestamp).getTime() + 2000
        : startMs + 60_000;
  const totalMs = Math.max(1, endMs - startMs);
  const seconds = Math.max(1, Math.round(totalMs / 1000));

  const bars: Bar[] = turns
    .map((t) => {
      const tMs = new Date(t.timestamp).getTime();
      const pct = ((tMs - startMs) / totalMs) * 100;
      const len = (t.utterance ?? '').trim().length;
      // Log-scale so a 600-char monologue doesn't crush the rest.
      const h = Math.max(8, Math.min(78, Math.log2(len + 2) * 11));
      return {
        pct: Math.max(0, Math.min(100, pct)),
        h,
        speaker: t.speaker,
        sentiment: t.sentiment ?? null,
        toolCalled: t.toolCalled ?? null,
        observations: t.observations ?? [],
        turnNumber: t.turnNumber,
        utterance: t.utterance ?? '',
      };
    })
    .sort((a, b) => a.pct - b.pct);

  // For each USER turn, paint a sentiment segment that extends until the
  // next USER turn (or the end of the call). Reads as a single coloured
  // strip along the top of the reel.
  const userBars = bars.filter((b) => b.speaker === 'USER');
  const sentimentSegments = userBars.map((b, i) => {
    const next = userBars[i + 1];
    return {
      from: b.pct,
      to: next ? next.pct : 100,
      sentiment: (b.sentiment ?? 'NEUTRAL') as 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL',
    };
  });

  // Tool markers: any turn that fired a side-effect tool OR ran observations.
  const toolMarkers = bars
    .filter((b) => b.toolCalled || b.observations.length > 0)
    .map((b) => ({
      pct: b.pct,
      label: b.toolCalled ?? b.observations.map((o) => o.name).join(', '),
      turnNumber: b.turnNumber,
      kind: b.toolCalled ? ('action' as const) : ('observation' as const),
    }));

  // Ruler tick spacing — adaptive to call length.
  const tickStepS =
    seconds <= 30 ? 5 : seconds <= 90 ? 15 : seconds <= 300 ? 30 : seconds <= 900 ? 60 : 120;
  const ticks: number[] = [];
  for (let s = 0; s <= seconds; s += tickStepS) ticks.push(s);
  if (ticks[ticks.length - 1] !== seconds) ticks.push(seconds);

  const hoverBar = hoverPct != null ? nearest(bars, hoverPct) : null;
  const hoverTimeS = hoverPct != null ? (hoverPct / 100) * seconds : 0;

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setHoverPct(Math.max(0, Math.min(100, pct)));
  }

  function handleClick() {
    if (!hoverBar) return;
    window.dispatchEvent(
      new CustomEvent(SCRUB_EVENT, { detail: { turnNumber: hoverBar.turnNumber } }),
    );
  }

  const outcomeColor =
    outcome === 'CONVERTED'
      ? 'bg-emerald-500'
      : outcome === 'DROPPED'
        ? 'bg-destructive'
        : outcome === 'NO_ANSWER'
          ? 'bg-muted-foreground/70'
          : outcome === 'ERROR'
            ? 'bg-destructive/70'
            : 'bg-muted-foreground/40';

  return (
    <section
      aria-label="Call timeline scrubber"
      className="scrubber relative overflow-hidden border border-border/80 bg-card"
    >
      {/* ── Header strip ─────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          <span className="text-foreground/90">Conversation Reel</span>
          <span aria-hidden className="size-1 bg-border" />
          <span className="tabular-nums text-foreground/80">{mmss(seconds)}</span>
          <span aria-hidden className="size-1 bg-border" />
          <span className="tabular-nums">{turns.length} turns</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1.5 bg-ff-orange" />
            Agent
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1.5 bg-foreground/70" />
            Caller
          </span>
          {outcome ? (
            <span className="flex items-center gap-1.5">
              <span className={cn('inline-block size-1.5', outcomeColor)} />
              <span className="text-foreground/80">{outcome.replace('_', ' ')}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Plot area ────────────────────────────────────── */}
      <div
        className="scrubber-plot relative h-[180px] cursor-crosshair select-none px-4 pt-3 pb-1"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverPct(null)}
        onClick={handleClick}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={seconds}
        aria-valuenow={Math.round(hoverTimeS)}
        aria-label="Drag to scrub through the call"
      >
        {/* Sentiment heat band — top edge */}
        <div className="absolute left-4 right-4 top-3 h-1.5 bg-muted/50">
          {sentimentSegments.map((s, i) => (
            <span
              key={i}
              className={cn(
                'absolute top-0 bottom-0',
                s.sentiment === 'POSITIVE' && 'bg-emerald-500/70',
                s.sentiment === 'NEGATIVE' && 'bg-destructive/70',
                s.sentiment === 'NEUTRAL' && 'bg-muted-foreground/40',
              )}
              style={{ left: `${s.from}%`, width: `${Math.max(0, s.to - s.from)}%` }}
            />
          ))}
        </div>

        {/* Tool markers strip */}
        <div className="pointer-events-none absolute left-4 right-4 top-6 h-5">
          {toolMarkers.map((m, i) => (
            <span
              key={`${m.turnNumber}-${i}`}
              title={`${m.kind === 'action' ? '→' : '○'} ${m.label}`}
              className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${m.pct}%` }}
            >
              <Wrench
                className={cn(
                  'size-3',
                  m.kind === 'action' ? 'text-ff-orange' : 'text-muted-foreground',
                )}
                weight={m.kind === 'action' ? 'fill' : 'regular'}
              />
              <span
                className={cn(
                  'mt-px block w-px h-1',
                  m.kind === 'action' ? 'bg-ff-orange/50' : 'bg-muted-foreground/30',
                )}
              />
            </span>
          ))}
        </div>

        {/* Waveform — bars mirrored around the horizon */}
        <svg
          aria-hidden
          className="absolute left-4 right-4 top-[44px] h-[100px] text-foreground"
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          style={{ width: 'calc(100% - 2rem)' }}
        >
          {/* horizon hairline */}
          <line
            x1="0"
            x2="1000"
            y1="50"
            y2="50"
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeWidth="0.6"
          />
          {bars.map((b, i) => {
            const x = (b.pct / 100) * 1000;
            const isAgent = b.speaker === 'AGENT';
            return (
              <rect
                key={i}
                x={x - 1}
                y={50 - b.h / 2}
                width="2"
                height={b.h}
                fill={isAgent ? 'var(--ff-orange)' : 'currentColor'}
                opacity={isAgent ? 0.85 : 0.55}
              />
            );
          })}
        </svg>

        {/* Ruler */}
        <div className="pointer-events-none absolute bottom-1 left-4 right-4 h-5">
          {ticks.map((s) => {
            const pct = Math.min(100, (s / seconds) * 100);
            return (
              <div
                key={s}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
                style={{ left: `${pct}%` }}
              >
                <span className="block h-1.5 w-px bg-foreground/25" />
                <span className="mt-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
                  {mmss(s)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Hover playhead + tooltip */}
        {hoverPct != null ? (
          <>
            <div
              className="pointer-events-none absolute top-3 bottom-6 w-px bg-ff-orange/80"
              style={{ left: `calc(1rem + (100% - 2rem) * ${hoverPct / 100})` }}
            />
            {hoverBar ? (
              <div
                className="pointer-events-none absolute z-10 max-w-xs border border-border/80 bg-popover px-3 py-2 text-popover-foreground shadow-[0_18px_40px_-20px_rgba(0,0,0,0.45)]"
                style={{
                  left: `calc(1rem + (100% - 2rem) * ${hoverPct / 100})`,
                  top: 12,
                  transform:
                    hoverPct > 65
                      ? 'translateX(calc(-100% - 10px))'
                      : 'translateX(10px)',
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
                  <span>
                    {hoverBar.speaker === 'AGENT' ? (
                      <span className="text-ff-orange">Agent</span>
                    ) : (
                      <span className="text-foreground/80">Caller</span>
                    )}
                    <span className="mx-1.5 opacity-50">·</span>
                    Turn {hoverBar.turnNumber}
                  </span>
                  <span className="tabular-nums">{mmss(hoverTimeS)}</span>
                </div>
                <p className="line-clamp-3 text-[12px] leading-snug">
                  {hoverBar.utterance.trim() || (
                    <em className="text-muted-foreground">silent turn</em>
                  )}
                </p>
                {hoverBar.toolCalled || hoverBar.observations.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-2 font-mono text-[9px] uppercase tracking-[0.18em]">
                    {hoverBar.toolCalled ? (
                      <span className="text-ff-orange">→ {hoverBar.toolCalled}</span>
                    ) : null}
                    {hoverBar.observations.map((o, i) => (
                      <span key={i} className="text-muted-foreground">○ {o.name}</span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">
                  click to jump
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
