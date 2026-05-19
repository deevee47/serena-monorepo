import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CaretLeft, Broadcast } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { CallInsightsSection } from '@/components/call-insights-section';
import { CallKpiStrip } from '@/components/call-kpi-strip';
import { CallScrubber } from '@/components/call-scrubber';
import { ConversationTabs } from '@/components/conversation-tabs';
import { DownloadRecordingButton } from '@/components/download-recording-button';
import { PageHeader } from '@/components/page-header';
import { PlatformBadge } from '@/components/platform-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToolTimeline, buildToolTimeline } from '@/components/tool-timeline';
import type { ServiceConcern } from '@/components/insight-concerns-card';
import type { InsightTag } from '@/components/insight-tags-card';
import { loadCallDetail } from '@/lib/db-queries';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ callId: string }>;
}) {
  const { callId: raw } = await params;
  // Telnyx Call Control IDs (`v3:...`) contain a colon, which is a reserved
  // char in URL path segments. Decode defensively so the DB lookup matches
  // whether the link came from <Link> (encoded), a direct paste (raw), or
  // an external referrer. decodeURIComponent is a no-op on already-decoded
  // strings, so it's safe to apply unconditionally.
  const callId = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const call = await loadCallDetail(callId);
  if (!call) notFound();

  const inFlight = call.endedAt === null;

  // Caller-turn sentiment counts — fed into the KPI strip's microbar so
  // ops can sense "60% NEGATIVE" without opening the insights accordion.
  const sentimentCounts = call.turns.reduce(
    (acc, t) => {
      if (t.speaker !== 'USER' || !t.sentiment) return acc;
      const s = t.sentiment as 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
      acc[s] = (acc[s] ?? 0) + 1;
      acc.total += 1;
      return acc;
    },
    { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0, total: 0 },
  );

  const timelineEvents = buildToolTimeline(
    call.turns.map((t) => ({
      speaker: t.speaker as 'USER' | 'AGENT',
      turnNumber: t.turnNumber,
      toolCalled: t.toolCalled,
      toolArgs: t.toolArgs,
      observationsCalled: t.observationsCalled,
      timestamp: t.createdAt,
    })),
  );

  // Offset from call.createdAt — used by ChatView / Transcript rows to seek
  // the recording on click. Stored as seconds (float, the audio element's
  // currentTime native unit). Recordings start a few ticks before the first
  // user turn, so a small negative offset can occur — clamp to 0.
  const callStartMs = new Date(call.createdAt).getTime();
  const conversationTurns = call.turns.map((t) => ({
    turnNumber: t.turnNumber,
    speaker: t.speaker as 'USER' | 'AGENT',
    utterance: t.utterance,
    objectionType: t.objectionType,
    sentiment: (t.sentiment ?? null) as
      | 'POSITIVE'
      | 'NEGATIVE'
      | 'NEUTRAL'
      | null,
    toolCalled: t.toolCalled,
    toolArgs: t.toolArgs,
    observations: Array.isArray(t.observationsCalled)
      ? (t.observationsCalled as Array<{ name: string; args?: Record<string, unknown> }>)
      : undefined,
    timestamp: t.createdAt,
    offsetSec: Math.max(0, (new Date(t.createdAt).getTime() - callStartMs) / 1000),
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={`Call ${callId.slice(0, 8)}…`}
        description={`${call.phoneNumber ?? 'Unknown number'} • ${formatRelative(call.createdAt)}`}
        breadcrumbs={[
          { label: 'Overview', href: '/' },
          { label: 'Calls', href: '/calls' },
          { label: `${callId.slice(0, 8)}…` },
        ]}
        action={
          <div className="flex items-center gap-2">
            <PlatformBadge provider={call.voiceProvider} />
            <Button asChild variant="ghost">
              <Link href="/calls">
                <CaretLeft className="size-4" />
                All calls
              </Link>
            </Button>
            {inFlight ? (
              <Button asChild variant="ff">
                <Link href={`/live/${encodeURIComponent(callId)}`}>
                  <Broadcast className="size-4" />
                  Tail live
                </Link>
              </Button>
            ) : (
              <DownloadRecordingButton
                callId={callId}
                filenameBase={`serena-call-${call.customer?.name?.replace(/\s+/g, '-').toLowerCase() ?? callId.slice(0, 8)}`}
              />
            )}
          </div>
        }
      />

      {/* ── Cockpit body ─────────────────────────────────────────────────
          Left rail (~38%) holds compressed meta — KPI strip + collapsible
          sections for Insights / Customer / Tool calls. The rail itself
          scrolls when its content overflows the viewport.

          Right pane holds the scrubber (natural height) and the conversation
          card (flex-1 fills the rest, only the chat/transcript body scrolls).

          Below `lg`, the layout collapses to a single column and reverts to
          normal document flow so it's still usable on tablet / mobile. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 lg:flex-row">
        <aside className="flex min-h-0 w-full shrink-0 flex-col gap-3 lg:w-[420px] xl:w-[460px]">
          <CallKpiStrip
            outcome={call.outcome}
            durationSeconds={call.durationSeconds}
            planId={call.productId}
            coupon={call.discountGiven > 0 ? `−${call.discountGiven}%` : null}
            sentiment={sentimentCounts}
          />

          {/* ── Rail tabs ──────────────────────────────────────────
              Replaces the previous stacked-accordion rail. Tabs are
              denser, swap in O(1), and let the rail itself stop
              scrolling — only the active tab body scrolls when its
              content overflows. */}
          <Tabs
            defaultValue="insights"
            className="flex min-h-0 flex-1 flex-col border border-border/80 bg-card"
          >
            <TabsList className="h-auto w-full justify-start gap-0 border-b border-border/60 bg-transparent p-0">
              <RailTab value="insights">Insights</RailTab>
              {call.customer ? <RailTab value="customer">Customer</RailTab> : null}
              <RailTab value="tools" count={timelineEvents.length}>
                Tools
              </RailTab>
            </TabsList>

            <TabsContent
              value="insights"
              className="m-0 min-h-0 flex-1 overflow-y-auto p-3"
            >
              <CallInsightsSection
                callId={callId}
                callInFlight={inFlight}
                compact
                initial={
                  call.insight
                    ? {
                        status: call.insight.status as 'PENDING' | 'READY' | 'FAILED',
                        summary: call.insight.summary,
                        overallSentiment: call.insight.overallSentiment as
                          | 'POSITIVE'
                          | 'NEUTRAL'
                          | 'NEGATIVE'
                          | 'MIXED',
                        emotions: call.insight.emotions,
                        sentimentTrend: call.insight.sentimentTrend as
                          | 'improving'
                          | 'degrading'
                          | 'stable',
                        sentimentConfidence: call.insight.sentimentConfidence,
                        serviceConcerns:
                          (call.insight.serviceConcerns as unknown as ServiceConcern[]) ?? [],
                        tags: (call.insight.tags as unknown as InsightTag[]) ?? [],
                        fallbackUsed: call.insight.fallbackUsed,
                        errorMessage: call.insight.errorMessage,
                      }
                    : null
                }
              />
            </TabsContent>

            {call.customer ? (
              <TabsContent
                value="customer"
                className="m-0 min-h-0 flex-1 overflow-y-auto p-3"
              >
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <Field label="Name" value={call.customer.name ?? '—'} />
                  <Field label="Email" value={call.customer.email ?? '—'} />
                  <Field
                    label="LTV"
                    value={`$${Number(call.customer.lifetimeValue).toFixed(0)}`}
                  />
                  <Field label="Segment" value={call.customer.segment} />
                </dl>
              </TabsContent>
            ) : null}

            <TabsContent
              value="tools"
              className="m-0 min-h-0 flex-1 overflow-y-auto p-3"
            >
              <ToolTimeline events={timelineEvents} compact />
            </TabsContent>
          </Tabs>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {/* The scrubber doubles as the audio player when the call has
              ended (`callId` toggles audio integration on). For in-flight
              calls we omit `callId` so it stays a passive timeline — the
              recording doesn't exist yet. */}
          <CallScrubber
            callStartedAt={call.createdAt}
            callEndedAt={call.endedAt}
            durationSeconds={call.durationSeconds}
            outcome={call.outcome}
            callId={inFlight ? undefined : callId}
            turns={conversationTurns.map((t) => ({
              turnNumber: t.turnNumber!,
              speaker: t.speaker,
              utterance: t.utterance,
              sentiment: t.sentiment,
              toolCalled: t.toolCalled,
              observations: t.observations
                ? t.observations.map((o) => ({ name: o.name }))
                : null,
              timestamp: t.timestamp,
            }))}
          />

          <ConversationTabs
            turns={conversationTurns}
            fillHeight
            emptyHint="No turns recorded for this call yet."
            copyHeader={[
              'Serena call',
              call.customer?.name ?? call.phoneNumber ?? null,
              new Date(call.createdAt).toLocaleString(),
            ]
              .filter(Boolean)
              .join(' — ')}
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate text-foreground">{value}</dd>
    </>
  );
}

/** Tab trigger styled for the cockpit rail — flush-fitting, micro-caps
 *  Space-Mono label, optional count chip, sharp 90° corners, active state
 *  uses a subtle secondary fill instead of shadcn's default elevated card. */
function RailTab({
  value,
  count,
  children,
}: {
  value: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      className="flex-1 border-r border-border/60 px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground last:border-r-0 data-[state=active]:bg-secondary/60 data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
      {count != null && count > 0 ? (
        <span className="ml-1.5 tabular-nums text-muted-foreground/80">{count}</span>
      ) : null}
    </TabsTrigger>
  );
}
