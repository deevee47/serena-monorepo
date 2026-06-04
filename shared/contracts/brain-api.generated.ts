// AUTO-GENERATED FROM fastapi-brain/app/models/{requests,responses}.py
// Do not edit by hand — run `bun run gen:types` (or
// `python3 scripts/gen-brain-types.py`) to regenerate.

export enum ConversationStage {
  INTRO = 'INTRO',
  PITCH = 'PITCH',
  OBJECTION = 'OBJECTION',
  NEGOTIATION = 'NEGOTIATION',
  CLOSE = 'CLOSE',
  END = 'END',
}

export enum CustomerSegment {
  FIRST_TIME = 'FIRST_TIME',
  RETURNING = 'RETURNING',
  VIP = 'VIP',
  LAPSED = 'LAPSED',
}

export enum ObjectionType {
  PRICE = 'PRICE',
  TRUST = 'TRUST',
  CONFUSION = 'CONFUSION',
  TIMING = 'TIMING',
  POSITIVE_SIGNAL = 'POSITIVE_SIGNAL',
  NEUTRAL = 'NEUTRAL',
}

export enum Sentiment {
  POSITIVE = 'POSITIVE',
  NEGATIVE = 'NEGATIVE',
  NEUTRAL = 'NEUTRAL',
}

export interface AlternativesRequest {
  query: string;
  exclude_id: string;
  current_price?: number | null;
  top_k?: number;
  category?: string | null;
  direction?: string;
}

// The customer's cart at the moment the agent picked up the call.
export interface CartContext {
  items: CartItem[];
  total: number;
  abandoned_minutes_ago?: number | null;
}

// A line item in the customer's abandoned cart.
export interface CartItem {
  product_id: string;
  name: string;
  price: number;
  quantity?: number;
}

export interface ClassifyObjectionRequest {
  call_id: string;
  utterance: string;
  stage: ConversationStage;
  score: number;
}

export interface ConversationTurn {
  speaker: string;
  utterance: string;
  timestamp: string;
}

// Single-call function-calling LLM converse request. The LLM gets the
// conversation history, the product/cart/customer facts, and the tool
// schemas — it decides whether to talk, call a tool, or both.
export interface ConverseRequest {
  call_id: string;
  utterance: string;
  conversation_history?: ConversationTurn[];
  product_context?: ProductContext | null;
  alternative_product_context?: ProductContext | null;
  premium_product_context?: ProductContext | null;
  cart_context?: CartContext | null;
  customer_context?: CustomerContext | null;
  recent_user_signals?: RecentUserSignals | null;
  discounts_already_offered?: number[];
  agent_name?: string;
  business_name?: string;
  opening_offer_percent?: number;
}

// Everything the agent should know about who it's talking to before
// saying anything. Sourced from the Customer + Purchase + Call tables.
// 
// All fields except phone are optional — first-time unknown callers will
// have only phone populated, and the prompt builder degrades gracefully.
export interface CustomerContext {
  phone: string;
  name?: string | null;
  email?: string | null;
  segment?: CustomerSegment;
  lifetime_value?: number;
  prior_calls_count?: number;
  timezone?: string | null;
  preferred_contact?: string | null;
  past_orders?: PastOrderSummary[];
}

export interface PastOrderSummary {
  product_id: string;
  product_name: string;
  price: number;
  days_ago: number;
}

export interface ProductContext {
  product_id: string;
  name: string;
  price: number;
  description: string;
  key_features: string[];
}

// Small snapshot of recent USER-turn behavior the prompt can adapt to.
// 
// Sourced async (via the classify-analytics worker) on the gateway side and
// forwarded per turn. Missing values just degrade the signal — never block.
export interface RecentUserSignals {
  sentiments?: Sentiment[];
  filler_density?: number | null;
  length_trend?: number | null;
  repeated_objection?: string | null;
  push_attempt?: number | null;
  response_latency_ms?: number | null;
}

export interface AlternativesResponse {
  alternatives: ProductContext[];
}

export interface ClassifyObjectionResponse {
  objection_type: ObjectionType;
  confidence: number;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  subtype?: string | null;
}

// Non-streaming converse result. The LLM may have spoken, called a tool,
// or both. Streaming clients should use POST /converse/stream instead.
export interface ConverseResponse {
  text: string;
  tool_call?: ConverseToolCall | null;
  finish_reason?: string | null;
}

export interface ConverseToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Plain-text response. Used by both legacy /generate (until removed)
// and the converse blocking endpoint when the LLM emits no tool call.
export interface GenerateResponseResponse {
  text: string;
}
