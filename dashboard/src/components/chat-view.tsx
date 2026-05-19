'use client';

import * as React from 'react';
import { Sparkle, User, Wrench } from '@phosphor-icons/react/dist/ssr';
import { Badge } from '@/components/ui/badge';
import { SEEK_AUDIO_EVENT, type SeekAudioDetail } from '@/components/call-scrubber';
import { cn } from '@/lib/utils';
import { SentimentDot, type TranscriptTurn } from '@/components/transcript';

/** Bubble-side seek dispatcher. Mirrors the one in Transcript so both
 *  views feel identical when clicked. */
function seekAudioTo(offsetSec: number | null | undefined): void {
  if (typeof offsetSec !== 'number') return;
  window.dispatchEvent(
    new CustomEvent<SeekAudioDetail>(SEEK_AUDIO_EVENT, {
      detail: { offsetSec },
    }),
  );
}

interface ChatViewProps {
  turns: TranscriptTurn[];
  thinking?: boolean;
  thinkingTool?: string | null;
  emptyHint?: string;
  agentLabel?: string;
  callerLabel?: string;
  /** When true the chat fills its parent's height instead of capping at
   *  60vh — required for the cockpit layout where the conversation card
   *  owns the right column. Parent must be a flex container that supplies
   *  a definite height. */
  fill?: boolean;
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export function ChatView({
  turns,
  thinking = false,
  thinkingTool,
  emptyHint,
  agentLabel = 'Sera',
  callerLabel = 'Caller',
  fill = false,
}: ChatViewProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new content.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, thinking, thinkingTool]);

  // Drop turns with no text AND no chips — they were dead air the brain
  // produced and there's nothing useful to render.
  const visibleTurns = turns.filter((t) => {
    const hasText = t.utterance.trim().length > 0;
    const hasChips =
      !!t.toolCalled ||
      (t.observations && t.observations.length > 0) ||
      !!t.objectionType;
    return hasText || hasChips;
  });

  if (visibleTurns.length === 0 && !thinking) {
    return (
      <div
        className={cn(
          'flex items-center justify-center px-6 text-sm text-muted-foreground',
          fill ? 'min-h-0 flex-1' : 'h-64',
        )}
      >
        {emptyHint ?? 'No messages yet.'}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        'space-y-4 overflow-y-auto px-4 py-4 sm:px-6',
        fill ? 'min-h-0 flex-1' : 'max-h-[60vh]',
      )}
    >
      {visibleTurns.map((turn, i) => {
        const isAgent = turn.speaker === 'AGENT';
        const hasText = turn.utterance.trim().length > 0;
        const seekable = typeof turn.offsetSec === 'number';
        return (
          <div
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
              'turn-row flex w-full gap-3 transition-colors',
              isAgent ? 'justify-start' : 'justify-end',
              seekable && 'cursor-pointer rounded-md hover:bg-secondary/40 focus:outline-none focus:ring-1 focus:ring-ring -mx-2 px-2 py-1',
            )}
          >
            {isAgent ? (
              <div className="flex size-8 shrink-0 items-center justify-center bg-ff-orange text-white">
                <Sparkle weight="fill" className="size-4" />
              </div>
            ) : null}
            <div className={cn('flex max-w-[78%] flex-col gap-1.5', isAgent ? 'items-start' : 'items-end')}>
              {hasText ? (
                <div
                  className={cn(
                    'px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap',
                    isAgent
                      ? 'bg-muted text-foreground'
                      : 'bg-primary text-primary-foreground',
                  )}
                >
                  {turn.utterance}
                </div>
              ) : null}
              <div
                className={cn(
                  'flex flex-wrap items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground',
                  isAgent ? 'justify-start' : 'justify-end',
                )}
              >
                {(turn.observations ?? []).map((obs, idx) => (
                  <Badge key={`${obs.name}-${idx}`} variant="info" className="font-normal text-[10px]">
                    <Wrench className="mr-1 size-3" />
                    {obs.name}
                    <span className="ml-1 opacity-70">{formatArgs(obs.args)}</span>
                  </Badge>
                ))}
                {turn.toolCalled ? (
                  <Badge variant="ff" className="font-normal text-[10px]">
                    <Wrench className="mr-1 size-3" />
                    {turn.toolCalled}
                    <span className="ml-1 opacity-70">{formatArgs(turn.toolArgs)}</span>
                  </Badge>
                ) : null}
                {turn.objectionType ? (
                  <Badge variant="outline" className="font-normal text-[10px]">
                    <SentimentDot sentiment={turn.sentiment} className="mr-1.5" />
                    {turn.objectionType.replaceAll('_', ' ')}
                  </Badge>
                ) : turn.sentiment ? (
                  <Badge variant="outline" className="font-normal text-[10px] uppercase">
                    <SentimentDot sentiment={turn.sentiment} className="mr-1.5" />
                    {turn.sentiment.toLowerCase()}
                  </Badge>
                ) : null}
                <span suppressHydrationWarning>
                  {isAgent ? agentLabel : callerLabel}
                  {turn.timestamp
                    ? ` · ${new Date(turn.timestamp).toLocaleTimeString()}`
                    : ''}
                </span>
              </div>
            </div>
            {!isAgent ? (
              <div className="flex size-8 shrink-0 items-center justify-center bg-secondary text-secondary-foreground">
                <User weight="fill" className="size-4" />
              </div>
            ) : null}
          </div>
        );
      })}

      {thinking ? (
        <div className="flex w-full justify-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center bg-ff-orange text-white">
            <Sparkle weight="fill" className="size-4" />
          </div>
          <div className="flex flex-col gap-1.5 items-start">
            <div className="flex items-center gap-1.5 bg-muted px-3.5 py-2 text-sm text-muted-foreground">
              {thinkingTool ? (
                <>
                  <Wrench className="size-3" />
                  <span>Calling {thinkingTool}…</span>
                </>
              ) : (
                <TypingDots />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-1 py-1" aria-label="Thinking">
      <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: '0ms' }} />
      <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: '150ms' }} />
      <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: '300ms' }} />
    </span>
  );
}
