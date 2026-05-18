import { OutcomeBadge } from '@/components/outcome-badge';
import { formatDuration } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface SentimentCounts {
  POSITIVE: number;
  NEGATIVE: number;
  NEUTRAL: number;
  total: number;
}

interface CallKpiStripProps {
  outcome?: string | null;
  durationSeconds?: number | null;
  planId?: string | null;
  coupon?: string | null;
  sentiment: SentimentCounts;
}

/** One-line replacement for the 5-card KPI grid. Reads as a status bar:
 *  outcome chip · duration · plan · coupon · inline sentiment microbar.
 *  Designed to live at the top of the cockpit rail without eating vertical
 *  space — the entire strip is ~64px tall regardless of breakpoint. */
export function CallKpiStrip({
  outcome,
  durationSeconds,
  planId,
  coupon,
  sentiment,
}: CallKpiStripProps) {
  return (
    <div className="border border-border/80 bg-card">
      <ul className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-5 sm:divide-y-0">
        <Cell label="Outcome">
          <OutcomeBadge outcome={outcome ?? null} />
        </Cell>
        <Cell label="Duration">
          <span className="text-base tabular-nums">{formatDuration(durationSeconds ?? 0)}</span>
        </Cell>
        <Cell label="Plan">
          {planId ? (
            <code className="font-mono text-xs">{planId}</code>
          ) : (
            <Dash />
          )}
        </Cell>
        <Cell label="Coupon">
          {coupon ? (
            <code className="bg-muted px-1.5 py-0.5 font-mono text-xs">{coupon}</code>
          ) : (
            <Dash />
          )}
        </Cell>
        <Cell label="Sentiment">
          {sentiment.total > 0 ? <SentimentBar counts={sentiment} /> : <Dash />}
        </Cell>
      </ul>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </span>
      <div className="min-h-[20px] text-sm">{children}</div>
    </li>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function SentimentBar({ counts }: { counts: SentimentCounts }) {
  const seg = (n: number) => ({ width: `${(n / counts.total) * 100}%` });
  return (
    <div className="space-y-1">
      <div className="flex h-1.5 w-full overflow-hidden bg-muted">
        {counts.NEGATIVE > 0 ? (
          <div className="bg-destructive" style={seg(counts.NEGATIVE)} />
        ) : null}
        {counts.NEUTRAL > 0 ? (
          <div className="bg-muted-foreground/50" style={seg(counts.NEUTRAL)} />
        ) : null}
        {counts.POSITIVE > 0 ? (
          <div className="bg-emerald-500" style={seg(counts.POSITIVE)} />
        ) : null}
      </div>
      <div className="flex justify-between font-mono text-[9px] tabular-nums text-muted-foreground">
        <span className={cn(counts.NEGATIVE > 0 && 'text-destructive')}>
          {counts.NEGATIVE}
        </span>
        <span>{counts.NEUTRAL}</span>
        <span
          className={cn(counts.POSITIVE > 0 && 'text-emerald-600 dark:text-emerald-500')}
        >
          {counts.POSITIVE}
        </span>
      </div>
    </div>
  );
}
