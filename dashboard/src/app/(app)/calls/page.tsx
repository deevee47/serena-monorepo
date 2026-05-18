import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { OutcomeBadge } from '@/components/outcome-badge';
import { PageHeader } from '@/components/page-header';
import { loadCallList } from '@/lib/db-queries';
import { formatDuration, formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const OUTCOMES = ['CONVERTED', 'DROPPED', 'NO_ANSWER', 'ERROR'] as const;

// Single-source colour map so the outcome ribbon and the OutcomeBadge
// stay in lockstep. Keys match the OUTCOMES tuple plus "OTHER" for
// rows with missing / unrecognised outcomes (in-flight calls etc).
const OUTCOME_COLOR: Record<string, string> = {
  CONVERTED: 'bg-emerald-500',
  DROPPED: 'bg-muted-foreground/60',
  NO_ANSWER: 'bg-amber-500',
  ERROR: 'bg-destructive',
  OTHER: 'bg-border',
};

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const filters = {
    outcome: sp.outcome ?? undefined,
    q: sp.q ?? undefined,
    take: 100,
  };
  const calls = await loadCallList(filters);

  // Outcome distribution over the *currently filtered* result set —
  // surfaced as a single hairline ribbon so ops can read the shape of
  // the filter at a glance before scanning rows.
  const distribution = calls.reduce<Record<string, number>>((acc, c) => {
    const key =
      c.outcome && (OUTCOMES as readonly string[]).includes(c.outcome)
        ? (c.outcome as string)
        : 'OTHER';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const total = calls.length;

  return (
    <>
      <PageHeader title="Calls" description="Every call logged by the gateway." />
      <div className="space-y-3 p-6">
        {/* ── Filter strip ─────────────────────────────────────────
            One-line replacement for the old Card-bound form. Search
            stretches; outcome dropdown stays compact. */}
        <form
          method="get"
          className="flex flex-wrap items-center gap-2 border border-border/80 bg-card px-3 py-2"
        >
          <Input
            name="q"
            placeholder="search · phone, call id, name, email"
            defaultValue={filters.q ?? ''}
            className="h-8 flex-1 min-w-56 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
          />
          <span aria-hidden className="h-5 w-px bg-border" />
          <select
            name="outcome"
            defaultValue={filters.outcome ?? ''}
            className="h-8 border border-border/80 bg-transparent px-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/80"
          >
            <option value="">Any outcome</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o.replace('_', ' ')}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary" size="sm" className="h-8">
            Apply
          </Button>
          {(filters.outcome || filters.q) && (
            <Button asChild variant="ghost" size="sm" className="h-8">
              <Link href="/calls">Clear</Link>
            </Button>
          )}
        </form>

        {/* ── Outcome ribbon ─────────────────────────────────────── */}
        <div className="border border-border/80 bg-card px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            <span>Distribution</span>
            <span className="tabular-nums text-foreground/80">{total} calls</span>
          </div>
          {total > 0 ? (
            <>
              <div className="flex h-1.5 w-full overflow-hidden bg-muted/40">
                {(['CONVERTED', 'DROPPED', 'NO_ANSWER', 'ERROR', 'OTHER'] as const).map(
                  (k) => {
                    const n = distribution[k] ?? 0;
                    if (n === 0) return null;
                    return (
                      <div
                        key={k}
                        className={OUTCOME_COLOR[k]}
                        style={{ width: `${(n / total) * 100}%` }}
                        title={`${k.replace('_', ' ').toLowerCase()} · ${n}`}
                      />
                    );
                  },
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {(['CONVERTED', 'DROPPED', 'NO_ANSWER', 'ERROR', 'OTHER'] as const).map(
                  (k) => {
                    const n = distribution[k] ?? 0;
                    if (n === 0) return null;
                    return (
                      <span key={k} className="flex items-center gap-1.5">
                        <span className={cn('inline-block size-1.5', OUTCOME_COLOR[k])} />
                        <span className="text-foreground/80">{k.replace('_', ' ')}</span>
                        <span className="tabular-nums">{n}</span>
                      </span>
                    );
                  },
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              No calls match the current filter.
            </p>
          )}
        </div>

        {/* ── Results table ───────────────────────────────────────── */}
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Turns</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No calls match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  calls.map((call) => (
                    <TableRow key={call.callId}>
                      <TableCell>
                        <Link
                          href={`/calls/${call.callId}`}
                          className="text-foreground hover:underline"
                        >
                          {formatRelative(call.createdAt)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {call.customerName ?? call.phoneNumber ?? 'Anonymous'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {call.productId ?? '—'}
                      </TableCell>
                      <TableCell>
                        {call.discountGiven > 0 ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                            −{call.discountGiven}%
                          </code>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <OutcomeBadge outcome={call.outcome} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{call.turnCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDuration(call.durationSeconds)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
