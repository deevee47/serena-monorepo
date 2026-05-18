/**
 * Thin proxy to the Serena node-gateway. Server-only — never call from a
 * client component. The gateway holds the admin secret and Vapi creds.
 */

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
    } | null;
    return {
      ok: true,
      recordingUrl: data?.recording_url ?? undefined,
      stereoRecordingUrl: data?.stereo_recording_url ?? undefined,
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

export interface WebCallConfigResult {
  ok: boolean;
  publicKey?: string;
  assistantId?: string;
  error?: string;
}

export async function getWebCallConfig(): Promise<WebCallConfigResult> {
  try {
    const res = await fetch(`${GATEWAY_URL}/calls/web-config`, {
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
    const data = body as { public_key?: string; assistant_id?: string } | null;
    if (!data?.public_key || !data.assistant_id) {
      return { ok: false, error: 'gateway returned an incomplete config' };
    }
    return { ok: true, publicKey: data.public_key, assistantId: data.assistant_id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'gateway unreachable',
    };
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
