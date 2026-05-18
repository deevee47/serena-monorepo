import { cn } from '@/lib/utils';

interface TopListItem {
  label: string;
  count: number;
  /** Optional secondary value (e.g. converted count) shown as a small chip. */
  secondary?: number;
  /** Optional explicit colour token for the bar — defaults to muted-foreground. */
  barClass?: string;
}

interface TopListProps {
  items: TopListItem[];
  emptyHint?: string;
  /** Shown as a chip on the right of each row when provided (e.g. "conv"). */
  secondaryLabel?: string;
}

/** Compact ranking list used across the Overview cockpit for top objections,
 *  top plans, top tools. Each row: label · inline progress bar · count.
 *  Bar widths are proportional to the item with the highest count. */
export function TopList({ items, emptyHint, secondaryLabel }: TopListProps) {
  if (items.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {emptyHint ?? 'No data yet.'}
      </p>
    );
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it, i) => {
        const pct = (it.count / max) * 100;
        return (
          <li key={`${it.label}-${i}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-foreground">
                {it.label.replaceAll('_', ' ')}
              </span>
              <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                {it.secondary != null && it.secondary > 0 ? (
                  <span className="text-ff-orange">
                    {it.secondary}
                    {secondaryLabel ? (
                      <span className="ml-0.5 text-[9px] uppercase tracking-[0.18em] opacity-70">
                        {secondaryLabel}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <span className="text-foreground/80">{it.count}</span>
              </span>
            </div>
            <div className="h-1 w-full bg-muted/40">
              <div
                className={cn('h-full', it.barClass ?? 'bg-foreground/40')}
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
