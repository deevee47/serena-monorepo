import type { IncomingHttpHeaders } from 'node:http';
import got from 'got';
import { config } from '../../config/env.js';
import type {
  TelnyxCallEventBasePayload,
  TelnyxCallHangupPayload,
  TelnyxCallInitiatedPayload,
  TelnyxClientStatePayload,
  TelnyxCreateCallResponse,
  TelnyxRecordingResponse,
  TelnyxRecordingSavedPayload,
  TelnyxTexmlStatusPayload,
  TelnyxWebhookEnvelope,
} from '../../types/telnyx.types.js';
import { verifyTelnyxSignature } from './ed25519.js';
import crypto from 'node:crypto';
import type {
  CallRecording,
  CreatePhoneCallParams,
  CreatePhoneCallResult,
  LlmRequestEnvelope,
  NormalizedVoiceEvent,
  ParsedWebhook,
  VoiceProvider,
  WebClientConfig,
  WebhookVerification,
} from './types.js';

/** Terminal TeXML CallStatus values that close the call. */
const TEXML_TERMINAL_STATUSES = new Set<TelnyxTexmlStatusPayload['CallStatus']>([
  'completed',
  'no-answer',
  'busy',
  'failed',
  'canceled',
]);

/**
 * Map a TeXML status callback (form-urlencoded, Twilio-compat) to our internal
 * event taxonomy. Distinct from the JSON Voice API envelope handled by
 * `TelnyxProvider.parseWebhook` — TeXML apps deliver this shape on every
 * `status_callback` URL, with no `data.event_type` wrapper.
 *
 * Returns [] for non-actionable statuses (`ringing`, `answered`, `in-progress`)
 * so the caller can 200 quickly without branching.
 *
 * Note on bridge mapping: TeXML status callbacks do NOT include `client_state`
 * (no equivalent of Voice API's `client_state` field). The dashboard's
 * bridgeUuid → callId resolution relies on `client_state` arriving via webhook,
 * so for TeXML-routed WebRTC calls the bridge entry is intentionally NOT
 * written here. Callers depending on the bridge map must set it through a
 * different path (e.g., a client-side POST after the SDK assigns the call ID).
 */
export function parseTexmlStatusCallback(
  body: Partial<TelnyxTexmlStatusPayload>,
): ParsedWebhook {
  const callId = body.CallSid;
  const status = body.CallStatus;
  if (!callId || !status) return [];

  if (status === 'initiated') {
    const event: NormalizedVoiceEvent = {
      kind: 'call.started',
      callId,
      phoneNumber: body.From ?? null,
      metadata: {},
      respondWithAssistantId: null,
      raw: body,
    };
    return [event];
  }

  if (TEXML_TERMINAL_STATUSES.has(status)) {
    const durationStr = body.CallDuration;
    const parsed = durationStr ? Number.parseInt(durationStr, 10) : Number.NaN;
    const event: NormalizedVoiceEvent = {
      kind: 'call.ended',
      callId,
      durationSeconds: Number.isFinite(parsed) ? parsed : null,
      endedReason: status,
      raw: body,
    };
    return [event];
  }

  return [];
}

const TELNYX_API = 'https://api.telnyx.com/v2';

function requireEnv<K extends keyof typeof config>(key: K): NonNullable<(typeof config)[K]> {
  const v = config[key];
  if (v === undefined || v === null || v === '') {
    throw new Error(`${String(key)} is required when VOICE_PROVIDER=telnyx`);
  }
  return v as NonNullable<(typeof config)[K]>;
}

function assistantIdForLocale(locale: 'en' | 'hi'): string {
  if (locale === 'hi' && config.TELNYX_ASSISTANT_HI) return config.TELNYX_ASSISTANT_HI;
  if (locale === 'en' && config.TELNYX_ASSISTANT_EN) return config.TELNYX_ASSISTANT_EN;
  return requireEnv('TELNYX_ASSISTANT_ID');
}

function encodeClientState(payload: TelnyxClientStatePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeClientState(raw: string | null | undefined): TelnyxClientStatePayload | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as TelnyxClientStatePayload;
  } catch {
    return null;
  }
}

export class TelnyxProvider implements VoiceProvider {
  readonly name = 'telnyx' as const;

  async createPhoneCall(params: CreatePhoneCallParams): Promise<CreatePhoneCallResult> {
    const assistantId = assistantIdForLocale(params.locale);
    const fromNumber = requireEnv('TELNYX_PHONE_NUMBER');
    const connectionId = requireEnv('TELNYX_PHONE_NUMBER_ID');

    const clientState = encodeClientState({
      product_id: params.productId,
      trigger_reason: params.triggerReason,
      assistant_id: assistantId,
      ...params.metadata,
    });

    const res = await got
      .post(`${TELNYX_API}/calls`, {
        headers: { Authorization: `Bearer ${requireEnv('TELNYX_API_KEY')}` },
        json: {
          to: params.phoneNumber,
          from: fromNumber,
          connection_id: connectionId,
          client_state: clientState,
          // Telnyx attaches the AI Assistant via ai_assistant_start after
          // answer; the connection_id should point at a SIP application
          // configured to invoke that command automatically. If not, a
          // worker on call.answered fires:
          //   POST /v2/calls/{id}/actions/ai_assistant_start
          // with { assistant_id: assistantId }. Out of scope for adapter.
        },
      })
      .json<TelnyxCreateCallResponse>();

    return { callId: res.data.call_control_id, raw: res };
  }

  async getCall(callIdOrRecordingId: string): Promise<CallRecording> {
    // Two input shapes flow into this:
    //   1. A recording UUID (8-4-4-4-12) — happens after `providerRecordingId`
    //      gets populated, either from a `call.recording.saved` webhook or
    //      from a previous list-filter lookup below.
    //   2. A call_control_id starting `v3:` — happens when the dashboard's
    //      recording endpoint is hit before any webhook fires (typical for
    //      TeXML-routed AI Assistant calls where `call.recording.saved`
    //      never arrives at our TeXML status_callback URL).
    //
    // Telnyx's singular `/v2/recordings/{id}` 400s on the v3: shape because
    // it expects a UUID. The LIST endpoint accepts `filter[call_control_id]`
    // which is exactly what we need for case (2). Detect the shape and
    // route accordingly.
    const isCallControlId = callIdOrRecordingId.startsWith('v3:');
    const apiKey = requireEnv('TELNYX_API_KEY');
    const handleNotAvailable = (err: unknown): CallRecording => {
      const status =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { statusCode?: number } }).response?.statusCode
          : undefined;
      // Treat full 4xx as "no recording at this id" — 404/400/422 all mean
      // we shouldn't surface a recording. 5xx + network errors still throw
      // so the route returns a real provider error instead of a silent null.
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return { recordingUrl: null, stereoRecordingUrl: null, recordingId: null, raw: null };
      }
      throw err;
    };

    if (!isCallControlId) {
      try {
        const res = await got
          .get(`${TELNYX_API}/recordings/${encodeURIComponent(callIdOrRecordingId)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          .json<TelnyxRecordingResponse>();
        const mp3 = res.data.download_urls?.mp3 ?? null;
        const wav = res.data.download_urls?.wav ?? null;
        return {
          // Both slots get the mp3 URL when wav isn't published (typical for
          // dual-channel mp3 recordings — both speakers in one file). The
          // dashboard's player resolves `stereo ?? recording`, so populating
          // either is enough; populating both is symmetric.
          recordingUrl: mp3,
          stereoRecordingUrl: wav ?? mp3,
          recordingId: res.data.id,
          recordingStartedAt: res.data.recording_started_at ?? null,
          raw: res,
        };
      } catch (err) {
        return handleNotAvailable(err);
      }
    }

    // List + filter path for call_control_id inputs.
    try {
      const res = await got
        .get(`${TELNYX_API}/recordings`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          searchParams: {
            'filter[call_control_id]': callIdOrRecordingId,
            'page[size]': '1',
          },
        })
        .json<{ data: TelnyxRecordingResponse['data'][] }>();
      const first = res.data?.[0];
      if (!first) {
        return { recordingUrl: null, stereoRecordingUrl: null, recordingId: null, raw: null };
      }
      const mp3 = first.download_urls?.mp3 ?? null;
      const wav = first.download_urls?.wav ?? null;
      return {
        recordingUrl: mp3,
        stereoRecordingUrl: wav ?? mp3,
        recordingId: first.id,
        recordingStartedAt: first.recording_started_at ?? null,
        raw: first,
      };
    } catch (err) {
      return handleNotAvailable(err);
    }
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerification {
    // Dev escape hatch — bypass verification entirely while wiring up a
    // new Telnyx assistant. The webhook handler logs the raw headers when
    // we hit this path so we can see what Telnyx actually sends.
    if (config.TELNYX_INSECURE_DEV === '1') {
      return { ok: true };
    }
    const signature = headers['telnyx-signature-ed25519'] as string | undefined;
    const timestamp = headers['telnyx-timestamp'] as string | undefined;
    return verifyTelnyxSignature({
      rawBody,
      signatureBase64: signature,
      timestampHeader: timestamp,
      publicKeyBase64: requireEnv('TELNYX_PUBLIC_KEY'),
    });
  }

  parseWebhook(_rawBody: Buffer, parsed: unknown): ParsedWebhook {
    const env = parsed as TelnyxWebhookEnvelope | null;
    const data = env?.data;
    if (!data || !data.event_type) return [];

    switch (data.event_type) {
      case 'call.initiated':
      case 'call.answered': {
        const payload = data.payload as TelnyxCallInitiatedPayload;
        const callId = payload.call_control_id;
        if (!callId) return [];
        const clientState = decodeClientState(payload.client_state ?? null) ?? {};
        return [
          {
            kind: 'call.started',
            callId,
            phoneNumber: payload.from ?? null,
            metadata: clientState as Record<string, unknown>,
            respondWithAssistantId: null,
            raw: data,
          },
        ];
      }

      case 'call.hangup': {
        const payload = data.payload as TelnyxCallHangupPayload;
        const callId = payload.call_control_id;
        if (!callId) return [];
        const duration =
          payload.start_time && payload.end_time
            ? Math.max(
                0,
                Math.floor(
                  (Date.parse(payload.end_time) - Date.parse(payload.start_time)) / 1000,
                ),
              )
            : null;
        return [
          {
            kind: 'call.ended',
            callId,
            durationSeconds: duration,
            endedReason: payload.hangup_cause ?? null,
            raw: data,
          },
        ];
      }

      case 'call.recording.saved': {
        const payload = data.payload as TelnyxRecordingSavedPayload;
        const callId = payload.call_control_id;
        if (!callId) return [];
        const urls = payload.recording_urls ?? payload.public_recording_urls ?? {};
        return [
          {
            kind: 'recording.ready',
            callId,
            recordingUrl: urls.mp3 ?? null,
            stereoRecordingUrl: urls.wav ?? null,
            recordingId: payload.recording_id ?? null,
            raw: data,
          },
        ];
      }

      default:
        return [];
    }
  }

  parseLlmEnvelope(headers: IncomingHttpHeaders, body: unknown): LlmRequestEnvelope {
    // Telnyx's exact envelope varies by assistant config (e.g. whether
    // `forward_metadata` is on). Try every documented location for the
    // call_control_id, then fall through to body-level fields that other
    // Telnyx products use. If none match we return null and the caller
    // logs the raw shape so we can extend this list.
    const headerCandidates = [
      'x-telnyx-call-control-id',
      'telnyx-call-control-id',
      'x-call-control-id',
    ];
    let callId: string | null = null;
    for (const h of headerCandidates) {
      const v = headers[h];
      if (typeof v === 'string' && v.length > 0) {
        callId = v;
        break;
      }
    }

    const b = body as {
      call_control_id?: string;
      callControlId?: string;
      call?: { id?: string; call_control_id?: string };
      extra_metadata?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      telnyx_call?: { call_control_id?: string };
    } | null;

    const meta = b?.extra_metadata ?? b?.metadata ?? {};

    if (!callId) {
      // AI-Assistant Custom LLM with "Forward Metadata" enabled puts call
      // identifiers inside `extra_metadata` (OpenAI-SDK-style requests with
      // `x-stainless-*` headers — no Telnyx-specific request headers).
      // Standard Voice-API Custom LLM puts them at the top level. Check both.
      const metaCallId =
        (typeof meta['call_control_id'] === 'string' ? (meta['call_control_id'] as string) : null) ??
        (typeof meta['callControlId'] === 'string' ? (meta['callControlId'] as string) : null) ??
        (typeof meta['telnyx_call_control_id'] === 'string'
          ? (meta['telnyx_call_control_id'] as string)
          : null);
      callId =
        b?.call_control_id ??
        b?.callControlId ??
        b?.telnyx_call?.call_control_id ??
        b?.call?.call_control_id ??
        b?.call?.id ??
        metaCallId ??
        null;
    }

    const phoneNumber =
      (typeof meta['caller'] === 'string' ? (meta['caller'] as string) : null) ??
      (typeof meta['from'] === 'string' ? (meta['from'] as string) : null) ??
      (typeof meta['caller_id_number'] === 'string'
        ? (meta['caller_id_number'] as string)
        : null);

    return { callId, phoneNumber, metadata: meta };
  }

  verifyLlmAuth(headers: IncomingHttpHeaders): WebhookVerification {
    // Custom-LLM uses a separate shared secret. If unset, fall open to
    // permit local-dev while the assistant is being wired up — same
    // posture as the legacy vapi-llm route.
    const expectedSecret = config.TELNYX_LLM_SHARED_SECRET;
    if (!expectedSecret) {
      return { ok: true };
    }
    const authHeader = headers['authorization'] as string | undefined;
    const expected = `Bearer ${expectedSecret}`;
    const expBuf = Buffer.from(expected);
    const authBuf = Buffer.from(authHeader ?? '');
    const ok = authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
    return ok ? { ok: true } : { ok: false, reason: 'invalid_bearer_token' };
  }

  async getWebClientConfig(): Promise<WebClientConfig> {
    const assistantId = requireEnv('TELNYX_ASSISTANT_ID');

    // Anonymous mode — no Telnyx-owned DID, no telephony credential
    // required. The browser connects straight to the assistant via the
    // SDK's `anonymous_login`. Default whenever the JWT prereqs aren't
    // configured yet (typical for first-time setup).
    if (!config.TELNYX_TELEPHONY_CREDENTIAL_ID || !config.TELNYX_PHONE_NUMBER) {
      return {
        provider: 'telnyx',
        mode: 'anonymous',
        token: '',
        target: '',
        assistantId,
      };
    }

    // JWT mode — production with a real DID. Mint a short-lived login
    // token from the telephony credential; the browser dials our DID.
    const credentialId = config.TELNYX_TELEPHONY_CREDENTIAL_ID;
    const token = await got
      .post(`${TELNYX_API}/telephony_credentials/${encodeURIComponent(credentialId)}/token`, {
        headers: { Authorization: `Bearer ${requireEnv('TELNYX_API_KEY')}` },
      })
      .text();
    return {
      provider: 'telnyx',
      mode: 'jwt',
      token: token.trim(),
      target: config.TELNYX_PHONE_NUMBER,
      assistantId,
    };
  }
}

// Re-exported so test harnesses can construct stub payloads without importing
// from the types module directly.
export type { TelnyxCallEventBasePayload };
