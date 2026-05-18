'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { InsightSummaryCard } from '@/components/insight-summary-card';
import { InsightSentimentCard } from '@/components/insight-sentiment-card';
import {
  InsightConcernsCard,
  type ServiceConcern,
} from '@/components/insight-concerns-card';
import {
  InsightTagsCard,
  type InsightTag,
} from '@/components/insight-tags-card';

type Overall = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'MIXED';
type Trend = 'improving' | 'degrading' | 'stable';
type Status = 'PENDING' | 'READY' | 'FAILED' | 'MISSING';

interface InitialInsight {
  status: Status;
  summary: string;
  overallSentiment: Overall;
  emotions: string[];
  sentimentTrend: Trend;
  sentimentConfidence: number;
  serviceConcerns: ServiceConcern[];
  tags: InsightTag[];
  fallbackUsed?: boolean;
  errorMessage?: string | null;
}

interface Props {
  callId: string;
  // null when no insight row exists yet (call just ended, worker not done).
  initial: InitialInsight | null;
  // When true the page is for an in-flight call; we still subscribe to the
  // live SSE stream so the cards hydrate the moment the worker fires.
  callInFlight: boolean;
  /** Single-column layout for the cockpit's left rail; hides the section
   *  title (the rail section provides it) and tightens the surrounding chrome. */
  compact?: boolean;
}

const POLL_INTERVAL_MS = 4_000;
const POLL_MAX_ATTEMPTS = 30; // ~2 minutes; insights typically land in 5-10s.

export function CallInsightsSection({ callId, initial, callInFlight, compact = false }: Props) {
  const [insight, setInsight] = useState<InitialInsight | null>(initial);
  const [regenerating, setRegenerating] = useState(false);
  const pollAttemptsRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status: Status = insight?.status ?? 'MISSING';
  const pending = status === 'PENDING' || status === 'MISSING';

  const fetchInsight = useCallback(async () => {
    try {
      const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/insights`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as InitialInsight;
      setInsight(data);
      return data;
    } catch {
      /* swallow — next poll will retry */
    }
  }, [callId]);

  // Poll when pending and we don't have a live SSE updating us.
  useEffect(() => {
    if (status === 'READY' || status === 'FAILED') {
      pollAttemptsRef.current = 0;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) return;

    pollTimerRef.current = setTimeout(async () => {
      pollAttemptsRef.current += 1;
      await fetchInsight();
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [status, fetchInsight, insight]);

  // Live SSE hydration: when a viewer opens the page right as the call
  // ends, the worker fires `insights_ready` on the bus — apply it without
  // waiting for the next poll tick.
  useEffect(() => {
    if (!callInFlight && status === 'READY') return;

    const es = new EventSource(`/api/live/${encodeURIComponent(callId)}/stream`);
    es.onmessage = (e) => {
      let evt: { type: string } & Record<string, unknown>;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      if (evt.type === 'insights_pending') {
        setInsight((prev) =>
          prev && prev.status === 'READY'
            ? prev
            : ({
                status: 'PENDING',
                summary: '',
                overallSentiment: 'NEUTRAL',
                emotions: [],
                sentimentTrend: 'stable',
                sentimentConfidence: 0,
                serviceConcerns: [],
                tags: [],
              } as InitialInsight),
        );
      } else if (evt.type === 'insights_ready') {
        setInsight({
          status: 'READY',
          summary: evt.summary as string,
          overallSentiment: evt.overallSentiment as Overall,
          emotions: (evt.emotions as string[]) ?? [],
          sentimentTrend: evt.sentimentTrend as Trend,
          sentimentConfidence: (evt.sentimentConfidence as number) ?? 0,
          serviceConcerns: (evt.serviceConcerns as ServiceConcern[]) ?? [],
          tags: (evt.tags as InsightTag[]) ?? [],
        });
      } else if (evt.type === 'insights_failed') {
        setInsight((prev) => ({
          ...(prev ?? {
            status: 'FAILED',
            summary: '',
            overallSentiment: 'NEUTRAL',
            emotions: [],
            sentimentTrend: 'stable',
            sentimentConfidence: 0,
            serviceConcerns: [],
            tags: [],
          }),
          status: 'FAILED',
          errorMessage: (evt.error as string) ?? null,
        }));
      }
    };
    es.onerror = () => {
      // Browser auto-reconnects; we don't surface this — polling is the
      // backstop if SSE never lands.
    };
    return () => es.close();
  }, [callId, callInFlight, status]);

  const onRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      await fetch(`/api/calls/${encodeURIComponent(callId)}/insights/regenerate`, {
        method: 'POST',
      });
      // Flip local state to PENDING; the next SSE/poll cycle will hydrate.
      setInsight((prev) =>
        prev
          ? { ...prev, status: 'PENDING', errorMessage: null }
          : ({
              status: 'PENDING',
              summary: '',
              overallSentiment: 'NEUTRAL',
              emotions: [],
              sentimentTrend: 'stable',
              sentimentConfidence: 0,
              serviceConcerns: [],
              tags: [],
            } as InitialInsight),
      );
      pollAttemptsRef.current = 0;
    } finally {
      setRegenerating(false);
    }
  }, [callId]);

  const statusChip =
    status === 'PENDING' || status === 'MISSING' ? (
      <span className="text-xs text-muted-foreground">Generating…</span>
    ) : status === 'FAILED' ? (
      <span className="text-xs text-destructive">
        Failed{insight?.errorMessage ? ` — ${insight.errorMessage}` : ''}
      </span>
    ) : null;

  const regenButton =
    status === 'READY' || status === 'FAILED' ? (
      <Button
        size="sm"
        variant="ghost"
        onClick={onRegenerate}
        disabled={regenerating}
      >
        <ArrowsClockwise className="size-3.5" />
        {regenerating ? 'Queuing…' : 'Regenerate'}
      </Button>
    ) : null;

  return (
    <section className={cn(compact ? 'space-y-2' : 'space-y-3')}>
      <div className="flex items-center justify-between">
        {compact ? (
          <div className="flex items-center gap-2">{statusChip}</div>
        ) : (
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Call Insights
          </h2>
        )}
        <div className="flex items-center gap-2">
          {!compact ? statusChip : null}
          {regenButton}
        </div>
      </div>

      <div className={cn('grid gap-4', compact ? 'grid-cols-1' : 'md:grid-cols-2')}>
        <InsightSummaryCard
          summary={status === 'READY' ? insight?.summary ?? null : null}
          fallbackUsed={insight?.fallbackUsed}
          pending={pending}
        />
        <InsightSentimentCard
          overall={status === 'READY' ? insight?.overallSentiment ?? null : null}
          emotions={status === 'READY' ? insight?.emotions ?? [] : []}
          trend={status === 'READY' ? insight?.sentimentTrend ?? null : null}
          confidence={status === 'READY' ? insight?.sentimentConfidence ?? null : null}
          pending={pending}
        />
        <InsightConcernsCard
          concerns={status === 'READY' ? insight?.serviceConcerns ?? [] : []}
          pending={pending}
        />
        <InsightTagsCard
          tags={status === 'READY' ? insight?.tags ?? [] : []}
          pending={pending}
        />
      </div>
    </section>
  );
}
