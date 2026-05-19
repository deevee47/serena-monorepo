/**
 * Thin proxy to the Serena node-gateway. Server-only — never call from a
 * client component. The gateway holds the admin secret and provider creds.
 */

import type { ProviderName } from './provider';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000';

function adminHeaders() {
  const secret = process.env.GATEWAY_ADMIN_SECRET ?? '';
  return {
    'Content-Type': 'application/json',
    'X-Admin-Secret': secret,
  };
}

export type TriggerReason = 'cart_abandon' | 'page_view' | 'wishlist' | 'manual';

export interface TriggerCallInput {
  phone_number: string;
  product_id: string;
  trigger_reason: TriggerReason;
  metadata?: Record<string, unknown>;
  /** Dashboard-selected provider; gateway falls back to its env default. */
  provider?: ProviderName;
}

export interface TriggerCallResult {
  ok: boolean;
  callId?: string;
  error?: string;
  status?: number;
}

export async function triggerCall(input: TriggerCallInput): Promise<TriggerCallResult> {
  try {
    const res = await fetch(`${GATEWAY_URL}/calls/trigger`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(input),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          (body as { error?: { message?: string } } | null)?.error?.message ??
          `gateway returned ${res.status}`,
      };
    }
    return { ok: true, callId: (body as { call_id?: string } | null)?.call_id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'gateway unreachable',
    };
  }
}

export interface RecordingResult {
  ok: boolean;
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  /** ISO timestamp the provider began recording. Used by the dashboard
   *  scrubber as the timeline anchor (recording start ≠ call.createdAt;
   *  see the call-scrubber comments for the gap explanation). */
  recordingStartedAt?: string;
  error?: string;
  status?: number;
}

export async function getCallRecording(callId: string): Promise<RecordingResult> {
  try {
    const res = await fetch(
      `${GATEWAY_URL}/calls/${encodeURIComponent(callId)}/recording`,
      { headers: adminHeaders(), cache: 'no-store' },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          (body as { error?: { message?: string } } | null)?.error?.message ??
          `gateway returned ${res.status}`,
      };
    }
    const data = body as {
      recording_url?: string | null;
      stereo_recording_url?: string | null;
      recording_started_at?: string | null;
    } | null;
    return {
      ok: true,
      recordingUrl: data?.recording_url ?? undefined,
      stereoRecordingUrl: data?.stereo_recording_url ?? undefined,
      recordingStartedAt: data?.recording_started_at ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'gateway unreachable',
    };
  }
}

export interface LiveSession {
  callId: string;
  phoneNumber?: string;
  /** Serena tracks a `currentProductId` on the Redis session. */
  currentProductId?: string;
  stage?: string;
  objectionsEncountered?: string[];
  discountsOffered?: number[];
  turnCount?: number;
  isActive?: boolean;
  lastUpdatedAt?: string;
  conversationHistory?: Array<{
    speaker: 'USER' | 'AGENT';
    utterance: string;
    timestamp: string;
  }>;
  error?: string;
}

export type WebCallConfigResult =
  | { ok: false; error: string }
  | {
      ok: true;
      provider: 'vapi';
      publicKey: string;
      assistantId: string;
    }
  | {
      ok: true;
      provider: 'telnyx';
      assistantId: string;
    };

export async function getWebCallConfig(
  override?: ProviderName,
): Promise<WebCallConfigResult> {
  try {
    const url = override
      ? `${GATEWAY_URL}/calls/web-config?provider=${encodeURIComponent(override)}`
      : `${GATEWAY_URL}/calls/web-config`;
    const res = await fetch(url, {
      headers: adminHeaders(),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        error:
          (body as { error?: { message?: string } } | null)?.error?.message ??
          `gateway returned ${res.status}`,
      };
    }
    const data = body as {
      provider?: 'vapi' | 'telnyx';
      mode?: 'public_key' | 'jwt' | 'anonymous';
      token?: string;
      target?: string;
      assistant_id?: string;
      public_key?: string;
    } | null;
    if (!data) {
      return { ok: false, error: 'gateway returned no body' };
    }

    if (data.provider === 'telnyx') {
      // We only do anonymous WebRTC against AI assistants — the JWT/DID path
      // is dormant on the gateway side. The dashboard treats every Telnyx
      // config the same: pass assistantId through to @telnyx/ai-agent-lib.
      const assistantId = data.assistant_id;
      if (!assistantId) {
        return { ok: false, error: 'gateway returned a Telnyx config without assistant_id' };
      }
      return { ok: true, provider: 'telnyx', assistantId };
    }

    const publicKey = data.token ?? data.public_key;
    const assistantId = data.assistant_id ?? data.target;
    if (!publicKey || !assistantId) {
      return { ok: false, error: 'gateway returned an incomplete Vapi config' };
    }
    return { ok: true, provider: 'vapi', publicKey, assistantId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'gateway unreachable',
    };
  }
}

export type CallMode = 'INBOUND_PRESALES' | 'OUTBOUND_RECOVERY';

/**
 * Ask the gateway for the call opener. The pool + weighted selection live
 * server-side in `opener.service.ts` so both providers (and PSTN) get the
 * same set without forking client-side variants.
 */
export async function generateOpener(input: {
  mode: CallMode;
  product_id?: string | null;
}): Promise<string | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/calls/opener`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(input),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { opener?: string } | null;
    return body?.opener ?? null;
  } catch {
    return null;
  }
}

export async function getCallByBridge(uuid: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${GATEWAY_URL}/calls/by-bridge/${encodeURIComponent(uuid)}`,
      { headers: adminHeaders(), cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { call_id?: string } | null;
    return body?.call_id ?? null;
  } catch {
    return null;
  }
}

export async function getLiveSession(callId: string): Promise<LiveSession | null> {
  try {
    const res = await fetch(
      `${GATEWAY_URL}/debug/session/${encodeURIComponent(callId)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as LiveSession & { error?: string };
    if (body.error) return null;
    return body;
  } catch {
    return null;
  }
}
