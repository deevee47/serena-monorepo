import { WarningCircle } from '@phosphor-icons/react/dist/ssr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { TalkButton } from '@/components/talk-button';
import { getWebCallConfig } from '@/lib/gateway';
import { loadProducts, loadActiveOffersByProduct } from '@/lib/db-queries';

export const dynamic = 'force-dynamic';

export default async function TalkPage() {
  const [cfg, products, offersByProduct] = await Promise.all([
    getWebCallConfig(),
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
        description="Browser-based test call to the same assistant Vapi uses for real traffic."
      />
      <div className="p-6">
        {cfg.ok && cfg.publicKey && cfg.assistantId ? (
          <TalkButton
            publicKey={cfg.publicKey}
            assistantId={cfg.assistantId}
            products={productOptions}
            offersByProduct={offersByProduct}
          />
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
                The gateway didn&apos;t return a Vapi public key. Set{' '}
                <code className="text-foreground">VAPI_PUBLIC_KEY</code> in the gateway&apos;s
                environment and restart it.
              </p>
              <p>
                Grab the public key from the{' '}
                <a
                  href="https://dashboard.vapi.ai/account"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Vapi dashboard → API Keys → Public Key
                </a>
                .
              </p>
              {cfg.error ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
                  {cfg.error}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
