import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { TriggerForm } from '@/components/trigger-form';
import { loadProducts } from '@/lib/db-queries';
import { formatCurrency } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function TriggerPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const [products, sp] = await Promise.all([loadProducts(), searchParams]);
  const options = products.map((p) => ({
    id: p.id,
    label: p.name,
    price: formatCurrency(Number(p.price)),
  }));
  return (
    <>
      <PageHeader
        title="Trigger outbound call"
        description="Dispatch Serena to dial a customer right now."
      />
      <div className="grid gap-6 p-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>New call</CardTitle>
          </CardHeader>
          <CardContent>
            <TriggerForm products={options} defaultProductId={sp.product} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>What happens next</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              The gateway calls <code className="text-foreground">/calls/trigger</code> with your
              admin secret. Vapi places the outbound dial within seconds.
            </p>
            <p>
              When the customer picks up, the agent opens with a reference to the selected
              product and follows the cart-recovery playbook.
            </p>
            <p>
              The call lands in <a className="underline" href="/live">Live</a> immediately and is
              persisted to <a className="underline" href="/calls">Calls</a> once it ends.
            </p>
            <p className="text-xs">
              Per-number rate limit: 3 calls per phone per day (enforced by the gateway).
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
