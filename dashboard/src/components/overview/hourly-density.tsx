import { cn } from '@/lib/utils';

interface HourlyDensityProps {
  hours: Array<{ hour: number; count: number }>;
}

/** 24-column micro-distribution showing call volume by hour-of-day over
 *  the last 7 days. Reads as a "when do people call" sparkline — narrower
 *  than DailyTrend but with more resolution. Peak hour is highlighted in
 *  brand orange; the median band is annotated below. */
export function HourlyDensity({ hours }: HourlyDensityProps) {
  const max = Math.max(1, ...hours.map((h) => h.count));
  const total = hours.reduce((s, h) => s + h.count, 0);
  const peak = hours.reduce((a, b) => (b.count > a.count ? b : a), hours[0]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        <span className="text-foreground/80">Hour of day · 7d</span>
        <span className="flex items-center gap-3">
          <span className="tabular-nums text-foreground/80">{total} total</span>
          {peak.count > 0 ? (
            <span className="tabular-nums">
              <span className="text-ff-orange">peak</span>{' '}
              <span className="text-foreground/80">{fmtHour(peak.hour)}</span>
            </span>
          ) : null}
        </span>
      </div>

      <div
        className="grid min-h-0 flex-1 items-end gap-px"
        style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
      >
        {hours.map((h) => {
          const pct = (h.count / max) * 100;
          const isPeak = h.count > 0 && h.count === peak.count;
          return (
            <div
              key={h.hour}
              className="relative flex h-full items-end"
              title={`${fmtHour(h.hour)} · ${h.count} call${h.count === 1 ? '' : 's'}`}
            >
              <div
                className={cn(
                  'w-full transition-colors',
                  isPeak ? 'bg-ff-orange' : 'bg-foreground/30',
                )}
                style={{ height: `${pct}%`, minHeight: h.count > 0 ? '2px' : '0' }}
              />
            </div>
          );
        })}
      </div>

      {/* Axis labels — every 6 hours so the strip stays legible at narrow widths. */}
      <div className="mt-1 grid grid-cols-4 font-mono text-[9px] tabular-nums text-muted-foreground/70">
        <span>00</span>
        <span className="text-center">06</span>
        <span className="text-center">12</span>
        <span className="text-right">18</span>
      </div>
    </div>
  );
}

function fmtHour(h: number): string {
  return `${h.toString().padStart(2, '0')}:00`;
}
