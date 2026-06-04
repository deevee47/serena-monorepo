import type { IncomingHttpHeaders } from 'node:http';

/** Locale hint used to pick the right assistant/voice for an outbound call. */
export type CallLocale = 'en' | 'hi';

export interface CreatePhoneCallParams {
  phoneNumber: string;
  productId: string;
  triggerReason: string;
  locale: CallLocale;
  metadata?: Record<string, unknown>;
}

export interface CreatePhoneCallResult {
  /** Canonical call ID — Vapi `call.id` or Telnyx `call_control_id`. */
  callId: string;
  /** Provider-native response body for logging/debugging. */
  raw: unknown;
}

export interface CallRecording {
  recordingUrl: string | null;
  stereoRecordingUrl: string | null;
  /** Telnyx recording_id needed for the recordings API fallback. Vapi: null. */
  recordingId?: string | null;
  /** ISO timestamp of when the provider actually started recording — anchors
   *  the dashboard scrubber timeline so turn positions and seek offsets match
   *  the audio file (which begins on call-answered, ~5–15s before our
   *  `Call.createdAt` row lands on first LLM turn). */
  recordingStartedAt?: string | null;
  raw: unknown;
}

/**
 * How the dashboard authenticates with the provider for web calls.
 *   - 'public_key': Vapi-style static public key (`Vapi(publicKey)`)
 *   - 'jwt'       : Telnyx short-lived login token + a destination phone
 *   - 'anonymous' : Telnyx anonymous WebRTC straight to an AI Assistant
 *                   (no DID, no telephony credential — easiest first test)
 */
export type WebClientMode = 'public_key' | 'jwt' | 'anonymous';

export interface WebClientConfig {
  provider: 'vapi' | 'telnyx';
  mode: WebClientMode;
  /** Vapi: public key. Telnyx jwt: login token. Telnyx anonymous: unused. */
  token: string;
  /** Vapi: assistant_id. Telnyx jwt: destination number. Telnyx anonymous: unused. */
  target: string;
  /** Telnyx-only: the assistant ID the browser connects to (anonymous mode). */
  assistantId?: string;
}

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

/**
 * Provider-agnostic webhook event taxonomy.
 *
 * Mapped from each provider's native shape by `parseWebhook`:
 *   - Vapi `assistant-request` / `status-update` (started) → call.started
 *   - Vapi `end-of-call-report` → fan-out to call.ended + recording.ready
 *   - Telnyx `call.initiated` / `call.answered` → call.started
 *   - Telnyx `call.hangup` → call.ended
 *   - Telnyx `call.recording.saved` → recording.ready
 *
 * Unknown / no-op events return null from parseWebhook so the handler can
 * 200 quickly without branching.
 */
export type NormalizedVoiceEvent =
  | {
      kind: 'call.started';
      callId: string;
      phoneNumber: string | null;
      metadata: Record<string, unknown>;
      /**
       * Vapi's `assistant-request` expects a synchronous {assistantId} reply.
       * The provider sets this so the webhook handler knows to echo it back.
       * Telnyx leaves this null.
       */
      respondWithAssistantId?: string | null;
      raw: unknown;
    }
  | {
      kind: 'call.ended';
      callId: string;
      durationSeconds: number | null;
      endedReason: string | null;
      raw: unknown;
    }
  | {
      kind: 'recording.ready';
      callId: string;
      recordingUrl: string | null;
      stereoRecordingUrl: string | null;
      recordingId: string | null;
      raw: unknown;
    }
  | {
      /**
       * Provider speech-boundary signal — the agent stopped speaking or the
       * user started. Used to measure pre-response latency from real provider
       * timestamps instead of estimating TTS playback. `atMs` is the provider's
       * event epoch-ms; null when the provider omits it (the handler then uses
       * webhook receipt time).
       */
      kind: 'speech.boundary';
      callId: string;
      role: 'user' | 'assistant';
      status: 'started' | 'stopped';
      atMs: number | null;
      raw: unknown;
    };

/**
 * Some provider events (notably Vapi's `end-of-call-report`) carry both an
 * "ended" signal and recording URLs in one payload. `parseWebhook` returns an
 * array so the handler can react to both.
 */
export type ParsedWebhook = NormalizedVoiceEvent[];

/**
 * Extracted call context from a Custom LLM /chat/completions request. The
 * provider knows whether `call_control_id` lives in a header (Telnyx) or in
 * the body (Vapi); the LLM route stays provider-agnostic.
 */
export interface LlmRequestEnvelope {
  callId: string | null;
  phoneNumber: string | null;
  metadata: Record<string, unknown>;
}

export interface VoiceProvider {
  readonly name: 'vapi' | 'telnyx';

  createPhoneCall(params: CreatePhoneCallParams): Promise<CreatePhoneCallResult>;
  getCall(callId: string): Promise<CallRecording>;
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerification;
  parseWebhook(rawBody: Buffer, parsed: unknown): ParsedWebhook;
  parseLlmEnvelope(headers: IncomingHttpHeaders, body: unknown): LlmRequestEnvelope;
  /**
   * Verify the Bearer token that the provider attaches to Custom-LLM POSTs.
   * For Vapi this is the shared webhook secret; for Telnyx it's a separate
   * LLM-specific shared secret.
   */
  verifyLlmAuth(headers: IncomingHttpHeaders): WebhookVerification;
  getWebClientConfig(): Promise<WebClientConfig>;
}
