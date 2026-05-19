'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PROVIDER_COOKIE, type ProviderName } from '@/lib/provider-shared';
import { cn } from '@/lib/utils';

interface ProviderSelectorProps {
  /** Active provider this request resolved to (cookie value or env default). */
  active: ProviderName;
}

/**
 * Header toggle for switching the dashboard's active voice provider. Writes
 * a 1-year cookie and refreshes server components so /talk re-fetches the
 * right web-call config and renders the matching SDK wrapper.
 *
 * Per-request override only — the gateway's webhook + LLM endpoints
 * auto-detect the provider from the incoming request shape, so flipping
 * this doesn't break in-flight calls from the other provider.
 */
export function ProviderSelector({ active }: ProviderSelectorProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const setProvider = (next: ProviderName) => {
    if (next === active) return;
    // 1-year cookie, path=/ so every page reads it.
    document.cookie = `${PROVIDER_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    startTransition(() => router.refresh());
  };

  return (
    <div
      role="radiogroup"
      aria-label="Voice provider"
      className={cn(
        'flex items-center gap-px overflow-hidden rounded-md border bg-muted/40 text-xs font-medium',
        pending && 'opacity-60',
      )}
    >
      {(['vapi', 'telnyx'] as const).map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={active === name}
          disabled={pending}
          onClick={() => setProvider(name)}
          className={cn(
            'px-2.5 py-1 transition-colors',
            active === name
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {name === 'vapi' ? 'Vapi' : 'Telnyx'}
        </button>
      ))}
    </div>
  );
}
