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
import { loadProducts } from '@/lib/db-queries';
import { formatCurrency, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const products = await loadProducts();
  return (
    <>
      <PageHeader
        title="Products"
        description="The catalog Serena sells. Edit prices and inventory via the seed scripts."
      />
      <div className="p-6">
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Inventory</TableHead>
                  <TableHead>Restock ETA</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                      No products yet — run <code>bun run db:seed</code>.
                    </TableCell>
                  </TableRow>
                ) : (
                  products.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.name}</div>
                        <code className="font-mono text-[10px] text-muted-foreground">
                          {p.id}
                        </code>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.category ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(Number(p.price))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {p.inventoryCount ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.restockEta ? formatRelative(p.restockEta) : '—'}
                      </TableCell>
                      <TableCell>
                        {p.isActive ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Off</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/trigger?product=${p.id}`}>
                            <PhoneOutgoing className="size-3" />
                            Trigger
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
