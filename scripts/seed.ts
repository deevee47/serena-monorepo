import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const sizes = ['S', 'M', 'L', 'XL'];
const colors = ['Black', 'White', 'Blue', 'Red', 'Grey'];

const baseClothingProducts = [
  {
    id: 'cloth-001',
    name: 'Classic Cotton T-Shirt',
    price: new Prisma.Decimal('19.99'),
    category: 'Clothing',
    tags: ['tshirt', 'cotton', 'casual'],
    description: 'Soft breathable cotton t-shirt',
  },
  {
    id: 'cloth-002',
    name: 'Oversized Streetwear Tee',
    price: new Prisma.Decimal('29.99'),
    category: 'Clothing',
    tags: ['tshirt', 'oversized', 'streetwear'],
    description: 'Trendy oversized streetwear t-shirt',
  },
  {
    id: 'cloth-003',
    name: 'Essential Hoodie',
    price: new Prisma.Decimal('39.99'),
    category: 'Clothing',
    tags: ['hoodie', 'winter', 'casual'],
    description: 'Warm hoodie for everyday wear',
  },
  {
    id: 'cloth-004',
    name: 'Slim Fit Jeans',
    price: new Prisma.Decimal('49.99'),
    category: 'Clothing',
    tags: ['jeans', 'denim', 'slim-fit'],
    description: 'Stylish slim fit denim jeans',
  },
];

function generateVariants(product: any) {
  const variants = [];

  for (const size of sizes) {
    for (const color of colors) {
      variants.push({
        id: `${product.id}-${size}-${color}`.toLowerCase(),
        name: `${product.name} (${size}, ${color})`,
        price: product.price,
        category: product.category,
        description: product.description,
        tags: [...product.tags, size.toLowerCase(), color.toLowerCase()],
        metadata: {
          size,
          color,
          baseProductId: product.id,
        },
      });
    }
  }

  return variants;
}

async function main() {
  let allVariants: any[] = [];

  for (const product of baseClothingProducts) {
    const variants = generateVariants(product);
    allVariants.push(...variants);
  }

  for (const variant of allVariants) {
    await prisma.product.upsert({
      where: { id: variant.id },
      update: {},
      create: variant,
    });
  }

  console.log(`Seeded ${allVariants.length} clothing variants`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());