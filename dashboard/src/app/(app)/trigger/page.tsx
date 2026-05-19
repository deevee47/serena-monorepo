import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { PlatformBadge } from '@/components/platform-badge';
import { TriggerForm } from '@/components/trigger-form';
import { loadProducts } from '@/lib/db-queries';
import { getProviderOverride } from '@/lib/provider';
import { formatCurrency } from '@/lib/utils';

export const dynamic = 'force-dynamic';

// Display labels for the two providers — keeps copy on this page in sync
// with PlatformBadge without coupling to it.
const PLATFORM_LABEL: Record<string, string> = {
  vapi: 'Vapi',
  telnyx: 'Telnyx',
};

export default async function TriggerPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const [products, sp, override] = await Promise.all([
    loadProducts(),
    searchParams,
    getProviderOverride(),
  ]);
  const options = products.map((p) => ({
    id: p.id,
    label: p.name,
    price: formatCurrency(Number(p.price)),
  }));
  // Falls back to the gateway-side default when the operator hasn't toggled
  // a provider in the header. The trigger action passes the resolved value
  // through to /calls/trigger which honors it.
  const activeProvider = override ?? null;
  const activeLabel = activeProvider
    ? PLATFORM_LABEL[activeProvider] ?? activeProvider
    : 'gateway default';

  return (
    <>
      <PageHeader
        title="Trigger outbound call"
        description="Dispatch Serena to dial a customer right now."
      />
      <div className="grid gap-6 p-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>New call</span>
              <PlatformBadge provider={activeProvider} />
            </CardTitle>
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
              admin secret. <span className="text-foreground">{activeLabel}</span> places the
              outbound dial within seconds.
            </p>
            <p>
              Switch the active platform from the toggle in the top-right header — it routes the
              next call through the chosen provider without restarting the gateway.
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
