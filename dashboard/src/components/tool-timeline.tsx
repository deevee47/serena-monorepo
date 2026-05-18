import { Eye, Wrench } from '@phosphor-icons/react/dist/ssr';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface ToolTimelineEvent {
  kind: 'observation' | 'tool';
  name: string;
  args?: Record<string, unknown> | null;
  turnNumber: number;
  timestamp: string | Date | null;
}

interface ToolTimelineProps {
  events: ToolTimelineEvent[];
  emptyHint?: string;
  /** Render as a flat dense list (no Card wrapper, smaller dots, tighter
   *  padding). Used in the call cockpit's left rail where vertical space
   *  is at a premium. */
  compact?: boolean;
}

function formatArgs(args?: Record<string, unknown> | null): string {
  if (!args) return '';
  const entries = Object.entries(args).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

export function ToolTimeline({ events, emptyHint, compact = false }: ToolTimelineProps) {
  const obsCount = events.filter((e) => e.kind === 'observation').length;
  const toolCount = events.length - obsCount;

  if (compact) {
    if (events.length === 0) {
      return (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {emptyHint ?? 'No tool calls.'}
        </p>
      );
    }
    return (
      <ol className="space-y-2">
        {events.map((ev, i) => {
          const isObs = ev.kind === 'observation';
          const argText = formatArgs(ev.args);
          return (
            <li
              key={`${ev.kind}-${ev.name}-${i}`}
              className="flex items-start gap-2"
            >
              <div
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center',
                  isObs
                    ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
                    : 'bg-ff-orange/15 text-ff-orange',
                )}
                aria-label={isObs ? 'Observation' : 'Side-effect tool'}
              >
                {isObs ? <Eye className="size-3" /> : <Wrench className="size-3" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-medium">{ev.name}</span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                    t#{ev.turnNumber}
                  </span>
                </div>
                {argText ? (
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {argText}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <CardTitle>Tool activity ({events.length})</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="info" className="font-normal">
            <Eye className="mr-1 size-3" />
            {obsCount} observation{obsCount === 1 ? '' : 's'}
          </Badge>
          <Badge variant="ff" className="font-normal">
            <Wrench className="mr-1 size-3" />
            {toolCount} side-effect{toolCount === 1 ? '' : 's'}
          </Badge>
        </div>
      </CardHeader>
      {events.length === 0 ? (
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {emptyHint ?? 'No tool calls during this conversation.'}
        </CardContent>
      ) : (
        <CardContent className="px-0 pb-0">
          <ol className="divide-y">
            {events.map((ev, i) => {
              const isObs = ev.kind === 'observation';
              const argText = formatArgs(ev.args);
              return (
                <li
                  key={`${ev.kind}-${ev.name}-${i}`}
                  className="flex items-start gap-3 px-6 py-3"
                >
                  <div
                    className={cn(
                      'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                      isObs
                        ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
                        : 'bg-ff-orange/15 text-ff-orange',
                    )}
                    aria-label={isObs ? 'Observation' : 'Side-effect tool'}
                  >
                    {isObs ? <Eye className="size-4" /> : <Wrench className="size-4" />}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium">{ev.name}</span>
                      <span className="text-xs text-muted-foreground">
                        turn #{ev.turnNumber}
                      </span>
                    </div>
                    {argText ? (
                      <pre className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono">
                        {argText}
                      </pre>
                    ) : (
                      <p className="text-xs text-muted-foreground">no args</p>
                    )}
                  </div>
                  <span
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    suppressHydrationWarning
                  >
                    {ev.timestamp
                      ? new Date(ev.timestamp).toLocaleTimeString()
                      : '—'}
                  </span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      )}
    </Card>
  );
}

/** Flatten persisted CallTurn rows into a chronological list of tool events.
 *  Observations (read-only LLM lookups) come from each AGENT turn's
 *  `observationsCalled` JSON array. Side-effect tools come from `toolCalled` +
 *  `toolArgs` and represent the call that ended that turn. */
export function buildToolTimeline(
  turns: Array<{
    speaker: 'USER' | 'AGENT';
    turnNumber: number;
    toolCalled?: string | null;
    toolArgs?: unknown;
    observationsCalled?: unknown;
    timestamp?: string | Date | null;
  }>,
): ToolTimelineEvent[] {
  const events: ToolTimelineEvent[] = [];
  for (const t of turns) {
    if (t.speaker !== 'AGENT') continue;
    if (Array.isArray(t.observationsCalled)) {
      for (const obs of t.observationsCalled as Array<{
        name?: string;
        args?: Record<string, unknown>;
      }>) {
        if (!obs?.name) continue;
        events.push({
          kind: 'observation',
          name: obs.name,
          args: obs.args ?? null,
          turnNumber: t.turnNumber,
          timestamp: t.timestamp ?? null,
        });
      }
    }
    if (t.toolCalled) {
      events.push({
        kind: 'tool',
        name: t.toolCalled,
        args:
          t.toolArgs && typeof t.toolArgs === 'object'
            ? (t.toolArgs as Record<string, unknown>)
            : null,
        turnNumber: t.turnNumber,
        timestamp: t.timestamp ?? null,
      });
    }
  }
  return events;
}
