// Catalog is loaded from Postgres at startup (see loadCatalog()) and held in
// memory as a Map for sync `getProductById` lookups. Avoids the old drift
// problem where a hand-maintained CATALOG array diverged from seed data.

import { findProductAlternatives } from './brain.service.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';

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

let catalog: Map<string, Product> = new Map();

/**
 * Load (or reload) the in-memory product catalog from the DB. Called at
 * gateway startup; safe to call again after a re-seed without restarting.
 */
export async function loadCatalog(): Promise<void> {
  const rows = await prisma.product.findMany({ where: { isActive: true } });
  const next = new Map<string, Product>();
  for (const r of rows) {
    next.set(r.id, {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      price: Number(r.price),
      category: r.category ?? null,
      tags: r.tags,
      isActive: r.isActive,
    });
  }
  catalog = next;
  logger.info({ product_count: catalog.size }, 'Product catalog loaded from DB');
}

export function getProductById(productId: string): Product | null {
  return catalog.get(productId) ?? null;
}

export function getCatalogSize(): number {
  return catalog.size;
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
    ...(current.category ? { category: current.category } : {}),
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
