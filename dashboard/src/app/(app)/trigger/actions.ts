'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isAuthed } from '@/lib/auth';
import { triggerCall } from '@/lib/gateway';

const schema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Phone must be E.164 (e.g. +14155552671)'),
  product_id: z.string().min(1, 'Pick a product'),
  trigger_reason: z.enum(['cart_abandon', 'page_view', 'wishlist', 'manual']),
});

export type TriggerState = {
  ok: boolean;
  message: string;
  callId?: string;
};

export async function triggerCallAction(
  _prev: TriggerState | undefined,
  formData: FormData,
): Promise<TriggerState> {
  if (!(await isAuthed())) {
    return { ok: false, message: 'Session expired — sign in again.' };
  }

  const parsed = schema.safeParse({
    phone_number: formData.get('phone_number')?.toString() ?? '',
    product_id: formData.get('product_id')?.toString() ?? '',
    trigger_reason: formData.get('trigger_reason')?.toString() ?? 'manual',
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join(' • '),
    };
  }

  const result = await triggerCall({
    phone_number: parsed.data.phone_number,
    product_id: parsed.data.product_id,
    trigger_reason: parsed.data.trigger_reason,
  });

  if (!result.ok) {
    return {
      ok: false,
      message: result.error ?? 'Gateway rejected the call',
    };
  }

  revalidatePath('/live');
  revalidatePath('/calls');
  revalidatePath('/');
  return {
    ok: true,
    message: 'Call queued — Vapi is dialing now.',
    callId: result.callId,
  };
}
