/**
 * Brain HTTP client. Three endpoints under the converse pipeline:
 *   - /classify (analytics-only — runs async via the analytics queue)
 *   - /converse + /converse/stream (single LLM call per turn with tools)
 *   - /products/alternatives (Pinecone semantic search)
 */

import got from 'got';
import CircuitBreaker from 'opossum';
import { config } from '../config/env.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ConversationStage, ObjectionType } from '../types/session.types.js';
import type { ProductContext } from './product.service.js';

// These types mirror shared/contracts/brain-api.types.ts — keep in sync.

export type BrainConversationTurn = {
  speaker: 'USER' | 'AGENT';
  utterance: string;
  timestamp: string; // ISO 8601
};

export type ClassifyObjectionRequest = {
  call_id: string;
  utterance: string;
  stage: ConversationStage;
  score: number;
};

export type ClassifyObjectionResponse = {
  objection_type: ObjectionType;
  confidence: number;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  subtype?: string | null;
};

export type CartItemPayload = {
  product_id: string;
  name: string;
  price: number;
  quantity?: number;
};

export type CartContextPayload = {
  items: CartItemPayload[];
  total: number;
  abandoned_minutes_ago?: number | null;
};

export type CustomerSegment = 'FIRST_TIME' | 'RETURNING' | 'VIP' | 'LAPSED';

export type PastOrderSummaryPayload = {
  product_id: string;
  product_name: string;
  price: number;
  days_ago: number;
};

export type CustomerContextPayload = {
  phone: string;
  name?: string | null;
  email?: string | null;
  segment?: CustomerSegment;
  lifetime_value?: number;
  prior_calls_count?: number;
  timezone?: string | null;
  preferred_contact?: string | null;
  past_orders?: PastOrderSummaryPayload[];
};

export type RecentUserSignalsPayload = {
  sentiments: ('POSITIVE' | 'NEGATIVE' | 'NEUTRAL')[];
  filler_density?: number | null;
  length_trend?: number | null;
  repeated_objection?: string | null;
};

export type ToolName = 'send_whatsapp_checkout_link' | 'send_whatsapp_product_info';

export type ConverseToolCall = {
  name: ToolName;
  args: Record<string, unknown>;
};

export type ConverseRequest = {
  call_id: string;
  utterance: string;
  conversation_history?: BrainConversationTurn[];
  product_context?: ProductContext | null;
  alternative_product_context?: ProductContext | null;
  premium_product_context?: ProductContext | null;
  cart_context?: CartContextPayload | null;
  customer_context?: CustomerContextPayload | null;
  recent_user_signals?: RecentUserSignalsPayload | null;
  discounts_already_offered?: number[];
};

export type ConverseResponse = {
  text: string;
  tool_call?: ConverseToolCall | null;
  finish_reason?: string | null;
};

export type ConverseStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; tool: string }
  | { type: 'observation'; name: string; args: Record<string, unknown>; result: Record<string, unknown> }
  | { type: 'tool_call'; name: ToolName; args: Record<string, unknown> }
  | { type: 'done'; finish_reason?: string | null };

export type AlternativesRequest = {
  query: string;
  exclude_id: string;
  current_price?: number;
  top_k?: number;
  category?: string;
  direction?: 'cheaper' | 'premium';
};

export type AlternativesResponse = {
  alternatives: ProductContext[];
};

const client = got.extend({
  prefixUrl: config.FASTAPI_BRAIN_URL,
  headers: { 'X-Internal-Secret': config.INTERNAL_SERVICE_SECRET },
});

function getBrainErrorDetails(err: unknown): {
  statusCode?: number;
  message: string;
  details?: unknown;
} {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return { statusCode: 504, message: 'Brain request timed out' };
  }
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const response = (err as { response?: { statusCode?: number; body?: unknown } })
      .response;
    const body = response?.body;
    const brainMessage =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { message?: string } }).error?.message
        : undefined;
    return {
      statusCode: response?.statusCode,
      message:
        brainMessage ?? (err instanceof Error ? err.message : 'Brain request failed'),
      details: body,
    };
  }
  return { message: err instanceof Error ? err.message : 'Brain request failed' };
}

// ─── /classify ─────────────────────────────────────────────────────────────

async function classifyFn(req: ClassifyObjectionRequest): Promise<ClassifyObjectionResponse> {
  const start = Date.now();
  try {
    const result = await client.post('classify', { json: req }).json<ClassifyObjectionResponse>();
    logger.debug(
      { call_id: req.call_id, endpoint: 'classify', duration_ms: Date.now() - start },
      'Brain call',
    );
    return result;
  } catch (err) {
    const details = getBrainErrorDetails(err);
    logger.error({ call_id: req.call_id, err, brain_error: details }, 'Brain classify error');
    if (details.statusCode === 504) {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on classify', details.details);
    }
    throw new AppError(
      details.statusCode ?? 503,
      ErrorCodes.BRAIN_UNREACHABLE,
      details.message,
      details.details,
    );
  }
}

const classifyBreaker = new CircuitBreaker(classifyFn, {
  timeout: 8000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
});
classifyBreaker.fallback(() => ({
  objection_type: 'NEUTRAL' as ObjectionType,
  sentiment: 'NEUTRAL' as const,
  confidence: 0.0,
  subtype: null,
}));

export async function classifyObjection(
  req: ClassifyObjectionRequest,
): Promise<ClassifyObjectionResponse> {
  return classifyBreaker.fire(req) as Promise<ClassifyObjectionResponse>;
}

// ─── /converse ─────────────────────────────────────────────────────────────

async function converseFn(req: ConverseRequest): Promise<ConverseResponse> {
  const start = Date.now();
  try {
    const result = await client.post('converse', { json: req }).json<ConverseResponse>();
    logger.debug(
      { call_id: req.call_id, endpoint: 'converse', duration_ms: Date.now() - start },
      'Brain call',
    );
    return result;
  } catch (err) {
    const details = getBrainErrorDetails(err);
    logger.error({ call_id: req.call_id, err, brain_error: details }, 'Brain converse error');
    if (details.statusCode === 504) {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on converse', details.details);
    }
    throw new AppError(
      details.statusCode ?? 503,
      ErrorCodes.BRAIN_UNREACHABLE,
      details.message,
      details.details,
    );
  }
}

const converseBreaker = new CircuitBreaker(converseFn, {
  timeout: 12000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
});
// CRITICAL: fallback returns text-only with no tool_call. We must NEVER
// synthesize a tool call from a fallback — that could fire a real WhatsApp
// send with garbage args during a brain outage.
converseBreaker.fallback(
  (): ConverseResponse => ({
    text: 'Give me just a moment.',
    tool_call: null,
    finish_reason: 'fallback',
  }),
);

export async function converse(req: ConverseRequest): Promise<ConverseResponse> {
  return converseBreaker.fire(req) as Promise<ConverseResponse>;
}

/**
 * SSE-streaming variant. The brain emits typed events `{type, ...}`. The
 * caller gets a callback per text delta (for Vapi /say firing), an optional
 * callback for `thinking` events (observation-tool pre-roll), and an
 * optional finalized tool_call. Returns the assembled text and tool_call.
 *
 * On error, falls back to `converse()` for a non-streaming retry, then to
 * a generic text reply if that also fails. NEVER synthesizes a tool_call.
 */
export interface ConverseStreamCallbacks {
  onTextDelta: (delta: string) => void;
  /** Fired right before an observation tool is awaited server-side. The
   *  gateway uses this to fill the dead-air gap with a thinking-aloud filler
   *  ("ek minute, dekh ke batati hoon —"). */
  onThinking?: (toolName: string) => void;
}

export async function converseStream(
  req: ConverseRequest,
  callbacks: ((delta: string) => void) | ConverseStreamCallbacks,
): Promise<{ text: string; tool_call: ConverseToolCall | null; finish_reason: string | null }> {
  // Backwards-compat: callers passing a bare callback get treated as onTextDelta.
  const cb: ConverseStreamCallbacks =
    typeof callbacks === 'function' ? { onTextDelta: callbacks } : callbacks;
  const buffer: string[] = [];
  let toolCall: ConverseToolCall | null = null;
  let finishReason: string | null = null;

  try {
    const response = await fetch(`${config.FASTAPI_BRAIN_URL}/converse/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.INTERNAL_SERVICE_SECRET,
        'X-Call-ID': req.call_id,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok || !response.body) {
      throw new Error(`converse stream request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        let event: ConverseStreamEvent;
        try {
          event = JSON.parse(raw) as ConverseStreamEvent;
        } catch {
          continue;
        }
        if (event.type === 'text') {
          buffer.push(event.delta);
          cb.onTextDelta(event.delta);
        } else if (event.type === 'thinking') {
          cb.onThinking?.(event.tool);
        } else if (event.type === 'tool_call') {
          toolCall = { name: event.name, args: event.args };
        } else if (event.type === 'done') {
          finishReason = event.finish_reason ?? null;
        }
        // 'observation' events are info-only for the gateway (the brain
        // already fed the result back into the LLM). We don't act on them.
      }
    }

    return {
      text: buffer.join('').trim(),
      tool_call: toolCall,
      finish_reason: finishReason,
    };
  } catch (err) {
    logger.error(
      { call_id: req.call_id, err },
      'converseStream failed — falling back to non-streaming converse',
    );
    const partialText = buffer.join('').trim();
    if (partialText || toolCall) {
      return { text: partialText, tool_call: toolCall, finish_reason: 'stream_error' };
    }
    const result = await converse(req).catch(
      (): ConverseResponse => ({
        text: 'Give me just a moment.',
        tool_call: null,
        finish_reason: 'fallback',
      }),
    );
    return {
      text: result.text,
      tool_call: result.tool_call ?? null,
      finish_reason: result.finish_reason ?? 'fallback',
    };
  }
}

// ─── /products/alternatives ────────────────────────────────────────────────

async function alternativesFn(req: AlternativesRequest): Promise<AlternativesResponse> {
  const start = Date.now();
  try {
    const result = await client
      .post('products/alternatives', { json: req })
      .json<AlternativesResponse>();
    logger.debug(
      { endpoint: 'products/alternatives', duration_ms: Date.now() - start },
      'Brain call',
    );
    return result;
  } catch (err) {
    logger.error({ err }, 'Brain alternatives error');
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on alternatives');
    }
    throw new AppError(503, ErrorCodes.BRAIN_UNREACHABLE, 'Brain unreachable on alternatives');
  }
}

const alternativesBreaker = new CircuitBreaker(alternativesFn, {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
});
alternativesBreaker.fallback(() => ({ alternatives: [] }));

export async function findProductAlternatives(
  req: AlternativesRequest,
): Promise<AlternativesResponse> {
  return alternativesBreaker.fire(req) as Promise<AlternativesResponse>;
}
