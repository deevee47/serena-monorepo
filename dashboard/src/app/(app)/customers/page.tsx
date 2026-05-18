import Link from 'next/link';
import { PhoneOutgoing } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/page-header';
import { loadCustomers } from '@/lib/db-queries';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const SEGMENT_VARIANT: Record<string, 'default' | 'info' | 'warning' | 'success'> = {
  FIRST_TIME: 'default',
  RETURNING: 'info',
  LAPSED: 'warning',
  VIP: 'success',
};

export default async function CustomersPage() {
  const customers = await loadCustomers();
  return (
    <>
      <PageHeader
        title="Customers"
        description="Recently updated customers tracked by the gateway (latest 100)."
      />
      <div className="p-6">
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="text-right">LTV</TableHead>
                  <TableHead>Segment</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Purchases</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                      No customers yet — run <code>bun run db:seed</code>.
                    </TableCell>
                  </TableRow>
                ) : (
                  customers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.name ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{c.phone}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        ${Number(c.lifetimeValue).toFixed(0)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={SEGMENT_VARIANT[c.segment] ?? 'outline'}>
                          {c.segment}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c._count.calls}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c._count.purchases}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelative(c.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild size="sm" variant="ghost">
                          <Link href="/trigger">
                            <PhoneOutgoing className="size-3" />
                            Call
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
