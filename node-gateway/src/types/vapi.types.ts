export interface VapiCallInfo {
  id: string;
  phoneNumber?: { number?: string; nationalNumber?: string };
  assistantId?: string;
  createdAt?: string;
  endedReason?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface VapiAssistantRequestEvent {
  message: {
    type: 'assistant-request';
    timestamp?: number;
    call: VapiCallInfo;
  };
}

export interface VapiTranscriptEvent {
  message: {
    type: 'transcript';
    timestamp?: number;
    call: VapiCallInfo;
    role: 'user' | 'assistant';
    transcriptType: 'partial' | 'final';
    transcript: string;
  };
}

export interface VapiStatusUpdateEvent {
  message: {
    type: 'status-update';
    timestamp?: number;
    call: VapiCallInfo;
    status: 'started' | 'ended' | 'ringing' | 'in-progress';
  };
}

export interface VapiEndOfCallReportEvent {
  message: {
    type: 'end-of-call-report';
    timestamp?: number;
    call: VapiCallInfo;
    endedReason?: string;
    durationSeconds?: number;
    summary?: string;
    analysis?: {
      summary?: string;
      successEvaluation?: string;
    };
  };
}

export interface VapiHangEvent {
  message: {
    type: 'hang';
    timestamp?: number;
    call: VapiCallInfo;
  };
}

export interface VapiSpeechUpdateEvent {
  message: {
    type: 'speech-update';
    timestamp?: number;
    call: VapiCallInfo;
    status: 'started' | 'stopped';
    role: 'user' | 'assistant';
  };
}

export interface VapiConversationUpdateEvent {
  message: {
    type: 'conversation-update';
    timestamp?: number;
    call: VapiCallInfo;
    conversation: Array<{ role: string; content: string }>;
  };
}

export type VapiWebhookEvent =
  | VapiAssistantRequestEvent
  | VapiTranscriptEvent
  | VapiStatusUpdateEvent
  | VapiEndOfCallReportEvent
  | VapiHangEvent
  | VapiSpeechUpdateEvent
  | VapiConversationUpdateEvent;

export interface VapiAssistantConfig {
  assistantId?: string;
  assistant?: {
    firstMessage?: string;
    model?: {
      provider: string;
      model: string;
      messages?: Array<{ role: string; content: string }>;
    };
    voice?: {
      provider: string;
      voiceId: string;
    };
  };
}

/**
 * Per-call overrides Vapi accepts on POST /call/phone alongside `assistantId`.
 * Only the fields we actually set are typed — Vapi accepts many more.
 *
 * https://docs.vapi.ai/api-reference/calls/create — see the assistantOverrides
 * shape under `Assistant` (most fields mirror the assistant's persistent config).
 */
export interface VapiAssistantOverrides {
  /** Custom LLM endpoint Vapi calls instead of OpenAI. */
  model?: {
    provider: 'custom-llm';
    url: string;
    model?: string;
    /** Vapi attaches this header to every Custom-LLM POST. */
    authorization?: string;
  };
  voice?: {
    provider: string;
    voiceId: string;
  };
  /** Hang up if the customer has been silent for this many seconds. Sales
   *  pace prefers 12s; Vapi default is 30s. */
  silenceTimeoutSeconds?: number;
  /** Time the assistant waits before responding once the customer stops
   *  speaking. Lower = snappier; too low = it cuts the customer off. */
  responseDelaySeconds?: number;
  /** How many words of customer speech triggers a barge-in. 2 keeps it
   *  feeling like a real conversation; default ~3-4 is too tolerant. */
  numWordsToInterruptAssistant?: number;
  /** "mhm", "yeah", "got it" — backchanneled by Vapi while the customer
   *  is mid-sentence. Makes the agent feel attentive. */
  backchannelingEnabled?: boolean;
  /** Phrases that, when the customer says them, end the call cleanly. */
  endCallPhrases?: string[];
}
