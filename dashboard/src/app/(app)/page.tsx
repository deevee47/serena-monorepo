import Link from 'next/link';
import { ArrowRight, PhoneOutgoing } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { ActiveCallsPanel } from '@/components/overview/active-calls-panel';
import { DailyTrend } from '@/components/overview/daily-trend';
import { HourlyDensity } from '@/components/overview/hourly-density';
import { RecentCallsPanel } from '@/components/overview/recent-calls-panel';
import { TopList } from '@/components/overview/top-list';
import {
  loadActiveCalls,
  loadCallList,
  loadOverviewStats,
} from '@/lib/db-queries';
import { cn, formatDuration } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [stats, recent, active] = await Promise.all([
    loadOverviewStats(),
    loadCallList({ take: 50 }),
    loadActiveCalls(),
  ]);

  const totalTime = formatTotalCallTime(stats.totalDurationAllTimeSec);

  const activeCalls = active.map((c) => ({
    callId: c.callId,
    createdAt: c.createdAt,
    phoneNumber: c.phoneNumber,
    customerName: c.customer?.name ?? null,
    turnCount: c._count.turns,
  }));

  const totalSentiment =
    stats.sentimentMix7d.positive +
    stats.sentimentMix7d.neutral +
    stats.sentimentMix7d.negative;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Overview"
        description="Live snapshot of the Serena voice agent."
        action={
          <Button asChild variant="ff">
            <Link href="/trigger">
              <PhoneOutgoing className="size-4" />
              Trigger outbound call
            </Link>
          </Button>
        }
      />

      {/* ── Cockpit body ──────────────────────────────────────────────
          Three rows: KPI strip → mini-charts row → main grid. Each row
          has a fixed-ish height (the main grid claims flex-1). The page
          itself doesn't scroll; only the recent-calls table scrolls
          internally when it overflows. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
        {/* Row A · KPI strip (6 cells) */}
        <Panel>
          <ul className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
            <KpiCell
              label="Calls today"
              value={stats.callsToday.toLocaleString()}
              hint={`${stats.callsAllTime.toLocaleString()} all-time`}
            />
            <KpiCell
              label="Conversion today"
              value={`${stats.conversionToday}%`}
              hint={`${stats.conversionAllTime}% all-time`}
              accent="ff"
            />
            <KpiCell
              label="Active now"
              value={stats.activeNow.toString()}
              hint="In flight (no end report)"
              pulse={stats.activeNow > 0}
            />
            <KpiCell
              label="Avg dur. today"
              value={formatDuration(stats.avgDurationTodaySec)}
              hint={stats.avgDurationTodaySec > 0 ? 'Per call' : 'No data yet'}
            />
            <KpiCell
              label="Total time"
              value={
                <>
                  <span className="text-2xl tabular-nums leading-none">
                    {totalTime.minutes}
                  </span>
                  <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    min
                  </span>
                </>
              }
              hint={totalTime.subscript}
            />
            <KpiCell
              label="Out / In · 7d"
              value={`${stats.outboundLast7d} / ${stats.inboundLast7d}`}
              hint="By call mode"
            />
          </ul>
        </Panel>

        {/* Row B · Mini-charts strip */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel className="h-[160px] p-3">
            <DailyTrend days={stats.dailySeries} />
          </Panel>
          <Panel className="h-[160px] p-3">
            <HourlyDensity hours={stats.hourlyDensity} />
          </Panel>
        </div>

        {/* Row C · Main grid (claims remaining height) */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-12">
          {/* Recent calls — table, internal scroll */}
          <Panel className="flex min-h-0 flex-col lg:col-span-6">
            <PanelHeader
              title="Recent calls"
              right={
                <Link
                  href="/calls"
                  className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  View all
                  <ArrowRight className="size-3" />
                </Link>
              }
            />
            <RecentCallsPanel calls={recent} pageSize={5} />
          </Panel>

          {/* Top {objections, plans, tools} — tabbed so we don't pay
              vertical space for each in turn. */}
          <Panel className="flex min-h-0 flex-col lg:col-span-3">
            <Tabs defaultValue="objections" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="h-auto w-full justify-start gap-0 border-b border-border/60 bg-transparent p-0">
                <OverviewTab value="objections">Objections</OverviewTab>
                <OverviewTab value="products">Products</OverviewTab>
                <OverviewTab value="tools">Tools</OverviewTab>
              </TabsList>
              <TabsContent
                value="objections"
                className="m-0 min-h-0 flex-1 overflow-y-auto p-3"
              >
                <TopList
                  items={stats.topObjectionTypes.map((o) => ({
                    label: o.type,
                    count: o.count,
                    barClass: 'bg-destructive/70',
                  }))}
                  emptyHint="No tagged objections in the last 7 days."
                />
              </TabsContent>
              <TabsContent
                value="products"
                className="m-0 min-h-0 flex-1 overflow-y-auto p-3"
              >
                <TopList
                  items={stats.topProducts.map((p) => ({
                    label: p.productId,
                    count: p.count,
                    secondary: p.converted,
                    barClass: 'bg-ff-orange/70',
                  }))}
                  secondaryLabel="conv"
                  emptyHint="No products called on in the last 7 days."
                />
              </TabsContent>
              <TabsContent
                value="tools"
                className="m-0 min-h-0 flex-1 overflow-y-auto p-3"
              >
                <TopList
                  items={stats.topTools.map((t) => ({
                    label: t.name,
                    count: t.count,
                    barClass: 'bg-sky-500/70',
                  }))}
                  emptyHint="No side-effect tools fired in the last 7 days."
                />
              </TabsContent>
            </Tabs>
          </Panel>

          {/* Right column · Active now (top) + Sentiment mix (bottom) */}
          <div className="flex min-h-0 flex-col gap-3 lg:col-span-3">
            <Panel className="flex min-h-0 flex-1 flex-col">
              <PanelHeader
                title="Active now"
                right={
                  <span className="font-mono text-[10px] tabular-nums text-foreground/80">
                    {activeCalls.length}
                  </span>
                }
              />
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <ActiveCallsPanel calls={activeCalls} />
              </div>
            </Panel>

            <Panel className="shrink-0">
              <PanelHeader title="Sentiment · 7d" />
              <div className="px-3 pb-3">
                {totalSentiment > 0 ? (
                  <SentimentMix mix={stats.sentimentMix7d} total={totalSentiment} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Classifier hasn't tagged any caller turns this week.
                  </p>
                )}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Local UI helpers ─────────────────────────────────────────────────
   Inline because they're hyperspecific to the cockpit layout and reused
   only inside this file — promoting them to /components/ would inflate
   the directory without payoff. */

function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn('border border-border/80 bg-card', className)}
    >
      {children}
    </section>
  );
}

function PanelHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between border-b border-border/60 px-3 py-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-foreground/80">
        {title}
      </h2>
      {right}
    </header>
  );
}

function KpiCell({
  label,
  value,
  hint,
  accent,
  pulse = false,
}: {
  label: string;
  /** String for plain values; ReactNode when the cell needs inline units
   *  or subscript chrome alongside the primary number. */
  value: string | React.ReactNode;
  hint?: string;
  accent?: 'ff';
  pulse?: boolean;
}) {
  const isString = typeof value === 'string';
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
        {pulse ? (
          <span className="relative flex size-1.5 items-center justify-center">
            <span className="absolute inset-0 animate-ping bg-ff-orange/60" />
            <span className="relative size-1.5 bg-ff-orange" />
          </span>
        ) : null}
        {label}
      </span>
      {isString ? (
        <span
          className={cn(
            'text-2xl tabular-nums leading-none',
            accent === 'ff' && 'text-ff-orange',
          )}
        >
          {value}
        </span>
      ) : (
        <span className={cn('flex items-baseline', accent === 'ff' && 'text-ff-orange')}>
          {value}
        </span>
      )}
      {hint ? (
        <span className="font-mono text-[10px] text-muted-foreground/80">{hint}</span>
      ) : null}
    </li>
  );
}

/** Render the lifetime total-call-time as a primary minute value with an
 *  hours/days "subscript" hint. Goes silent below one minute. */
function formatTotalCallTime(seconds: number): { minutes: string; subscript?: string } {
  if (seconds <= 0) return { minutes: '0', subscript: 'No calls yet' };
  const totalMin = Math.round(seconds / 60);
  if (totalMin === 0) {
    return { minutes: '<1', subscript: `${seconds}s recorded` };
  }
  const hours = seconds / 3600;
  const days = hours / 24;
  const parts: string[] = [];
  if (hours >= 1) {
    parts.push(`${hours >= 100 ? hours.toFixed(0) : hours.toFixed(1)}h`);
  }
  if (hours >= 24) {
    parts.push(`${days >= 100 ? days.toFixed(0) : days.toFixed(1)}d`);
  }
  return {
    minutes: totalMin.toLocaleString(),
    subscript: parts.length > 0 ? parts.join(' · ') : undefined,
  };
}

function OverviewTab({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      className="flex-1 border-r border-border/60 px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground last:border-r-0 data-[state=active]:bg-secondary/60 data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

function SentimentMix({
  mix,
  total,
}: {
  mix: { positive: number; neutral: number; negative: number };
  total: number;
}) {
  const seg = (n: number) => ({ width: `${(n / total) * 100}%` });
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden bg-muted/40">
        {mix.negative > 0 ? <div className="bg-destructive" style={seg(mix.negative)} /> : null}
        {mix.neutral > 0 ? <div className="bg-muted-foreground/50" style={seg(mix.neutral)} /> : null}
        {mix.positive > 0 ? <div className="bg-emerald-500" style={seg(mix.positive)} /> : null}
      </div>
      <div className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 bg-destructive" />
          <span className="text-destructive">{mix.negative}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 bg-muted-foreground/50" />
          {mix.neutral}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 bg-emerald-500" />
          <span className="text-emerald-600 dark:text-emerald-500">{mix.positive}</span>
        </span>
      </div>
    </div>
  );
}
