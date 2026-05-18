'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isAuthed } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const ALLOWED_TYPES = ['BUNDLE', 'QUANTITY'] as const;

const schema = z
  .object({
    product_id: z.string().trim().min(1, 'Pick a product'),
    type: z.enum(ALLOWED_TYPES),
    description: z.string().trim().min(3, 'Description required').max(280),
    short_pitch: z.string().trim().min(3, 'Short pitch required').max(140),
    discount_percent: z.coerce.number().int().min(0).max(25),
    bundle_product_id: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
    min_quantity: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? Number(v) : undefined))
      .pipe(z.number().int().positive().optional()),
    valid_until: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? new Date(v) : undefined))
      .pipe(z.date().optional()),
    is_active: z.coerce.boolean().optional().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'BUNDLE' && !data.bundle_product_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['bundle_product_id'],
        message: 'Pick a bundled product',
      });
    }
    if (data.type === 'QUANTITY' && !data.min_quantity) {
      ctx.addIssue({
        code: 'custom',
        path: ['min_quantity'],
        message: 'Set the minimum quantity (≥ 2)',
      });
    }
  });

export type CreateOfferState = {
  ok: boolean;
  message: string;
};

export async function createOfferAction(
  _prev: CreateOfferState | undefined,
  formData: FormData,
): Promise<CreateOfferState> {
  if (!(await isAuthed())) {
    return { ok: false, message: 'Session expired — sign in again.' };
  }

  const parsed = schema.safeParse({
    product_id: formData.get('product_id')?.toString() ?? '',
    type: formData.get('type')?.toString() ?? 'BUNDLE',
    description: formData.get('description')?.toString() ?? '',
    short_pitch: formData.get('short_pitch')?.toString() ?? '',
    discount_percent: formData.get('discount_percent')?.toString() ?? '0',
    bundle_product_id: formData.get('bundle_product_id')?.toString() ?? '',
    min_quantity: formData.get('min_quantity')?.toString() ?? '',
    valid_until: formData.get('valid_until')?.toString() ?? '',
    is_active: formData.get('is_active') ? true : false,
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues
        .map((i) => `${i.path.join('.') || 'form'}: ${i.message}`)
        .join(' • '),
    };
  }
  const d = parsed.data;

  try {
    await prisma.offer.create({
      data: {
        productId: d.product_id,
        type: d.type,
        description: d.description,
        shortPitch: d.short_pitch,
        discountPercent: d.discount_percent,
        bundleProductId: d.type === 'BUNDLE' ? d.bundle_product_id ?? null : null,
        minQuantity: d.type === 'QUANTITY' ? d.min_quantity ?? null : null,
        validUntil: d.valid_until ?? null,
        isActive: d.is_active,
      },
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Database write failed',
    };
  }

  revalidatePath('/offers');
  revalidatePath('/talk');
  return { ok: true, message: 'Offer created.' };
}
