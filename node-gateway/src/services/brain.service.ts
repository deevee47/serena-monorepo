import got from 'got';
import CircuitBreaker from 'opossum';
import { config } from '../config/env.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ObjectionType, ConversationStage } from '../types/session.types.js';
import type { ProductContext } from './product.service.js';

// These interfaces mirror shared/contracts/brain-api.types.ts — keep in sync
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
  // B-2: fine-grained subtype, populated by the Pinecone classifier path.
  // null on LLM fallback. Examples: 'too_expensive', 'found_cheaper', etc.
  subtype?: string | null;
};

export type GenerateResponseRequest = {
  call_id: string;
  utterance: string;
  stage: ConversationStage;
  score: number;
  discount_available: number;
  objection_type: ObjectionType | null;
  conversation_history: BrainConversationTurn[];
  product_context: ProductContext | null;
  alternative_product_context?: ProductContext | null;
};

export type GenerateResponseResponse = {
  text: string;
};

// ─── Tactic-driven pipeline (Decision + Speech) ────────────────────────────
// Mirrors shared/contracts/brain-api.types.ts.

export type Tactic =
  | 'ASK_OPEN'
  | 'ASK_DISQUALIFY'
  | 'MIRROR'
  | 'ISOLATE'
  | 'REFRAME'
  | 'CONCESSION_REAL'
  | 'CONCESSION_NON_MONETARY'
  | 'ALTERNATIVE_PIVOT'
  | 'PERMISSION_PUSH'
  | 'TIME_CAPTURE'
  | 'TRIAL_CLOSE'
  | 'ASSUMPTIVE_CLOSE'
  | 'GRACEFUL_EXIT';

export type DecideRequest = {
  call_id: string;
  objection_type: ObjectionType | null;
  objection_subtype?: string | null;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null;
  stage: ConversationStage;
  score: number;
  turn_count: number;
  prior_objection_types: ObjectionType[];
  discounts_offered: number[];
  has_alternative_product: boolean;
};

export type DecideResponse = {
  tactic: Tactic;
  reasoning: string;
  micro_guidance: string;
};

export type GenerateTacticRequest = {
  call_id: string;
  utterance: string;
  tactic: Tactic;
  micro_guidance: string;
  conversation_history?: BrainConversationTurn[];
  product_context?: ProductContext | null;
  alternative_product_context?: ProductContext | null;
  discount_available?: number;
};

export type AlternativesRequest = {
  query: string;
  exclude_id: string;
  current_price?: number;
  top_k?: number;
};

export type AlternativesResponse = {
  alternatives: ProductContext[];
};

export const FALLBACK_RESPONSES: Record<ConversationStage, string> = {
  INTRO: 'Give me just a moment.',
  PITCH: 'Let me think about the best way to explain this.',
  OBJECTION: "That's a great point — could you say a bit more about that?",
  NEGOTIATION: 'I want to make sure I get this right for you.',
  CLOSE: 'Could you give me just a second?',
  END: 'Thank you so much for your time today.',
};

const client = got.extend({
  prefixUrl: config.FASTAPI_BRAIN_URL,
  headers: { 'X-Internal-Secret': config.INTERNAL_SERVICE_SECRET },
});

function getBrainErrorDetails(err: unknown): { statusCode?: number; message: string; details?: unknown } {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return { statusCode: 504, message: 'Brain request timed out' };
  }

  if (typeof err === 'object' && err !== null && 'response' in err) {
    const response = (err as {
      response?: {
        statusCode?: number;
        body?: unknown;
      };
    }).response;
    const body = response?.body;
    const brainMessage =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { message?: string } }).error?.message
        : undefined;

    return {
      statusCode: response?.statusCode,
      message: brainMessage ?? (err instanceof Error ? err.message : 'Brain request failed'),
      details: body,
    };
  }

  return {
    message: err instanceof Error ? err.message : 'Brain request failed',
  };
}

async function classifyFn(req: ClassifyObjectionRequest): Promise<ClassifyObjectionResponse> {
  const start = Date.now();
  try {
    const result = await client.post('classify', { json: req }).json<ClassifyObjectionResponse>();
    logger.debug({ call_id: req.call_id, endpoint: 'classify', duration_ms: Date.now() - start }, 'Brain call');
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

async function generateFn(req: GenerateResponseRequest): Promise<GenerateResponseResponse> {
  const start = Date.now();
  try {
    const result = await client.post('generate', { json: req }).json<GenerateResponseResponse>();
    logger.debug({ call_id: req.call_id, endpoint: 'generate', duration_ms: Date.now() - start }, 'Brain call');
    return result;
  } catch (err) {
    const details = getBrainErrorDetails(err);
    logger.error({ call_id: req.call_id, err, brain_error: details }, 'Brain generate error');
    if (details.statusCode === 504) {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on generate', details.details);
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

const generateBreaker = new CircuitBreaker(generateFn, {
  timeout: 12000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
});
generateBreaker.fallback((req: GenerateResponseRequest) => ({
  text: FALLBACK_RESPONSES[req.stage] ?? 'Give me just a moment.',
}));

export async function classifyObjection(req: ClassifyObjectionRequest): Promise<ClassifyObjectionResponse> {
  return classifyBreaker.fire(req) as Promise<ClassifyObjectionResponse>;
}

export async function generateResponse(req: GenerateResponseRequest): Promise<GenerateResponseResponse> {
  return generateBreaker.fire(req) as Promise<GenerateResponseResponse>;
}

// ─── /decide ──────────────────────────────────────────────────────────────
async function decideFn(req: DecideRequest): Promise<DecideResponse> {
  const start = Date.now();
  try {
    const result = await client.post('decide', { json: req }).json<DecideResponse>();
    logger.debug({ call_id: req.call_id, endpoint: 'decide', duration_ms: Date.now() - start }, 'Brain call');
    return result;
  } catch (err) {
    const details = getBrainErrorDetails(err);
    logger.error({ call_id: req.call_id, err, brain_error: details }, 'Brain decide error');
    if (details.statusCode === 504) {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on decide', details.details);
    }
    throw new AppError(
      details.statusCode ?? 503,
      ErrorCodes.BRAIN_UNREACHABLE,
      details.message,
      details.details,
    );
  }
}

const decideBreaker = new CircuitBreaker(decideFn, {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
});
// Fallback when /decide is unavailable: pick a safe default tactic. ASK_OPEN
// is the lowest-risk choice — surfaces information without committing to a
// stance. Includes minimal micro-guidance so the speech prompt still works.
decideBreaker.fallback(
  (): DecideResponse => ({
    tactic: 'ASK_OPEN',
    reasoning: 'decide endpoint unavailable — safe fallback to deepen understanding',
    micro_guidance:
      'Ask one open question to find out what they care about. Stop after the question.',
  }),
);

export async function decide(req: DecideRequest): Promise<DecideResponse> {
  return decideBreaker.fire(req) as Promise<DecideResponse>;
}

// ─── /generate-tactic ─────────────────────────────────────────────────────
async function generateTacticFn(req: GenerateTacticRequest): Promise<GenerateResponseResponse> {
  const start = Date.now();
  try {
    const result = await client.post('generate-tactic', { json: req }).json<GenerateResponseResponse>();
    logger.debug({ call_id: req.call_id, endpoint: 'generate-tactic', duration_ms: Date.now() - start }, 'Brain call');
    return result;
  } catch (err) {
    const details = getBrainErrorDetails(err);
    logger.error({ call_id: req.call_id, err, brain_error: details }, 'Brain generate-tactic error');
    if (details.statusCode === 504) {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on generate-tactic', details.details);
    }
    throw new AppError(
      details.statusCode ?? 503,
      ErrorCodes.BRAIN_UNREACHABLE,
      details.message,
      details.details,
    );
  }
}

const generateTacticBreaker = new CircuitBreaker(generateTacticFn, {
  timeout: 12000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
});
// No stage on this request — fall back to a generic "give me a moment" line.
generateTacticBreaker.fallback(
  (): GenerateResponseResponse => ({ text: 'Give me just a moment.' }),
);

export async function generateTactic(req: GenerateTacticRequest): Promise<GenerateResponseResponse> {
  return generateTacticBreaker.fire(req) as Promise<GenerateResponseResponse>;
}

// SSE streaming variant — same pattern as generateResponseStream so we can
// fire Vapi /say on the first chunk for low time-to-first-word.
export async function generateTacticStream(
  req: GenerateTacticRequest,
  onChunk: (text: string) => void,
): Promise<string> {
  const buffer: string[] = [];

  try {
    const response = await fetch(`${config.FASTAPI_BRAIN_URL}/generate-tactic/stream`, {
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
      throw new Error(`generate-tactic stream request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { finished = true; break; }
        try {
          const parsed = JSON.parse(data) as { text: string };
          buffer.push(parsed.text);
          onChunk(parsed.text);
        } catch {
          // ignore malformed SSE lines
        }
      }
    }

    return buffer.join('').trim() || 'Give me just a moment.';
  } catch (err) {
    logger.error({ call_id: req.call_id, err }, 'generateTacticStream failed — using buffered partial or non-streaming retry');
    const partial = buffer.join('').trim();
    if (partial) return partial;
    const result = await generateTactic(req).catch(() => ({ text: 'Give me just a moment.' }));
    return result.text;
  }
}

async function alternativesFn(req: AlternativesRequest): Promise<AlternativesResponse> {
  const start = Date.now();
  try {
    const result = await client
      .post('products/alternatives', { json: req })
      .json<AlternativesResponse>();
    logger.debug({ endpoint: 'products/alternatives', duration_ms: Date.now() - start }, 'Brain call');
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

export async function findProductAlternatives(req: AlternativesRequest): Promise<AlternativesResponse> {
  return alternativesBreaker.fire(req) as Promise<AlternativesResponse>;
}

export async function generateResponseStream(
  req: GenerateResponseRequest,
  onChunk: (text: string) => void,
): Promise<string> {
  const buffer: string[] = [];

  try {
    const response = await fetch(`${config.FASTAPI_BRAIN_URL}/generate/stream`, {
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
      throw new Error(`Stream request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { finished = true; break; }
        try {
          const parsed = JSON.parse(data) as { text: string };
          buffer.push(parsed.text);
          onChunk(parsed.text);
        } catch {
          // ignore malformed SSE lines
        }
      }
    }

    const fullText = buffer.join('').trim();
    return fullText || (FALLBACK_RESPONSES[req.stage] ?? 'Give me just a moment.');
  } catch (err) {
    logger.error({ call_id: req.call_id, err }, 'generateResponseStream failed — using buffered partial or fallback');
    const partial = buffer.join('').trim();
    if (partial) return partial;
    const result = await generateResponse(req).catch(() => ({
      text: FALLBACK_RESPONSES[req.stage] ?? 'Give me just a moment.',
    }));
    return result.text;
  }
}
