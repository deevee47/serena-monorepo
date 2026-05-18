'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { PhoneOutgoing, Broadcast } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { triggerCallAction, type TriggerState } from '@/app/(app)/trigger/actions';

interface ProductOption {
  id: string;
  label: string;
  price: string;
}

interface TriggerFormProps {
  products: ProductOption[];
  defaultProductId?: string;
}

const REASONS = [
  { value: 'cart_abandon', label: 'Cart abandoned' },
  { value: 'page_view', label: 'Page view' },
  { value: 'wishlist', label: 'Wishlist re-engagement' },
  { value: 'manual', label: 'Manual outreach' },
] as const;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ff" size="lg" disabled={pending} className="w-full">
      <PhoneOutgoing className="size-4" />
      {pending ? 'Dialling…' : 'Dial now'}
    </Button>
  );
}

export function TriggerForm({ products, defaultProductId }: TriggerFormProps) {
  const [state, formAction] = useActionState<TriggerState | undefined, FormData>(
    triggerCallAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="phone_number">Phone number (E.164)</Label>
        <Input
          id="phone_number"
          name="phone_number"
          placeholder="+919876543210"
          required
          inputMode="tel"
          pattern="^\+[1-9]\d{1,14}$"
        />
        <p className="text-xs text-muted-foreground">
          Must include the country code, e.g. <code>+14155552671</code>.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="product_id">Product</Label>
          <select
            id="product_id"
            name="product_id"
            defaultValue={defaultProductId ?? products[0]?.id ?? ''}
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.price}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="trigger_reason">Reason</Label>
          <select
            id="trigger_reason"
            name="trigger_reason"
            defaultValue="cart_abandon"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <SubmitButton />

      {state ? (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            state.ok
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
        >
          <p>{state.message}</p>
          {state.ok && state.callId ? (
            <p className="mt-1 text-xs">
              Call id: <code className="rounded bg-background/60 px-1">{state.callId}</code>{' '}
              <Link href={`/live/${state.callId}`} className="inline-flex items-center gap-1 underline">
                <Broadcast className="size-3" />
                Tail it
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
