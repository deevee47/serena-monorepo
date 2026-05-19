// Constants/types safe to import from both client and server components.
// The server-only `getProviderOverride()` lives in `./provider` so client
// bundles don't try to pull in `next/headers`.

export type ProviderName = 'vapi' | 'telnyx';
export const PROVIDER_COOKIE = 'serena_voice_provider';
