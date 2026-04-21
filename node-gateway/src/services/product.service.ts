// Products mirror scripts/seed.ts — keep in sync with seed data
// TODO: Step 4.2 — getProductById could query DB instead of CATALOG

import { findProductAlternatives } from './brain.service.js';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  tags: string[];
  isActive: boolean;
}

export interface ProductContext {
  product_id: string;
  name: string;
  price: number;
  description: string;
  key_features: string[];
}

const CATALOG: Product[] = [
  {
    id: 'prod-001',
    name: 'ProComfort Ergonomic Chair',
    description: 'Premium ergonomic office chair with lumbar support',
    price: 349.0,
    category: 'Office',
    tags: ['ergonomic', 'chair', 'office', 'lumbar', 'adjustable'],
    isActive: true,
  },
  {
    id: 'prod-002',
    name: 'ProComfort Lite Chair',
    description: 'Affordable ergonomic chair for home offices',
    price: 179.0,
    category: 'Office',
    tags: ['ergonomic', 'chair', 'office', 'budget', 'adjustable'],
    isActive: true,
  },
  {
    id: 'prod-003',
    name: 'AirPods Max Clone X1',
    description: 'Premium noise-cancelling wireless headphones',
    price: 129.0,
    category: 'Electronics',
    tags: ['headphones', 'wireless', 'noise-cancelling', 'audio', 'electronics'],
    isActive: true,
  },
  {
    id: 'prod-004',
    name: 'SleepWave Mattress Queen',
    description: 'Memory foam queen mattress for deep sleep',
    price: 799.0,
    category: 'Home',
    tags: ['mattress', 'queen', 'memory-foam', 'sleep', 'home'],
    isActive: true,
  },
  {
    id: 'prod-005',
    name: 'SleepWave Mattress Twin',
    description: 'Memory foam twin mattress for deep sleep',
    price: 499.0,
    category: 'Home',
    tags: ['mattress', 'twin', 'memory-foam', 'sleep', 'home', 'budget'],
    isActive: true,
  },
  {
    id: 'prod-006',
    name: 'FitTrack Pro Scale',
    description: 'Smart body composition scale with app sync',
    price: 59.0,
    category: 'Fitness',
    tags: ['scale', 'fitness', 'smart', 'health', 'tracking'],
    isActive: true,
  },
  {
    id: 'prod-007',
    name: 'Resistance Band Set',
    description: 'Premium resistance bands for home workouts',
    price: 29.0,
    category: 'Fitness',
    tags: ['bands', 'fitness', 'workout', 'home', 'resistance', 'budget'],
    isActive: true,
  },
  {
    id: 'prod-008',
    name: 'Standing Desk Converter',
    description: 'Adjustable desktop converter for sit-stand working',
    price: 249.0,
    category: 'Office',
    tags: ['desk', 'standing', 'office', 'adjustable', 'ergonomic'],
    isActive: true,
  },
];

export function getProductById(productId: string): Product | null {
  return CATALOG.find((p) => p.id === productId && p.isActive) ?? null;
}

export async function findAlternativeProduct(
  currentProductId: string,
  reason: 'PRICE' | 'FEATURE' | 'CATEGORY',
): Promise<ProductContext | null> {
  const current = getProductById(currentProductId);
  if (!current) return null;

  let query: string;
  let currentPrice: number | undefined;

  if (reason === 'PRICE') {
    query = `cheaper alternative to ${current.name}`;
    currentPrice = current.price;
  } else if (reason === 'FEATURE') {
    query = `${current.name}: ${current.tags.join(' ')}`;
  } else {
    query = 'alternative product in a different category';
  }

  const { alternatives } = await findProductAlternatives({
    query,
    exclude_id: currentProductId,
    current_price: currentPrice,
  });

  return alternatives[0] ?? null;
}

export function toProductContext(product: Product): ProductContext {
  return {
    product_id: product.id,
    name: product.name,
    price: product.price,
    description: product.description ?? '',
    key_features: product.tags,
  };
}
