import 'server-only';
import { cookies } from 'next/headers';
import { PROVIDER_COOKIE, type ProviderName } from './provider-shared';

export type { ProviderName } from './provider-shared';
export { PROVIDER_COOKIE } from './provider-shared';

/**
 * Resolve the active voice provider for this request. Reads the
 * `serena_voice_provider` cookie set by the dashboard's ProviderSelector;
 * falls back to undefined so callers can omit the override and let the
 * gateway use its env default.
 *
 * Server-only — importing this from a client component fails the build.
 */
export async function getProviderOverride(): Promise<ProviderName | undefined> {
  const c = await cookies();
  const v = c.get(PROVIDER_COOKIE)?.value;
  return v === 'vapi' || v === 'telnyx' ? v : undefined;
}
