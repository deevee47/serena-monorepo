import type { IncomingHttpHeaders } from 'node:http';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { VapiProvider } from './vapi-provider.js';
import { TelnyxProvider } from './telnyx-provider.js';
import type { VoiceProvider } from './types.js';

export type ProviderName = 'vapi' | 'telnyx';

// Cache both implementations as singletons. Each adapter is stateless past
// its env-derived config, so two instances would just duplicate config reads.
const instances: Partial<Record<ProviderName, VoiceProvider>> = {};

function instantiate(name: ProviderName): VoiceProvider {
  switch (name) {
    case 'vapi':
      return new VapiProvider();
    case 'telnyx':
      return new TelnyxProvider();
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown voice provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Get a specific provider by name. Lazily constructs + caches each
 * implementation. Use when a request indicates its own provider (e.g. via
 * a query param, body field, or detected webhook headers).
 */
export function getVoiceProvider(name: ProviderName): VoiceProvider {
  if (!instances[name]) {
    instances[name] = instantiate(name);
    logger.info({ provider: name }, 'voice provider initialised');
  }
  return instances[name]!;
}

/**
 * The "active" provider — used as the default when the request doesn't
 * indicate which provider it's for (e.g. /calls/web-config without
 * override). Driven by VOICE_PROVIDER env. For dev convenience the
 * dashboard can pass a per-request override that beats this default.
 */
export function voiceProvider(): VoiceProvider {
  return getVoiceProvider(config.VOICE_PROVIDER);
}

/**
 * Auto-detect which provider a webhook request is from. Falls back to the
 * active provider when no provider-specific marker is present.
 *
 *   Telnyx → carries `telnyx-signature-ed25519` header
 *   Vapi   → carries `Authorization: Bearer ...` header
 */
export function detectWebhookProvider(headers: IncomingHttpHeaders): ProviderName {
  if (headers['telnyx-signature-ed25519']) return 'telnyx';
  if (typeof headers['authorization'] === 'string') return 'vapi';
  return config.VOICE_PROVIDER;
}

/**
 * Auto-detect which provider a Custom-LLM request is from. Telnyx puts the
 * call_control_id in a header and (typically) sends an `extra_metadata`
 * block in the body; Vapi puts the call info inside `body.call`.
 */
export function detectLlmProvider(
  headers: IncomingHttpHeaders,
  body: unknown,
): ProviderName {
  if (headers['x-telnyx-call-control-id'] || headers['telnyx-call-control-id']) {
    return 'telnyx';
  }
  const b = body as { call?: { id?: string }; telnyx_call?: unknown } | null;
  if (b?.telnyx_call) return 'telnyx';
  if (b?.call?.id) return 'vapi';
  return config.VOICE_PROVIDER;
}

export type { VoiceProvider } from './types.js';
export * from './types.js';
