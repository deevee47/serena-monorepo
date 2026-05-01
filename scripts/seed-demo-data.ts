/**
 * Seed demo data: customers, carts, purchases, product reviews, and inventory.
 *
 * Idempotent — uses upserts on stable IDs / phones so re-running won't duplicate.
 *
 * Usage: bun run scripts/seed-demo-data.ts
 */
import { PrismaClient, Prisma, CustomerSegment, CartStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Products: just ensure the two demo products exist + add inventory ────

const DEMO_PRODUCTS = [
  {
    id: 'prod-001',
    name: 'ZephyrChair Pro',
    description: 'An ergonomic office chair with 3D-adjustable lumbar support',
    price: new Prisma.Decimal('349.00'),
    category: 'Office',
    tags: ['ergonomic', 'lumbar', 'mesh', 'warranty-5yr'],
    inventoryCount: 4, // intentionally low to demo real scarcity
    restockEta: null,
  },
  {
    id: 'prod-002',
    name: 'ZephyrChair Lite',
    description: 'A simpler ergonomic chair, same family at a lower price point',
    price: new Prisma.Decimal('199.00'),
    category: 'Office',
    tags: ['ergonomic', 'mesh', 'warranty-2yr'],
    inventoryCount: 22,
    restockEta: null,
  },
  {
    id: 'acc-mat-01',
    name: 'Anti-fatigue Floor Mat',
    description: 'Standing desk anti-fatigue mat, polyurethane',
    price: new Prisma.Decimal('49.00'),
    category: 'Office',
    tags: ['mat', 'standing-desk'],
    inventoryCount: 87,
    restockEta: null,
  },
];

// ─── Reviews: a few per product, mix of ratings + sentiment ───────────────

const REVIEWS: { productId: string; rating: number; body: string; helpful: number }[] = [
  // ZephyrChair Pro — mostly positive, one critical
  { productId: 'prod-001', rating: 5, body: 'Best chair I have ever owned. Lumbar support is incredible, no more lower back pain after 8-hour days.', helpful: 142 },
  { productId: 'prod-001', rating: 5, body: 'Worth every penny. Assembly took 20 min, mesh stays cool, recline is buttery.', helpful: 89 },
  { productId: 'prod-001', rating: 4, body: 'Excellent build but expected the armrests to have more travel range.', helpful: 31 },
  { productId: 'prod-001', rating: 5, body: 'Coming from a $2k Herman Miller and honestly prefer this one.', helpful: 76 },
  { productId: 'prod-001', rating: 2, body: 'Seat cushion compressed too quickly for a chair at this price point.', helpful: 18 },
  { productId: 'prod-001', rating: 5, body: 'Five-year warranty got honored when my caster broke. Customer service was painless.', helpful: 54 },
  // ZephyrChair Lite
  { productId: 'prod-002', rating: 4, body: 'Good chair for the price. Lumbar adjustment is more limited than the Pro but still helps.', helpful: 64 },
  { productId: 'prod-002', rating: 5, body: 'I bought this instead of the Pro and have zero regrets. Plenty of chair for under $200.', helpful: 95 },
  { productId: 'prod-002', rating: 3, body: 'Decent, but the mesh feels thinner than I expected.', helpful: 12 },
  { productId: 'prod-002', rating: 4, body: 'Solid value pick. Use it for 6+ hours daily.', helpful: 41 },
  // Anti-fatigue mat
  { productId: 'acc-mat-01', rating: 5, body: 'Saved my knees from standing-desk hell.', helpful: 23 },
  { productId: 'acc-mat-01', rating: 4, body: 'Comfortable but slightly thinner than competitors. Good price though.', helpful: 9 },
];

// ─── Customers: 8 across the segment spectrum ─────────────────────────────

const CUSTOMERS = [
  {
    phone: '+15551234567',
    name: 'Sarah Chen',
    email: 'sarah.chen@example.com',
    segment: CustomerSegment.RETURNING,
    timezone: 'America/Los_Angeles',
    preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 60 },
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 200 },
    ],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }, { productId: 'acc-mat-01', quantity: 1 }],
  },
  {
    phone: '+15552223333',
    name: 'Marcus Reyes',
    email: 'marcus@example.com',
    segment: CustomerSegment.VIP,
    timezone: 'America/New_York',
    preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'prod-001', price: new Prisma.Decimal('349.00'), daysAgo: 15 },
      { productId: 'prod-002', price: new Prisma.Decimal('199.00'), daysAgo: 90 },
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 95 },
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 30 },
    ],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }],
  },
  {
    phone: '+15553334444',
    name: 'Priya Patel',
    email: 'priya.p@example.com',
    segment: CustomerSegment.FIRST_TIME,
    timezone: 'America/Chicago',
    preferredContact: 'email',
    priorOrders: [],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }],
  },
  {
    phone: '+15554445555',
    name: 'James Kowalski',
    email: 'jkowalski@example.com',
    segment: CustomerSegment.LAPSED,
    timezone: 'America/Denver',
    preferredContact: 'phone',
    priorOrders: [
      { productId: 'prod-002', price: new Prisma.Decimal('199.00'), daysAgo: 280 },
    ],
    abandonedCart: [{ productId: 'prod-002', quantity: 1 }],
  },
  {
    phone: '+15555556666',
    name: 'Aisha Mohamed',
    email: 'aisha@example.com',
    segment: CustomerSegment.RETURNING,
    timezone: 'America/Los_Angeles',
    preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'prod-002', price: new Prisma.Decimal('199.00'), daysAgo: 45 },
    ],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }],
  },
  {
    phone: '+15556667777',
    name: 'Ben Thompson',
    email: null,
    segment: CustomerSegment.FIRST_TIME,
    timezone: null,
    preferredContact: null,
    priorOrders: [],
    abandonedCart: [{ productId: 'acc-mat-01', quantity: 2 }],
  },
  {
    phone: '+15557778888',
    name: 'Elena Petrov',
    email: 'elena.p@example.com',
    segment: CustomerSegment.VIP,
    timezone: 'Europe/London',
    preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'prod-001', price: new Prisma.Decimal('349.00'), daysAgo: 10 },
      { productId: 'prod-001', price: new Prisma.Decimal('349.00'), daysAgo: 180 },
      { productId: 'prod-002', price: new Prisma.Decimal('199.00'), daysAgo: 220 },
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 12 },
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 14 },
    ],
    abandonedCart: [
      { productId: 'prod-001', quantity: 1 },
      { productId: 'acc-mat-01', quantity: 1 },
    ],
  },
  {
    phone: '+15558889999',
    name: 'David Park',
    email: 'davidpark@example.com',
    segment: CustomerSegment.RETURNING,
    timezone: 'America/Los_Angeles',
    preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'acc-mat-01', price: new Prisma.Decimal('49.00'), daysAgo: 35 },
    ],
    abandonedCart: [{ productId: 'prod-002', quantity: 1 }],
  },
];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

async function seedProducts() {
  for (const p of DEMO_PRODUCTS) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        tags: p.tags,
        inventoryCount: p.inventoryCount,
        restockEta: p.restockEta,
        stockUpdatedAt: new Date(),
      },
      create: {
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        tags: p.tags,
        inventoryCount: p.inventoryCount,
        restockEta: p.restockEta,
        stockUpdatedAt: new Date(),
      },
    });
  }
  console.log(`✓ ${DEMO_PRODUCTS.length} products upserted`);
}

async function seedReviews() {
  // Wipe + reseed reviews so re-running gives the same demo state.
  for (const productId of DEMO_PRODUCTS.map((p) => p.id)) {
    await prisma.productReview.deleteMany({ where: { productId } });
  }
  for (const r of REVIEWS) {
    await prisma.productReview.create({ data: r });
  }
  console.log(`✓ ${REVIEWS.length} reviews seeded`);
}

async function seedCustomers() {
  let total = 0;
  let totalPurchases = 0;
  let totalCarts = 0;
  for (const c of CUSTOMERS) {
    const ltv = c.priorOrders.reduce(
      (sum, o) => sum.add(o.price),
      new Prisma.Decimal(0),
    );
    const customer = await prisma.customer.upsert({
      where: { phone: c.phone },
      update: {
        name: c.name,
        email: c.email,
        segment: c.segment,
        lifetimeValue: ltv,
        timezone: c.timezone,
        preferredContact: c.preferredContact,
      },
      create: {
        phone: c.phone,
        name: c.name,
        email: c.email,
        segment: c.segment,
        lifetimeValue: ltv,
        timezone: c.timezone,
        preferredContact: c.preferredContact,
      },
    });
    total++;

    // Replace existing purchases + carts so re-runs yield deterministic state.
    await prisma.purchase.deleteMany({ where: { customerId: customer.id } });
    for (const order of c.priorOrders) {
      await prisma.purchase.create({
        data: {
          customerId: customer.id,
          productId: order.productId,
          price: order.price,
          quantity: 1,
          purchasedAt: daysAgo(order.daysAgo),
        },
      });
      totalPurchases++;
    }

    await prisma.cart.deleteMany({ where: { customerId: customer.id } });
    if (c.abandonedCart.length > 0) {
      const cart = await prisma.cart.create({
        data: {
          customerId: customer.id,
          status: CartStatus.ABANDONED,
          abandonedAt: minutesAgo(15 + Math.floor(Math.random() * 60)),
          items: {
            create: c.abandonedCart.map((item) => {
              const product = DEMO_PRODUCTS.find((p) => p.id === item.productId);
              if (!product) throw new Error(`unknown product ${item.productId}`);
              return {
                productId: item.productId,
                priceAtAdd: product.price,
                quantity: item.quantity,
              };
            }),
          },
        },
      });
      totalCarts++;
      void cart;
    }
  }
  console.log(`✓ ${total} customers, ${totalPurchases} purchases, ${totalCarts} abandoned carts`);
}

async function main() {
  console.log('Seeding demo data...');
  await seedProducts();
  await seedReviews();
  await seedCustomers();

  console.log('\nSummary:');
  const [productCount, customerCount, cartCount, purchaseCount, reviewCount] = await Promise.all([
    prisma.product.count(),
    prisma.customer.count(),
    prisma.cart.count({ where: { status: CartStatus.ABANDONED } }),
    prisma.purchase.count(),
    prisma.productReview.count(),
  ]);
  console.log(`  products:          ${productCount}`);
  console.log(`  customers:         ${customerCount}`);
  console.log(`  abandoned carts:   ${cartCount}`);
  console.log(`  purchases:         ${purchaseCount}`);
  console.log(`  reviews:           ${reviewCount}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
