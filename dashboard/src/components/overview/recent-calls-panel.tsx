'use client';

import * as React from 'react';
import Link from 'next/link';
import { CaretLeft, CaretRight } from '@phosphor-icons/react/dist/ssr';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { OutcomeBadge } from '@/components/outcome-badge';
import { cn, formatDuration, formatRelative } from '@/lib/utils';

export interface RecentCallRow {
  callId: string;
  createdAt: Date | string;
  customerName: string | null;
  phoneNumber: string | null;
  productId: string | null;
  outcome: string | null;
  durationSeconds: number | null;
}

interface RecentCallsPanelProps {
  calls: RecentCallRow[];
  pageSize?: number;
}

/** Recent-calls table with client-side pagination. The Overview server
 *  passes a generous slice (e.g. take: 50); we paginate locally so the
 *  user can flip through pages without round-trips. Each page is exactly
 *  `pageSize` rows so the panel never reflows. */
export function RecentCallsPanel({ calls, pageSize = 5 }: RecentCallsPanelProps) {
  const [page, setPage] = React.useState(0);
  const totalPages = Math.max(1, Math.ceil(calls.length / pageSize));

  // If the data shrinks underneath us (e.g. fewer rows after a refresh),
  // clamp the active page so we don't show an empty slice.
  React.useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);

  const start = page * pageSize;
  const visible = calls.slice(start, start + pageSize);
  const lastShown = Math.min(calls.length, start + pageSize);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Dur</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No calls yet — trigger one to populate this.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((call) => (
                <TableRow key={call.callId}>
                  <TableCell>
                    <Link
                      href={`/calls/${call.callId}`}
                      className="block text-foreground hover:underline"
                    >
                      {formatRelative(new Date(call.createdAt))}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate">
                    {call.customerName ?? call.phoneNumber ?? 'Anonymous'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {call.productId ?? '—'}
                  </TableCell>
                  <TableCell>
                    <OutcomeBadge outcome={call.outcome} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(call.durationSeconds)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Page bar — only shown when there's more than one page. */}
      {totalPages > 1 ? (
        <nav
          aria-label="Recent calls pagination"
          className="flex items-center justify-between border-t border-border/60 bg-card/60 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
        >
          <span className="tabular-nums text-foreground/70">
            {start + 1}–{lastShown} of {calls.length}
          </span>
          <div className="flex items-center gap-0.5">
            <PageBtn
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              aria-label="Previous page"
            >
              <CaretLeft className="size-3" weight="bold" />
            </PageBtn>
            <PageNumbers current={page} total={totalPages} onChange={setPage} />
            <PageBtn
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <CaretRight className="size-3" weight="bold" />
            </PageBtn>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function PageBtn({
  children,
  active,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex h-6 min-w-6 items-center justify-center border border-transparent px-1.5 transition-colors',
        'hover:border-border/80 hover:bg-secondary/60 hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-transparent disabled:hover:bg-transparent',
        active && 'border-ff-orange/70 bg-ff-orange/10 text-foreground',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Compact page-number ellipsis: shows 1 … current-1 current current+1 … last.
 *  Up to ~5 visible at once so the bar stays narrow in the panel. */
function PageNumbers({
  current,
  total,
  onChange,
}: {
  current: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const pages: Array<number | 'gap'> = [];
  const push = (p: number | 'gap') => pages.push(p);

  if (total <= 5) {
    for (let i = 0; i < total; i++) push(i);
  } else {
    push(0);
    if (current > 2) push('gap');
    for (let i = Math.max(1, current - 1); i <= Math.min(total - 2, current + 1); i++) push(i);
    if (current < total - 3) push('gap');
    push(total - 1);
  }

  return (
    <>
      {pages.map((p, i) =>
        p === 'gap' ? (
          <span
            key={`gap-${i}`}
            className="px-1 text-muted-foreground/50"
            aria-hidden
          >
            ·
          </span>
        ) : (
          <PageBtn
            key={p}
            active={p === current}
            onClick={() => onChange(p)}
            aria-label={`Page ${p + 1}`}
            aria-current={p === current ? 'page' : undefined}
          >
            <span className="tabular-nums">{p + 1}</span>
          </PageBtn>
        ),
      )}
    </>
  );
}
