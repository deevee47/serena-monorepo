import Link from 'next/link';
import { Broadcast } from '@phosphor-icons/react/dist/ssr';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { loadActiveCalls } from '@/lib/db-queries';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LivePage() {
  const calls = await loadActiveCalls();
  return (
    <>
      <PageHeader
        title="Live"
        description="Calls currently in flight (no end-of-call report yet)."
      />
      <div className="p-6">
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Turns</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                      No calls in flight right now.
                    </TableCell>
                  </TableRow>
                ) : (
                  calls.map((call) => (
                    <TableRow key={call.callId}>
                      <TableCell>{formatRelative(call.createdAt)}</TableCell>
                      <TableCell>
                        {call.customer?.name ?? call.phoneNumber ?? 'Anonymous'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {call.productId ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {call._count.turns}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild size="sm" variant="ff">
                          <Link href={`/live/${encodeURIComponent(call.callId)}`}>
                            <Broadcast className="size-3" />
                            Tail
                          </Link>
                        </Button>
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
