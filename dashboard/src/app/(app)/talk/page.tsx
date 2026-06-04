import { WarningCircle } from '@phosphor-icons/react/dist/ssr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { TalkButton } from '@/components/talk-button';
import { getWebCallConfig } from '@/lib/gateway';
import { loadProducts, loadActiveOffersByProduct } from '@/lib/db-queries';
import { getProviderOverride } from '@/lib/provider';

export const dynamic = 'force-dynamic';

export default async function TalkPage() {
  const providerOverride = await getProviderOverride();
  const [cfg, products, offersByProduct] = await Promise.all([
    getWebCallConfig(providerOverride),
    loadProducts(),
    loadActiveOffersByProduct(),
  ]);

  const productOptions = products.map((p) => ({
    id: p.id,
    name: p.name,
    price: Number(p.price),
    category: p.category ?? null,
  }));

  return (
    <>
      <PageHeader
        title="Talk to agent"
        description="Browser-based test call to the same assistant production traffic hits."
      />
      <div className="p-6">
        {cfg.ok ? (
          cfg.provider === 'telnyx' ? (
            <TalkButton
              provider="telnyx"
              assistantId={cfg.assistantId}
              products={productOptions}
              offersByProduct={offersByProduct}
            />
          ) : (
            <TalkButton
              provider="vapi"
              publicKey={cfg.publicKey}
              assistantId={cfg.assistantId}
              products={productOptions}
              offersByProduct={offersByProduct}
            />
          )
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <WarningCircle className="size-5 text-destructive" />
                Web call not configured
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                The gateway didn&apos;t return a usable web-call config. Check{' '}
                <code className="text-foreground">VOICE_PROVIDER</code> and the
                matching provider secrets in the gateway&apos;s env.
              </p>
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
                {cfg.error}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
