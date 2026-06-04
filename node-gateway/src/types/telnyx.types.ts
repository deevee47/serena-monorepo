/**
 * Telnyx Voice / AI Assistants webhook + API shapes — only fields we actually
 * read are typed. Spec: developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks
 *
 * Common envelope:
 *   { data: { event_type: string, payload: <event-specific>, ... } }
 */

export interface TelnyxWebhookEnvelope<P = unknown> {
  data: {
    event_type: string;
    id?: string;
    occurred_at?: string;
    payload: P;
  };
}

export interface TelnyxCallEventBasePayload {
  call_control_id: string;
  call_leg_id?: string;
  call_session_id?: string;
  /** Base64-encoded; written by us in /calls/trigger or new web call. */
  client_state?: string | null;
  from?: string;
  to?: string;
}

export interface TelnyxCallInitiatedPayload extends TelnyxCallEventBasePayload {
  direction?: 'incoming' | 'outgoing';
  start_time?: string;
}

export interface TelnyxCallAnsweredPayload extends TelnyxCallEventBasePayload {
  start_time?: string;
}

export interface TelnyxCallHangupPayload extends TelnyxCallEventBasePayload {
  hangup_cause?: string;
  hangup_source?: string;
  end_time?: string;
  start_time?: string;
}

export interface TelnyxRecordingSavedPayload extends TelnyxCallEventBasePayload {
  recording_id: string;
  recording_started_at?: string;
  recording_ended_at?: string;
  duration_millis?: number;
  channels?: 'single' | 'dual';
  recording_urls?: {
    mp3?: string | null;
    wav?: string | null;
  };
  public_recording_urls?: {
    mp3?: string | null;
    wav?: string | null;
  };
}

export type TelnyxWebhookPayload =
  | TelnyxCallInitiatedPayload
  | TelnyxCallAnsweredPayload
  | TelnyxCallHangupPayload
  | TelnyxRecordingSavedPayload;

/** POST /v2/calls response envelope. */
export interface TelnyxCreateCallResponse {
  data: {
    call_control_id: string;
    call_leg_id?: string;
    call_session_id?: string;
    is_alive?: boolean;
  };
}

/** GET /v2/recordings/{id} response envelope. */
export interface TelnyxRecordingResponse {
  data: {
    id: string;
    duration_millis?: number;
    recording_started_at?: string;
    recording_ended_at?: string;
    status?: string;
    channels?: 'single' | 'dual';
    download_urls?: {
      mp3?: string | null;
      wav?: string | null;
    };
  };
}

/** POST /v2/telephony_credentials/{id}/token response — a raw JWT string. */
export type TelnyxLoginTokenResponse = string;

/**
 * Twilio-compatible TeXML status callback payload (application/x-www-form-urlencoded).
 * Delivered to the TeXML application's `status_callback` URL — distinct from
 * Voice API webhooks which use the JSON `TelnyxWebhookEnvelope` envelope above.
 * Field names are PascalCase to match Telnyx-on-the-wire.
 */
export interface TelnyxTexmlStatusPayload {
  CallSid: string;
  CallStatus:
    | 'initiated'
    | 'ringing'
    | 'answered'
    | 'in-progress'
    | 'completed'
    | 'busy'
    | 'failed'
    | 'no-answer'
    | 'canceled';
  From?: string;
  To?: string;
  Direction?: 'inbound' | 'outbound-api' | 'outbound-dial';
  Caller?: string;
  CallDuration?: string;
  Timestamp?: string;
  AccountSid?: string;
  ApplicationSid?: string;
}

/**
 * Helper for our own client_state bridge token. We pack it into the call so
 * the dashboard can resolve a web-initiated call's bridgeUuid back to the
 * canonical call_control_id once the call.initiated webhook fires.
 */
export interface TelnyxClientStatePayload {
  bridgeUuid?: string;
  product_id?: string;
  trigger_reason?: string;
  call_mode?: string;
  [key: string]: unknown;
}
