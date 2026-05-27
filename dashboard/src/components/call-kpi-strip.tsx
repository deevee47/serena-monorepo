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
  /**
   * Ordered discount ladder offered across the call — e.g. `[5, 10]` means
   * the agent first offered 5% then later escalated to 10%. Rendered with
   * arrows so ops can see at a glance how much the agent burned through
   * before closing or backing off. Empty array means no discount fired.
   */
  discountLadder?: number[];
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
  discountLadder,
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
        <Cell label="Discount ladder">
          <DiscountLadder steps={discountLadder ?? []} />
        </Cell>
        <Cell label="Sentiment">
          {sentiment.total > 0 ? <SentimentBar counts={sentiment} /> : <Dash />}
        </Cell>
      </ul>
    </div>
  );
}

/** Renders the discount escalation in chronological order, e.g. `5% → 10%`.
 *  Each rung is keyed off the order in which the agent committed to it on the
 *  call. The final rung is highlighted so ops can see where the call landed
 *  even when scanning quickly. Renders a dash when no rung was ever offered. */
function DiscountLadder({ steps }: { steps: number[] }) {
  if (steps.length === 0) return <Dash />;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {steps.map((pct, idx) => {
        const isLast = idx === steps.length - 1;
        return (
          <span key={`${pct}-${idx}`} className="flex items-center gap-1">
            <code
              className={cn(
                'px-1.5 py-0.5 font-mono text-xs tabular-nums',
                isLast
                  ? 'bg-ff-orange/15 text-ff-orange'
                  : 'bg-muted text-foreground',
              )}
            >
              −{pct}%
            </code>
            {!isLast ? (
              <span className="text-muted-foreground/60" aria-hidden>
                →
              </span>
            ) : null}
          </span>
        );
      })}
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
