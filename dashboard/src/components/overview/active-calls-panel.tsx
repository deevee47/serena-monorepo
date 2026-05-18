import Link from 'next/link';
import { Broadcast } from '@phosphor-icons/react/dist/ssr';
import { cn } from '@/lib/utils';

export interface ActiveCall {
  callId: string;
  createdAt: Date;
  phoneNumber: string | null;
  customerName: string | null;
  turnCount: number;
}

interface ActiveCallsPanelProps {
  calls: ActiveCall[];
}

/** In-flight calls — anything that has a call row but no endedAt. Each
 *  entry deep-links to the live tail. Shows nothing if quiet — kept short
 *  on purpose so the rest of the cockpit isn't pushed around when a burst
 *  of calls comes through. */
export function ActiveCallsPanel({ calls }: ActiveCallsPanelProps) {
  if (calls.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <span className="mb-2 inline-block size-1.5 bg-muted-foreground/40" />
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          No calls in flight
        </p>
      </div>
    );
  }
  return (
    <ul className="flex h-full flex-col gap-1 overflow-y-auto">
      {calls.map((c) => (
        <li key={c.callId}>
          <Link
            href={`/live/${c.callId}`}
            className={cn(
              'group/active flex items-center gap-2.5 border border-border/60 px-2.5 py-2',
              'transition-colors hover:border-ff-orange/60 hover:bg-secondary/40',
            )}
          >
            <span className="relative flex size-2 shrink-0 items-center justify-center">
              <span className="absolute inset-0 animate-ping bg-ff-orange/60" />
              <span className="relative size-2 bg-ff-orange" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                {c.customerName ?? c.phoneNumber ?? 'Anonymous'}
              </p>
              <p className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {c.callId.slice(0, 8)} · {c.turnCount} turn{c.turnCount === 1 ? '' : 's'}
              </p>
            </div>
            <Broadcast className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/active:text-ff-orange" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
