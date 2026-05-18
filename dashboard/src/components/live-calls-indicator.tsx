'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Broadcast } from '@phosphor-icons/react/dist/ssr';
import { cn } from '@/lib/utils';

interface LivePayload {
  count: number;
  mostRecent: {
    callId: string;
    createdAt: string;
    customerName: string | null;
    phoneNumber: string | null;
  } | null;
}

const POLL_MS = 5000;

/** Global "in flight" indicator. Mounted by the (app) layout so every page
 *  has it. Polls /api/live every 5s, pulses platinum when calls are live,
 *  and clicking jumps straight to the most-recent ongoing call (or /live
 *  when empty). Stays present in the header so the operator can always see
 *  whether something's happening without leaving the current page. */
export function LiveCallsIndicator() {
  const router = useRouter();
  const [data, setData] = React.useState<LivePayload>({ count: 0, mostRecent: null });
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as LivePayload;
        if (!cancelled) setData(body);
      } catch {
        /* network hiccup — next tick will retry */
      }
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const active = data.count > 0;
  const target = data.mostRecent ? `/live/${data.mostRecent.callId}` : '/live';
  const callerLabel = data.mostRecent
    ? data.mostRecent.customerName ?? data.mostRecent.phoneNumber ?? 'Anonymous'
    : null;

  const onClick = () => {
    setPending(true);
    router.push(target);
    // Optimistic flip back so a stuck nav doesn't leave the button dimmed.
    window.setTimeout(() => setPending(false), 800);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        active
          ? `${data.count} call${data.count === 1 ? '' : 's'} in flight — open the most recent`
          : 'No calls in flight — open Live page'
      }
      data-active={active}
      className={cn(
        'group inline-flex items-center gap-2.5 border border-border/70 bg-card/80 px-3 py-1.5 backdrop-blur transition-colors',
        'hover:border-foreground/40 hover:bg-card',
        active
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground',
        pending && 'opacity-60',
      )}
    >
      {/* Pulse dot — platinum when active, hairline outline when idle */}
      {active ? (
        <span className="relative flex size-1.5 items-center justify-center">
          <span className="absolute inset-0 animate-ping bg-serena-accent/60" />
          <span className="relative size-1.5 bg-serena-accent" />
        </span>
      ) : (
        <span className="size-1.5 border border-muted-foreground/40" />
      )}

      <span className="font-mono text-[10px] uppercase tracking-[0.22em]">
        {active ? `${data.count} in flight` : 'Idle'}
      </span>

      {/* Caller hint — only when active and we have a label. Truncates so
          the chip never grows wider than ~280px even with long names. */}
      {active && callerLabel ? (
        <>
          <span aria-hidden className="h-3 w-px bg-border" />
          <span className="max-w-[10rem] truncate text-xs text-foreground/80">
            {callerLabel}
          </span>
        </>
      ) : null}

      <Broadcast
        className={cn(
          'size-3 transition-transform group-hover:translate-x-0.5',
          active ? 'text-serena-accent' : 'text-muted-foreground',
        )}
        weight={active ? 'fill' : 'regular'}
      />
    </button>
  );
}
