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
import { NewOfferForm } from '@/components/new-offer-form';
import { loadOffers, loadProducts } from '@/lib/db-queries';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function OffersPage() {
  const [offers, products] = await Promise.all([loadOffers(), loadProducts()]);
  const productOptions = products.map((p) => ({
    id: p.id,
    label: `${p.name} — $${Number(p.price).toFixed(0)}`,
  }));
  return (
    <>
      <PageHeader
        title="Offers"
        description="Bundle and quantity offers Serena can surface during a call."
        action={<NewOfferForm products={productOptions} />}
      />
      <div className="p-6">
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Pitch</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Valid until</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                      No offers configured yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  offers.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <div className="font-medium">{o.product.name}</div>
                        <code className="font-mono text-[10px] text-muted-foreground">
                          {o.product.id}
                        </code>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{o.type}</TableCell>
                      <TableCell className="max-w-sm truncate text-sm">
                        {o.shortPitch}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {o.discountPercent}%
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {o.type === 'BUNDLE'
                          ? o.bundleProduct
                            ? `+ ${o.bundleProduct.name}`
                            : '—'
                          : o.minQuantity
                            ? `Min ${o.minQuantity}`
                            : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {o.validUntil ? formatRelative(o.validUntil) : 'open'}
                      </TableCell>
                      <TableCell>
                        {o.isActive ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Off</Badge>
                        )}
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
