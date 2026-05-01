// Wire types between node-gateway and fastapi-brain. Keep in sync with
// fastapi-brain/app/models/{requests,responses}.py.

export enum ObjectionType {
  PRICE = 'PRICE',
  TRUST = 'TRUST',
  CONFUSION = 'CONFUSION',
  TIMING = 'TIMING',
  POSITIVE_SIGNAL = 'POSITIVE_SIGNAL',
  NEUTRAL = 'NEUTRAL',
}

export enum ConversationStage {
  INTRO = 'INTRO',
  PITCH = 'PITCH',
  OBJECTION = 'OBJECTION',
  NEGOTIATION = 'NEGOTIATION',
  CLOSE = 'CLOSE',
  END = 'END',
}

export interface ConversationTurn {
  speaker: 'USER' | 'AGENT';
  utterance: string;
  timestamp: string; // ISO 8601
}

export interface ProductContext {
  product_id: string;
  name: string;
  price: number;
  description: string;
  key_features: string[];
}

export interface CartItem {
  product_id: string;
  name: string;
  price: number;
  quantity?: number;
}

export interface CartContext {
  items: CartItem[];
  total: number;
  abandoned_minutes_ago?: number | null;
}

// ─── /classify (analytics-only under converse pipeline) ────────────────────

export interface ClassifyObjectionRequest {
  call_id: string;
  utterance: string;
  stage: ConversationStage;
  score: number;
}

export interface ClassifyObjectionResponse {
  objection_type: ObjectionType;
  confidence: number; // 0.0 – 1.0
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  subtype?: string | null;
}

// ─── /converse (function-calling LLM) ──────────────────────────────────────
// Single LLM call per turn. Replaces the rules-engine + tactic + speech-prompt
// pipeline. The model decides whether to talk, call a tool, or both.

export type ToolName = 'send_whatsapp_checkout_link' | 'send_whatsapp_product_info';

export interface ConverseToolCall {
  name: ToolName;
  // Args are tool-specific. send_whatsapp_checkout_link accepts
  // { discount_percent: 0-10 }. send_whatsapp_product_info accepts no args.
  args: Record<string, unknown>;
}

export interface ConverseRequest {
  call_id: string;
  utterance: string;
  conversation_history?: ConversationTurn[];
  product_context?: ProductContext | null;
  alternative_product_context?: ProductContext | null;
  cart_context?: CartContext | null;
  // The discount tiers offered earlier in this call, e.g. [] | [5] | [5, 10].
  discounts_already_offered?: number[];
}

export interface ConverseResponse {
  text: string; // may be empty when the LLM only emits a tool call
  tool_call?: ConverseToolCall | null;
  finish_reason?: string | null;
}

// SSE event shapes returned by POST /converse/stream.
export type ConverseStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: ToolName; args: Record<string, unknown> }
  | { type: 'done'; finish_reason?: string | null };

// ─── /products/alternatives ────────────────────────────────────────────────

export interface AlternativesRequest {
  query: string;
  exclude_id: string;
  current_price?: number;
  top_k?: number;
}

export interface AlternativesResponse {
  alternatives: ProductContext[];
}
