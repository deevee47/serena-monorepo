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
};

export type GenerateResponseResponse = {
  text: string;
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

async function classifyFn(req: ClassifyObjectionRequest): Promise<ClassifyObjectionResponse> {
  const start = Date.now();
  try {
    const result = await client.post('classify', { json: req }).json<ClassifyObjectionResponse>();
    logger.debug({ call_id: req.call_id, endpoint: 'classify', duration_ms: Date.now() - start }, 'Brain call');
    return result;
  } catch (err) {
    logger.error({ call_id: req.call_id, err }, 'Brain classify error');
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on classify');
    }
    throw new AppError(503, ErrorCodes.BRAIN_UNREACHABLE, 'Brain unreachable on classify');
  }
}

async function generateFn(req: GenerateResponseRequest): Promise<GenerateResponseResponse> {
  const start = Date.now();
  try {
    const result = await client.post('generate', { json: req }).json<GenerateResponseResponse>();
    logger.debug({ call_id: req.call_id, endpoint: 'generate', duration_ms: Date.now() - start }, 'Brain call');
    return result;
  } catch (err) {
    logger.error({ call_id: req.call_id, err }, 'Brain generate error');
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AppError(504, ErrorCodes.BRAIN_TIMEOUT, 'Brain timeout on generate');
    }
    throw new AppError(503, ErrorCodes.BRAIN_UNREACHABLE, 'Brain unreachable on generate');
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
