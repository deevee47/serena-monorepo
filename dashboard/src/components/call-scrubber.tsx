'use client';

import * as React from 'react';
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Pause,
  Play,
  Wrench,
} from '@phosphor-icons/react/dist/ssr';
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
  /** When provided, the scrubber doubles as an audio player:
   *  - fetches the call's recording on mount
   *  - renders a custom play / pause button in the header
   *  - shows a playing playhead that tracks `audio.currentTime`
   *  - clicking the timeline seeks the audio AND scrolls the conversation
   *  - listens for `ff:seek-audio` from chat bubbles + transcript rows */
  callId?: string;
}

/** Custom event the scrubber dispatches when a turn is selected.
 *  ConversationTabs listens for this and scrolls the matching bubble
 *  / row into view. */
export const SCRUB_EVENT = 'ff:scrub-to-turn';

/** Bubble-side seek dispatcher payload: seconds from the start of the
 *  recording. The scrubber listens for this from chat / transcript rows
 *  and `audio.currentTime = detail.offsetSec`. */
export const SEEK_AUDIO_EVENT = 'ff:seek-audio';

export interface SeekAudioDetail {
  offsetSec: number;
}

type RecordingState = 'idle' | 'loading' | 'ready' | 'pending' | 'error';

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
  callId,
}: CallScrubberProps) {
  const [hoverPct, setHoverPct] = React.useState<number | null>(null);

  // ── Audio integration ────────────────────────────────────────────
  // All audio state lives inside the scrubber so the timeline + playback
  // controls share one component. `callId` undefined means no audio
  // integration (e.g. live calls before a recording exists) — the scrubber
  // still renders as a passive timeline.
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [recordingUrl, setRecordingUrl] = React.useState<string | null>(null);
  const [recordingState, setRecordingState] = React.useState<RecordingState>(
    callId ? 'loading' : 'idle',
  );
  const [recordingError, setRecordingError] = React.useState<string | null>(null);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [audioDurationSec, setAudioDurationSec] = React.useState<number | null>(null);
  // ISO string Telnyx reports as `recording_started_at`. When set, becomes
  // the canonical timeline anchor — turn positions and seek offsets are
  // computed against this instead of `call.createdAt`. Null on legacy data
  // or when the provider doesn't expose recording timestamps.
  const [recordingStartedAt, setRecordingStartedAt] = React.useState<string | null>(null);

  // Fetch the recording URL once on mount. The route is idempotent — it
  // always re-fetches the presigned URL from the provider so we never
  // hand a stale link to the audio element.
  React.useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/recording`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        const body = (await res.json().catch(() => null)) as
          | {
              recording_url?: string | null;
              stereo_recording_url?: string | null;
              recording_started_at?: string | null;
              error?: string;
            }
          | null;
        if (!res.ok) {
          if (res.status === 404) {
            setRecordingState('pending');
          } else {
            setRecordingState('error');
            setRecordingError(body?.error ?? `Lookup failed (${res.status})`);
          }
          return;
        }
        const url = body?.stereo_recording_url ?? body?.recording_url ?? null;
        if (!url) {
          setRecordingState('pending');
          return;
        }
        setRecordingUrl(url);
        setRecordingStartedAt(body?.recording_started_at ?? null);
        setRecordingState('ready');
      } catch (err) {
        if (cancelled) return;
        setRecordingState('error');
        setRecordingError(err instanceof Error ? err.message : 'Failed to load recording');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callId]);

  // Bridge for chat bubbles + transcript rows. They dispatch `ff:seek-audio`
  // with an offset computed against `call.createdAt`. The audio file's t=0
  // is `recording_started_at`, which is ~10-15s EARLIER than call.createdAt
  // (Telnyx starts recording when the assistant picks up, while our DB row
  // doesn't exist until the first LLM turn fires). Add that leading gap so
  // the audio lands on the actual moment the operator clicked, not 10s late.
  React.useEffect(() => {
    function onSeek(e: Event) {
      const detail = (e as CustomEvent<SeekAudioDetail>).detail;
      const audio = audioRef.current;
      if (!audio || typeof detail?.offsetSec !== 'number') return;
      const leadingGapSec =
        recordingStartedAt != null
          ? Math.max(
              0,
              (new Date(callStartedAt).getTime() -
                new Date(recordingStartedAt).getTime()) /
                1000,
            )
          : 0;
      audio.currentTime = Math.max(0, detail.offsetSec + leadingGapSec);
      void audio.play().catch(() => undefined);
    }
    window.addEventListener(SEEK_AUDIO_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_AUDIO_EVENT, onSeek);
  }, [callStartedAt, recordingStartedAt]);

  // Sync UI state to the audio element's actual playback state. timeupdate
  // fires ~4-66Hz depending on the browser; cheap enough.
  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onLoaded = () => {
      if (!Number.isNaN(audio.duration) && Number.isFinite(audio.duration)) {
        setAudioDurationSec(audio.duration);
      }
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', onLoaded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('loadedmetadata', onLoaded);
    };
  }, [recordingUrl]);

  const togglePlay = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, []);

  /** Skip helpers for the ±5s buttons. Clamps to [0, duration] so the
   *  audio element never seeks past the end. */
  const skipBy = React.useCallback((deltaSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = audio.duration;
    const target = audio.currentTime + deltaSec;
    audio.currentTime = Math.max(0, Number.isFinite(dur) ? Math.min(dur, target) : target);
  }, []);

  /** Slider input handler. Stops auto-play from firing during a fine-grained
   *  drag (user is exploring, not committing to a play position). */
  const onSliderInput = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Number.parseFloat(e.target.value);
    if (Number.isFinite(next)) audio.currentTime = next;
  }, []);

  // Single source of truth for "how long is the playback timeline" — prefer
  // the audio file's reported duration (precise to ms), fall back to call
  // duration when audio metadata hasn't loaded yet.
  const hasRecording = recordingState === 'ready';

  // Timeline anchor selection:
  //   1. If Telnyx gave us `recording_started_at`, use that AND the audio
  //      file's duration. This matches the audio exactly — turn percentages
  //      and seek offsets line up with what the operator hears.
  //   2. Otherwise fall back to (call.createdAt → call.endedAt) wall-clock,
  //      same as before. Used for live calls, missing recordings, or
  //      providers that don't expose a recording-started timestamp.
  //
  // The 10-15s "leading gap" between when Telnyx answers (recording starts)
  // and when the first LLM turn fires (call.createdAt) is the reason the
  // audio file is ~10-15s longer than the wall-clock window. Anchoring on
  // recording_started_at eliminates the offset.
  const audioAnchored = hasRecording && recordingStartedAt != null && audioDurationSec != null;
  const startMs = audioAnchored
    ? new Date(recordingStartedAt).getTime()
    : new Date(callStartedAt).getTime();
  const endMs = audioAnchored
    ? new Date(recordingStartedAt).getTime() + audioDurationSec * 1000
    : callEndedAt
      ? new Date(callEndedAt).getTime()
      : durationSeconds != null && durationSeconds > 0
        ? new Date(callStartedAt).getTime() + durationSeconds * 1000
        : turns.length
          ? new Date(turns[turns.length - 1].timestamp).getTime() + 2000
          : new Date(callStartedAt).getTime() + 60_000;
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
    // Two behaviors fire together:
    //   1. If the click landed near a turn marker, scroll the conversation
    //      to that turn. Keeps existing scrubber → ConversationTabs wiring.
    //   2. If we have a recording, seek the audio to the clicked position
    //      and start playback. This lets the operator scrub anywhere on the
    //      timeline — not just on turn markers — and immediately hear it.
    if (hoverBar) {
      window.dispatchEvent(
        new CustomEvent(SCRUB_EVENT, { detail: { turnNumber: hoverBar.turnNumber } }),
      );
    }
    if (audioRef.current && hoverPct != null) {
      const dur = audioDurationSec ?? seconds;
      audioRef.current.currentTime = Math.max(0, (hoverPct / 100) * dur);
      void audioRef.current.play().catch(() => undefined);
    }
  }

  // Playing playhead position in [0, 100] — scaled against the audio's own
  // duration so it stays aligned with the file even when call duration
  // differs by a few hundred ms (typical greeting + tail).
  const playbackDur = audioDurationSec ?? seconds;
  const playheadPct = playbackDur > 0 ? Math.min(100, (currentTime / playbackDur) * 100) : 0;

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
      {/* Hidden audio element — custom UI in the header drives it. */}
      {recordingUrl ? (
        <audio
          ref={audioRef}
          src={recordingUrl}
          preload="metadata"
          // No `controls` attribute — we render our own to match the reel.
        />
      ) : null}

      {/* ── Header strip ─────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          <span className="text-foreground/90">Conversation Reel</span>
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

        {/* Playing playhead — solid, opaque, moves with the audio so the
            operator can track where the recording is up to without taking
            their eyes off the timeline. Distinct from the hover playhead's
            translucent orange so the two can coexist on the same plot. */}
        {hasRecording && playbackDur > 0 ? (
          <div
            className="pointer-events-none absolute top-3 bottom-6 w-px bg-foreground/85 shadow-[0_0_6px_rgba(255,255,255,0.4)]"
            style={{ left: `calc(1rem + (100% - 2rem) * ${playheadPct / 100})` }}
            aria-hidden
          />
        ) : null}

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

      {/* ── Player control bar ───────────────────────────────────────────
          Below the graph — clean linear slider + transport buttons + time
          readout. Owns the audio interactions the waveform doesn't (fine
          scrubbing, ±5s nudges, keyboard arrow-key seeks via the slider's
          native role). Only renders when a recording is available; the
          waveform alone is still useful for live / pending calls. */}
      {hasRecording ? (
        <div className="flex items-center gap-3 border-t border-border/60 px-4 py-2.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => skipBy(-5)}
              aria-label="Back 5 seconds"
              className="flex size-7 items-center justify-center border border-border/70 bg-card text-foreground/80 transition-colors hover:border-foreground/40 hover:bg-secondary/60 hover:text-foreground"
              title="−5s"
            >
              <ArrowCounterClockwise className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
              className={cn(
                'flex size-7 items-center justify-center border border-border/70 bg-card text-foreground transition-colors',
                'hover:border-foreground/40 hover:bg-secondary/60',
                isPlaying && 'border-ff-orange/60 bg-ff-orange/10 text-ff-orange',
              )}
            >
              {isPlaying ? (
                <Pause weight="fill" className="size-3.5" />
              ) : (
                <Play weight="fill" className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => skipBy(5)}
              aria-label="Forward 5 seconds"
              className="flex size-7 items-center justify-center border border-border/70 bg-card text-foreground/80 transition-colors hover:border-foreground/40 hover:bg-secondary/60 hover:text-foreground"
              title="+5s"
            >
              <ArrowClockwise className="size-3.5" />
            </button>
          </div>
          {/* Long progress slider — native <input type=range> for free
              keyboard / a11y support, restyled in globals.css under
              `.scrubber-range` to match the reel aesthetic. Step granularity
              is 0.1s so dragging feels precise without the audio element
              spamming `currentTime` faster than it can re-buffer. */}
          <input
            type="range"
            className="scrubber-range flex-1 cursor-pointer"
            min={0}
            max={playbackDur > 0 ? playbackDur : 1}
            step={0.1}
            value={currentTime}
            onChange={onSliderInput}
            aria-label="Seek recording"
            // CSS custom property the .scrubber-range track uses to draw the
            // filled portion. Chromium can't natively style the "progress"
            // half of a range input, so we paint it via a gradient stop.
            style={
              {
                '--scrubber-range-progress': `${playheadPct}%`,
              } as React.CSSProperties
            }
          />
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] tabular-nums text-muted-foreground">
            <span className="text-foreground/90">{mmss(currentTime)}</span>
            <span className="opacity-50"> / </span>
            <span>{mmss(playbackDur)}</span>
          </span>
        </div>
      ) : null}

      {/* Recording status footer — only renders when the recording isn't
          ready, so the operator knows the play controls are intentionally
          absent. Pulls double-duty as the error surface. */}
      {recordingState === 'pending' || recordingState === 'error' ? (
        <div
          className={cn(
            'border-t px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em]',
            recordingState === 'pending'
              ? 'border-border/60 text-muted-foreground'
              : 'border-destructive/40 bg-destructive/5 text-destructive',
          )}
        >
          {recordingState === 'pending'
            ? 'Recording pending — usually arrives within a minute of hangup.'
            : `Recording error: ${recordingError ?? 'unknown'}`}
        </div>
      ) : null}
    </section>
  );
}
