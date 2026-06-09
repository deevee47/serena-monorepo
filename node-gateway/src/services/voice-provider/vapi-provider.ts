import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import got from 'got';
import { config } from '../../config/env.js';
import type { VapiAssistantOverrides } from '../../types/vapi.types.js';
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

/** Sales pacing — beats Vapi defaults for our use case. Keep the endpointing
 *  config here in sync with the web path in
 *  `dashboard/src/components/talk-button-vapi.tsx` (web calls don't go through
 *  this adapter, so they can't share the object). */
export const ASSISTANT_PACING: Pick<
  VapiAssistantOverrides,
  | 'silenceTimeoutSeconds'
  | 'startSpeakingPlan'
  | 'numWordsToInterruptAssistant'
  | 'backchannelingEnabled'
  | 'endCallPhrases'
> = {
  silenceTimeoutSeconds: 12,
  // Smart endpointing instead of a fixed 0.4s silence timer: the old timer
  // cut customers off mid-thought on natural pauses, firing a fresh LLM turn
  // per fragment (and, worst case, double-firing the checkout tool). The ML
  // plan waits until the customer is actually done. `vapi` provider keeps it
  // working for Hindi/Hinglish (livekit is English-only).
  startSpeakingPlan: {
    waitSeconds: 0.8,
    smartEndpointingPlan: { provider: 'vapi' },
  },
  numWordsToInterruptAssistant: 2,
  backchannelingEnabled: true,
  endCallPhrases: ['bye', 'goodbye', 'thank you bye', 'alvida', 'rakhti hoon'],
};

function requireEnv<K extends keyof typeof config>(key: K): NonNullable<(typeof config)[K]> {
  const v = config[key];
  if (v === undefined || v === null || v === '') {
    throw new Error(`${String(key)} is required when VOICE_PROVIDER=vapi`);
  }
  return v as NonNullable<(typeof config)[K]>;
}

export class VapiProvider implements VoiceProvider {
  readonly name = 'vapi' as const;

  async createPhoneCall(params: CreatePhoneCallParams): Promise<CreatePhoneCallResult> {
    const voiceId = params.locale === 'hi' ? config.VAPI_VOICE_HI : config.VAPI_VOICE_EN;

    const overrides: VapiAssistantOverrides = { ...ASSISTANT_PACING };
    if (voiceId) {
      // Default provider — Vapi maps the ID through 11labs/playht/azure
      // depending on the assistant config; we let the assistant pick.
      overrides.voice = { provider: '11labs', voiceId };
    }
    if (config.VAPI_CUSTOM_LLM_URL) {
      overrides.model = {
        provider: 'custom-llm',
        url: config.VAPI_CUSTOM_LLM_URL,
        model: 'serena-converse',
        authorization: `Bearer ${requireEnv('VAPI_WEBHOOK_SECRET')}`,
      };
    }

    const vapiRes = await got
      .post('https://api.vapi.ai/call/phone', {
        headers: { Authorization: `Bearer ${requireEnv('VAPI_API_KEY')}` },
        json: {
          assistantId: requireEnv('VAPI_ASSISTANT_ID'),
          assistantOverrides: overrides,
          ...(config.VAPI_PHONE_NUMBER_ID
            ? { phoneNumberId: config.VAPI_PHONE_NUMBER_ID }
            : {}),
          customer: { number: params.phoneNumber },
          metadata: {
            product_id: params.productId,
            trigger_reason: params.triggerReason,
            ...params.metadata,
          },
        },
      })
      .json<{ id: string }>();

    return { callId: vapiRes.id, raw: vapiRes };
  }

  async getCall(callId: string): Promise<CallRecording> {
    const vapiCall = await got
      .get(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
        headers: { Authorization: `Bearer ${requireEnv('VAPI_API_KEY')}` },
      })
      .json<{ recordingUrl?: string | null; stereoRecordingUrl?: string | null }>();

    return {
      recordingUrl: vapiCall.recordingUrl ?? null,
      stereoRecordingUrl: vapiCall.stereoRecordingUrl ?? null,
      recordingId: null,
      raw: vapiCall,
    };
  }

  verifyWebhook(_rawBody: Buffer, headers: IncomingHttpHeaders): WebhookVerification {
    const authHeader = headers['authorization'] as string | undefined;
    const expected = `Bearer ${requireEnv('VAPI_WEBHOOK_SECRET')}`;
    const expBuf = Buffer.from(expected);
    const authBuf = Buffer.from(authHeader ?? '');
    const ok = authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
    return ok ? { ok: true } : { ok: false, reason: 'invalid_bearer_token' };
  }

  parseWebhook(_rawBody: Buffer, parsed: unknown): ParsedWebhook {
    const event = parsed as { message?: VapiMessageShape } | null;
    const msg = event?.message;
    if (!msg) return [];

    const callId = msg.call?.id;
    if (!callId) return [];

    switch (msg.type) {
      case 'assistant-request': {
        const metadata = (msg.call?.metadata ?? {}) as Record<string, unknown>;
        return [
          {
            kind: 'call.started',
            callId,
            phoneNumber: msg.call?.customer?.number ?? null,
            metadata,
            respondWithAssistantId: requireEnv('VAPI_ASSISTANT_ID'),
            raw: msg,
          },
        ];
      }

      case 'end-of-call-report': {
        const out: NormalizedVoiceEvent[] = [
          {
            kind: 'call.ended',
            callId,
            durationSeconds: msg.durationSeconds ?? null,
            endedReason: msg.endedReason ?? null,
            raw: msg,
          },
        ];
        if (msg.recordingUrl || msg.stereoRecordingUrl) {
          out.push({
            kind: 'recording.ready',
            callId,
            recordingUrl: msg.recordingUrl ?? null,
            stereoRecordingUrl: msg.stereoRecordingUrl ?? null,
            recordingId: null,
            raw: msg,
          });
        }
        return out;
      }

      case 'speech-update': {
        // Real turn-taking timestamps: agent stopped / user started speaking.
        // These anchor pre-response latency on provider-measured times.
        if (
          (msg.role === 'user' || msg.role === 'assistant') &&
          (msg.status === 'started' || msg.status === 'stopped')
        ) {
          return [
            {
              kind: 'speech.boundary',
              callId,
              role: msg.role,
              status: msg.status,
              atMs: typeof msg.timestamp === 'number' ? msg.timestamp : null,
              raw: msg,
            },
          ];
        }
        return [];
      }

      // `transcript` events are no-ops under Custom LLM; status-update is
      // logged elsewhere. They produce no normalized event.
      case 'transcript':
      case 'status-update':
      case 'hang':
      case 'conversation-update':
        return [];

      default:
        return [];
    }
  }

  parseLlmEnvelope(_headers: IncomingHttpHeaders, body: unknown): LlmRequestEnvelope {
    const b = body as {
      call?: { id?: string; customer?: { number?: string }; metadata?: Record<string, unknown> };
    } | null;
    return {
      callId: b?.call?.id ?? null,
      phoneNumber: b?.call?.customer?.number ?? null,
      metadata: b?.call?.metadata ?? {},
    };
  }

  verifyLlmAuth(headers: IncomingHttpHeaders): WebhookVerification {
    // Vapi attaches the same shared secret it uses for webhooks.
    return this.verifyWebhook(Buffer.alloc(0), headers);
  }

  async getWebClientConfig(): Promise<WebClientConfig> {
    return {
      provider: 'vapi',
      mode: 'public_key',
      token: requireEnv('VAPI_PUBLIC_KEY'),
      target: requireEnv('VAPI_ASSISTANT_ID'),
    };
  }
}

interface VapiMessageShape {
  type: string;
  call?: {
    id?: string;
    customer?: { number?: string };
    metadata?: Record<string, unknown>;
  };
  durationSeconds?: number;
  endedReason?: string;
  recordingUrl?: string | null;
  stereoRecordingUrl?: string | null;
  // speech-update fields
  timestamp?: number;
  status?: string;
  role?: string;
}
