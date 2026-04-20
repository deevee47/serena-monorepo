export interface VapiCallInfo {
  id: string;
  phoneNumber?: { number?: string; nationalNumber?: string };
  assistantId?: string;
  createdAt?: string;
  endedReason?: string;
  duration?: number;
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
