'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Plus, Tag } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  createOfferAction,
  type CreateOfferState,
} from '@/app/(app)/offers/actions';

interface ProductOption {
  id: string;
  label: string;
}

interface NewOfferFormProps {
  products: ProductOption[];
}

type OfferType = 'BUNDLE' | 'QUANTITY';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ff" disabled={pending}>
      <Tag className="size-4" />
      {pending ? 'Creating…' : 'Create offer'}
    </Button>
  );
}

const selectCls =
  'flex h-9 w-full border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function NewOfferForm({ products }: NewOfferFormProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<OfferType>('BUNDLE');
  const [state, formAction] = useActionState<CreateOfferState | undefined, FormData>(
    async (prev, fd) => {
      const result = await createOfferAction(prev, fd);
      if (result.ok) {
        setTimeout(() => setOpen(false), 600);
      }
      return result;
    },
    undefined,
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ff" size="sm">
          <Plus className="size-4" />
          New offer
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New offer</SheetTitle>
          <SheetDescription>
            Bundles unlock a discount when a second product is added. Quantity
            offers fire when the caller orders N or more of the primary product.
          </SheetDescription>
        </SheetHeader>

        <form action={formAction} className="space-y-4 px-4 pb-6">
          <div className="space-y-2">
            <Label htmlFor="product_id">Product</Label>
            <select id="product_id" name="product_id" required defaultValue="" className={selectCls}>
              <option value="" disabled>
                Choose a product…
              </option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <select
                id="type"
                name="type"
                value={type}
                onChange={(e) => setType(e.target.value as OfferType)}
                className={selectCls}
              >
                <option value="BUNDLE">Bundle</option>
                <option value="QUANTITY">Quantity</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="discount_percent">Discount % (0–25)</Label>
              <Input
                id="discount_percent"
                name="discount_percent"
                type="number"
                min="0"
                max="25"
                step="1"
                placeholder="10"
                required
              />
            </div>
          </div>

          {type === 'BUNDLE' ? (
            <div className="space-y-2">
              <Label htmlFor="bundle_product_id">Bundle with</Label>
              <select
                id="bundle_product_id"
                name="bundle_product_id"
                defaultValue=""
                className={selectCls}
              >
                <option value="">Choose a complementary product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="min_quantity">Minimum quantity</Label>
              <Input
                id="min_quantity"
                name="min_quantity"
                type="number"
                min="2"
                step="1"
                placeholder="3"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="short_pitch">Voice pitch (≤140 chars)</Label>
            <Input
              id="short_pitch"
              name="short_pitch"
              placeholder="Add Creatine and I can knock 5% off the order"
              required
              maxLength={140}
            />
            <p className="text-xs text-muted-foreground">
              Serena quotes this line near-verbatim — keep it conversational.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Internal description</Label>
            <Input
              id="description"
              name="description"
              placeholder="Bundle Whey Isolate with Creatine for 5% off both items"
              required
              maxLength={280}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="valid_until">Valid until (optional)</Label>
            <Input id="valid_until" name="valid_until" type="datetime-local" />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="is_active"
              defaultChecked
              className="size-4 accent-[var(--color-ff-orange)]"
            />
            Active immediately
          </label>

          {state ? (
            <div
              role="status"
              className={cn(
                'border px-3 py-2 text-sm',
                state.ok
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-destructive/40 bg-destructive/10 text-destructive',
              )}
            >
              {state.message}
            </div>
          ) : null}

          <SheetFooter className="flex-row justify-end gap-2 px-0">
            <SheetClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </SheetClose>
            <SubmitButton />
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
