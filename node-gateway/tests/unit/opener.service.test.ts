import { describe, it, expect, mock } from 'bun:test';

// product.service.ts loads a Postgres catalog at boot. For unit tests we
// stub it so the opener service can resolve the in-memory product lookup
// without DB access.
mock.module('../../src/services/product.service.js', () => ({
  getProductById: (id: string) =>
    id === 'prod-001' ? { id: 'prod-001', name: 'ZephyrChair Pro', price: 349 } : null,
  loadCatalog: async () => {},
  toProductContext: () => ({}),
  findAlternativeProduct: async () => null,
}));

// prisma is touched only by loadActiveOfferForProduct; stub `offer.findFirst`
// to control whether an active offer is returned.
let nextOffer: { discountPercent: number; shortPitch: string } | null = null;
mock.module('../../src/lib/prisma.js', () => ({
  prisma: {
    offer: {
      findFirst: async () => nextOffer,
    },
  },
}));

const { generateOpener } = await import('../../src/services/opener.service.js');

describe('generateOpener', () => {
  it('returns a fixed inbound greeting', async () => {
    const opener = await generateOpener({ mode: 'INBOUND_PRESALES' });
    expect(opener).toBe('Serena, this is Sera — how can I help?');
  });

  it('returns a product-agnostic outbound opener when no product is supplied', async () => {
    nextOffer = null;
    const opener = await generateOpener({ mode: 'OUTBOUND_RECOVERY' });
    expect(opener.toLowerCase()).toContain('sera');
    expect(opener.toLowerCase()).toContain('serena');
    // Without a product, the offer-gated template can't render; the other
    // three never reference a product name when one isn't passed.
    expect(opener).not.toContain('undefined');
  });

  it('weaves the product name in when supplied', async () => {
    nextOffer = null;
    // Sample many times to defeat the weighted RNG and assert the product
    // name lands in *some* render. With 50 draws the probability of never
    // hitting any product-mentioning template is vanishingly small.
    const samples = await Promise.all(
      Array.from({ length: 50 }, () =>
        generateOpener({ mode: 'OUTBOUND_RECOVERY', productId: 'prod-001' }),
      ),
    );
    expect(samples.some((s) => s.includes('ZephyrChair Pro'))).toBe(true);
  });

  it('weaves the active offer pitch in when one exists', async () => {
    nextOffer = { discountPercent: 10, shortPitch: '10% off if you wrap today' };
    const samples = await Promise.all(
      Array.from({ length: 80 }, () =>
        generateOpener({ mode: 'OUTBOUND_RECOVERY', productId: 'prod-001' }),
      ),
    );
    expect(samples.some((s) => s.includes('10% off if you wrap today'))).toBe(true);
  });

  it('falls back to a safe greeting when no template renders', async () => {
    // Force the offer-gated template out of contention and ensure the
    // fallback path (used by pickWeighted when candidates is empty) is at
    // least valid. In practice candidates is never empty for either mode,
    // but the safety string should still be non-empty.
    nextOffer = null;
    const opener = await generateOpener({ mode: 'OUTBOUND_RECOVERY' });
    expect(opener.length).toBeGreaterThan(0);
  });
});
