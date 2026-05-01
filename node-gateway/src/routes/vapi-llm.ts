import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createCallLogger } from '../utils/logger.js';
import {
  createSession,
  getSession,
  updateSession,
  appendTurn,
  getRecentHistory,
} from '../services/session.service.js';
import {
  classifyObjection,
  generateResponse,
  FALLBACK_RESPONSES,
  type BrainConversationTurn,
} from '../services/brain.service.js';
import { calculateScoreAfterTurn } from '../services/scoring.service.js';
import { getNextStage } from '../services/stage.service.js';
import {
  shouldOfferDiscount,
  getAvailableDiscount,
  recordDiscountOffered,
  detectFollowUpRequest,
} from '../services/negotiation.service.js';
import {
  findAlternativeProduct,
  getProductById,
  toProductContext,
} from '../services/product.service.js';
import { insertCallTurn } from '../services/db.service.js';
import { ConversationStage, ObjectionType } from '../types/session.types.js';
import type { ClassifyObjectionResponse } from '../services/brain.service.js';

const bodySchema = z.object({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  call: z
    .object({
      id: z.string(),
      customer: z.object({ number: z.string().optional() }).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export default async function vapiLlmRoutes(app: FastifyInstance) {
  app.post('/vapi-llm/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ error: 'Invalid request body' });
    }

    const { messages, call } = parsed.data;
    const callId = call?.id ?? 'unknown';
    const phoneNumber = call?.customer?.number ?? 'unknown';
    const log = createCallLogger(callId);

    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const utterance = lastUserMsg?.content ?? '';

    let session = await getSession(callId);
    if (!session) {
      const productId = (call?.metadata?.['product_id'] as string | undefined) ?? 'prod-001';
      session = await createSession({ callId, phoneNumber, productId });
      log.info({ productId }, 'vapi-llm: session created');
    }

    // Classify
    let classify: ClassifyObjectionResponse = { objection_type: ObjectionType.NEUTRAL, sentiment: 'NEUTRAL', confidence: 0 };
    try {
      classify = await classifyObjection({ call_id: callId, utterance, stage: session.stage, score: session.score });
    } catch (err) {
      log.error({ err }, 'classify failed — using neutral fallback');
    }

    const newScore = calculateScoreAfterTurn(session, classify.objection_type, classify.sentiment);
    const updatedObjections = [...session.objectionsEncountered, classify.objection_type];

    await updateSession(callId, { score: newScore, objectionsEncountered: updatedObjections });
    const current = (await getSession(callId))!;
    const nextStage = getNextStage(current);

    const stageUpdates: Parameters<typeof updateSession>[1] = { stage: nextStage };
    if (nextStage === ConversationStage.CLOSE && !session.closeAttempted) stageUpdates.closeAttempted = true;

    let discountAmount = 0;
    const decisionSession = { ...current, stage: nextStage };
    if (shouldOfferDiscount(decisionSession)) {
      discountAmount = getAvailableDiscount(decisionSession);
      Object.assign(stageUpdates, recordDiscountOffered(decisionSession, discountAmount));
    }
    if (detectFollowUpRequest(utterance)) stageUpdates.followUpRequested = true;

    const product = getProductById(current.currentProductId);
    let alternativeProductContext = null;
    if (classify.objection_type === ObjectionType.PRICE && product) {
      try {
        alternativeProductContext = await findAlternativeProduct(current.currentProductId, 'PRICE');
        if (alternativeProductContext) {
          log.info(
            {
              current_product_id: current.currentProductId,
              alternative_product_id: alternativeProductContext.product_id,
            },
            'Alternative product loaded from Pinecone',
          );
        }
      } catch (err) {
        log.error({ err, current_product_id: current.currentProductId }, 'Failed to load alternative product');
      }
    }

    const rawHistory = await getRecentHistory(callId, 4);
    const history: BrainConversationTurn[] = rawHistory.map((t) => ({
      speaker: t.speaker,
      utterance: t.utterance,
      timestamp: t.timestamp.toISOString(),
    }));

    let generatedText: string;
    try {
      const res = await generateResponse({
        call_id: callId,
        utterance,
        stage: nextStage,
        score: newScore,
        discount_available: discountAmount,
        objection_type: classify.objection_type,
        conversation_history: history,
        product_context: product ? toProductContext(product) : null,
        alternative_product_context: alternativeProductContext,
      });
      generatedText = res.text;
    } catch (err) {
      log.error({ err }, 'generate failed — using fallback');
      generatedText = FALLBACK_RESPONSES[nextStage] ?? 'Give me just a moment.';
    }

    await updateSession(callId, stageUpdates);
    const now = new Date();
    await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now, objectionType: classify.objection_type });
    await appendTurn(callId, { speaker: 'AGENT', utterance: generatedText, timestamp: new Date() });

    const turnBase = { scoreBefore: session.score, scoreAfter: newScore, stage: nextStage };
    insertCallTurn(callId, { turnNumber: session.turnCount + 1, speaker: 'USER', utterance, objectionType: classify.objection_type, sentiment: classify.sentiment, discountOffered: discountAmount || undefined, ...turnBase }).catch((err) => log.error({ err }, 'DB insert failed'));
    insertCallTurn(callId, { turnNumber: session.turnCount + 2, speaker: 'AGENT', utterance: generatedText, ...turnBase }).catch((err) => log.error({ err }, 'DB insert failed'));

    log.info({ stage: nextStage, score: newScore, objection: classify.objection_type }, 'vapi-llm turn processed');

    // Stream response back in OpenAI SSE format
    const id = `chatcmpl-${Date.now()}`;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const writeChunk = (content: string) =>
      reply.raw.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'serena-agent', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
      );

    const words = generatedText.split(' ');
    for (let i = 0; i < words.length; i++) {
      writeChunk(i === 0 ? (words[i] ?? '') : ` ${words[i] ?? ''}`);
    }

    reply.raw.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'serena-agent', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });
}
