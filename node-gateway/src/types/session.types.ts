// ObjectionType and ConversationStage mirror shared/contracts/brain-api.types.ts — keep in sync
export const ObjectionType = {
  PRICE: 'PRICE',
  TRUST: 'TRUST',
  CONFUSION: 'CONFUSION',
  TIMING: 'TIMING',
  POSITIVE_SIGNAL: 'POSITIVE_SIGNAL',
  NEUTRAL: 'NEUTRAL',
} as const;
export type ObjectionType = (typeof ObjectionType)[keyof typeof ObjectionType];

export const ConversationStage = {
  INTRO: 'INTRO',
  PITCH: 'PITCH',
  OBJECTION: 'OBJECTION',
  NEGOTIATION: 'NEGOTIATION',
  CLOSE: 'CLOSE',
  END: 'END',
} as const;
export type ConversationStage = (typeof ConversationStage)[keyof typeof ConversationStage];

export interface ConversationTurn {
  speaker: 'USER' | 'AGENT';
  utterance: string;
  timestamp: Date;
  objectionType?: ObjectionType;
}

export interface CallSession {
  callId: string;
  phoneNumber: string;
  productId: string;
  stage: ConversationStage;
  score: number;
  discountsOffered: number[];
  /**
   * Explicit persistence counter, incremented by turn-persist when the AGENT
   * turn we just persisted brought NEW persuasion (a tool, a new lever, a
   * discount escalation) in response to a soft-no signal. Resets to 0 when
   * the checkout tool fires or when the user's most recent sentiment is
   * POSITIVE. Capped at 5 — past five the prompt instructs a graceful exit.
   * Mirrored on each AGENT CallTurn row as `push_attempt`.
   */
  pushAttempt: number;
  objectionsEncountered: ObjectionType[];
  conversationHistory: ConversationTurn[];
  turnCount: number;
  currentProductId: string;
  closeAttempted: boolean;
  followUpRequested: boolean;
  followUpNote: string | null;
  /**
   * Estimated TTS-finished timestamp for the most recent AGENT turn — the
   * FALLBACK latency anchor when the provider doesn't deliver speech-boundary
   * events. null on the very first turn.
   */
  lastAgentFinishedAt: string | null;
  /**
   * Provider-measured turn-taking, set from `speech.boundary` webhooks:
   *  - `agentSpeechEndedAtMs`: epoch-ms the agent actually stopped speaking
   *    (set on assistant-stopped; consumed by the next user-started).
   *  - `pendingResponseLatencyMs`: accurate think-time (user-started −
   *    agent-stopped) awaiting attachment to the next USER turn. Preferred over
   *    the estimate; cleared once consumed.
   */
  agentSpeechEndedAtMs: number | null;
  pendingResponseLatencyMs: number | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  isActive: boolean;
}

export interface SessionCreateInput {
  callId: string;
  phoneNumber: string;
  productId: string;
}
