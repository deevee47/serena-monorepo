import { cn } from '@/lib/utils';

interface DailyTrendProps {
  days: Array<{ day: string; total: number; converted: number }>;
}

const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Seven-column bar chart for the Overview cockpit. Each column shows the
 *  day's total call volume; an inset orange segment represents the
 *  CONVERTED slice. Includes a hover tooltip that fires from the column
 *  area (no JS — CSS group-hover) showing total / converted / conversion%. */
export function DailyTrend({ days }: DailyTrendProps) {
  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const totals = days.reduce((s, d) => s + d.total, 0);
  const conv = days.reduce((s, d) => s + d.converted, 0);
  const pct = totals > 0 ? Math.round((conv / totals) * 100) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        <span className="text-foreground/80">Last 7 days</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1.5 bg-foreground/60" />
            Total
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1.5 bg-ff-orange" />
            Converted
          </span>
          <span className="tabular-nums text-foreground/80">{pct}% conv.</span>
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 items-end gap-1.5">
        {days.map((d) => {
          const totalPct = (d.total / maxTotal) * 100;
          const convPct = d.total > 0 ? (d.converted / d.total) * 100 : 0;
          const date = new Date(d.day + 'T00:00:00Z');
          const isToday =
            date.toDateString() === new Date().toDateString();
          const tooltip = `${d.day} · ${d.total} call${d.total === 1 ? '' : 's'} · ${d.converted} converted${
            d.total > 0 ? ` (${Math.round(convPct)}%)` : ''
          }`;
          return (
            <div key={d.day} className="group/bar flex h-full flex-col">
              <div className="relative flex min-h-0 flex-1 items-end" title={tooltip}>
                <div
                  className={cn(
                    'relative w-full bg-muted/60 transition-colors group-hover/bar:bg-muted',
                  )}
                  style={{ height: `${totalPct}%`, minHeight: '2px' }}
                >
                  {d.converted > 0 ? (
                    <div
                      className="absolute inset-x-0 bottom-0 bg-ff-orange"
                      style={{ height: `${convPct}%` }}
                    />
                  ) : null}
                </div>
              </div>
              <span
                className={cn(
                  'mt-1.5 text-center font-mono text-[10px] uppercase tracking-[0.18em]',
                  isToday ? 'text-foreground' : 'text-muted-foreground/70',
                )}
              >
                {WEEKDAY[date.getUTCDay()]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
