import { Worker } from 'bullmq';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import {
  updateCallRecord,
  updateCallTurnAnalytics,
  incrementCustomerCallsCount,
  getToolDispatchSummary,
} from './services/db.service.js';
import { deleteSession } from './services/session.service.js';
import { classifyObjection } from './services/brain.service.js';
import {
  redisConnection,
  callEndQueue,
  analyticsQueue,
  crmQueue,
  classifyAnalyticsQueue,
  insightsQueue,
  type CallEndJobData,
  type AnalyticsJobData,
  type CrmJobData,
  type ClassifyAnalyticsJobData,
  type InsightsJobData,
} from './queues/index.js';
import { ConversationStage } from './types/session.types.js';

logger.info('BullMQ workers starting');

const callEndWorker = new Worker<CallEndJobData>(
  'call-end-queue',
  async (job) => {
    const { callId, outcome, finalScore, discountGiven, stageReached, durationSeconds, phoneNumber } = job.data;
    const log = logger.child({ call_id: callId, job_id: job.id });

    await updateCallRecord(callId, {
      endedAt: new Date(),
      outcome,
      finalScore,
      discountGiven,
      stageReached,
      durationSeconds,
    });

    // Best-effort: bump the customer's prior_calls_count + summarize which
    // side-effect tools fired. Either failing should not crash the worker.
    let toolSummary: Record<string, number> = {};
    try {
      [, toolSummary] = await Promise.all([
        incrementCustomerCallsCount(phoneNumber),
        getToolDispatchSummary(callId),
      ]);
    } catch (err) {
      log.warn({ err }, 'priorCallsCount/toolSummary post-processing failed');
    }

    await deleteSession(callId);

    // Kick off insight generation eagerly. The brain is upsert-idempotent
    // on the CallInsight row, so this is safe even if the dashboard later
    // triggers a fallback generation when someone opens the call page.
    // Failing to enqueue is non-fatal: the dashboard's lazy-on-first-view
    // path is still wired as a safety net.
    await insightsQueue.add('insights', { callId }).catch((err) =>
      log.warn({ err }, 'failed to enqueue insights job (lazy fallback will cover)'),
    );

    log.info(
      {
        outcome,
        finalScore,
        tool_dispatch_summary: toolSummary,
        checkout_fired: (toolSummary['send_whatsapp_checkout_link'] ?? 0) > 0,
      },
      'call-end job complete',
    );
  },
  { connection: redisConnection },
);

/** Eager post-call insight generation. POSTs to the brain's `/insights/
 *  generate` endpoint; the brain handles the OpenAI call + DB upsert. We
 *  don't need to interpret the response — the dashboard polls the same
 *  row through `/api/calls/:id/insights`. BullMQ retries on non-2xx so
 *  transient OpenAI failures heal automatically. */
const insightsWorker = new Worker<InsightsJobData>(
  'insights-queue',
  async (job) => {
    const { callId } = job.data;
    const log = logger.child({ call_id: callId, job_id: job.id });
    const res = await fetch(`${config.FASTAPI_BRAIN_URL}/insights/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.INTERNAL_SERVICE_SECRET,
      },
      body: JSON.stringify({ call_id: callId, regenerate: false }),
      // OpenAI can take 5-15s on a long-ish transcript; give the call
      // plenty of headroom. The job-level timeout is BullMQ's default
      // (30s); if a generation blows past that, the retry will pick it up.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Throw to let BullMQ retry with exponential backoff. The brain may
      // be temporarily unreachable or rate-limited; later attempts heal it.
      throw new Error(`insights brain returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    log.info('insights generation requested');
  },
  { connection: redisConnection },
);

const analyticsWorker = new Worker<AnalyticsJobData>(
  'analytics-queue',
  async (job) => {
    const { callId, outcome, finalScore, discountGiven, stageReached, turnCount } = job.data;
    logger.info(
      { call_id: callId, outcome, finalScore, discountGiven, stageReached, turnCount },
      'analytics: call completed',
      // TODO: send to Mixpanel, Segment, or analytics pipeline
    );
  },
  { connection: redisConnection },
);

const crmWorker = new Worker<CrmJobData>(
  'crm-queue',
  async (job) => {
    const { callId, phoneNumber, outcome, discount, productId } = job.data;
    logger.info(
      { call_id: callId, phoneNumber, outcome, discount, productId },
      'crm: stub logged (production: call CRM API)',
      // TODO: call CRM API
    );
  },
  { connection: redisConnection },
);

// Fire-and-forget classification: under the converse pipeline, /classify
// no longer runs in the critical path. This worker picks up each USER turn
// after-the-fact and writes objection_type + subtype to the call_turns row
// for downstream analytics dashboards.
const classifyAnalyticsWorker = new Worker<ClassifyAnalyticsJobData>(
  'classify-analytics-queue',
  async (job) => {
    const { callId, callTurnId, utterance, stage, score } = job.data;
    const log = logger.child({ call_id: callId, job_id: job.id, call_turn_id: callTurnId });
    try {
      const result = await classifyObjection({
        call_id: callId,
        utterance,
        stage: stage as ConversationStage,
        score,
      });
      await updateCallTurnAnalytics(callTurnId, {
        objectionType: result.objection_type,
        objectionSubtype: result.subtype ?? null,
        sentiment: result.sentiment,
      });
      log.debug(
        { objection_type: result.objection_type, subtype: result.subtype },
        'classify-analytics: tagged turn',
      );
    } catch (err) {
      log.warn({ err }, 'classify-analytics failed — turn left untagged');
    }
  },
  { connection: redisConnection },
);

// Log errors from workers
for (const worker of [
  callEndWorker,
  analyticsWorker,
  crmWorker,
  classifyAnalyticsWorker,
  insightsWorker,
]) {
  worker.on('failed', (job, err) => {
    logger.error({ job_id: job?.id, queue: worker.name, err }, 'Job failed');
  });
}

// DLQ monitor — alert every 5 minutes if any failed jobs remain
setInterval(async () => {
  const [callEndFailed, analyticsFailed, crmFailed, classifyFailed, insightsFailed] =
    await Promise.all([
      callEndQueue.getFailedCount(),
      analyticsQueue.getFailedCount(),
      crmQueue.getFailedCount(),
      classifyAnalyticsQueue.getFailedCount(),
      insightsQueue.getFailedCount(),
    ]);
  const total =
    callEndFailed + analyticsFailed + crmFailed + classifyFailed + insightsFailed;
  if (total > 0) {
    logger.error(
      {
        call_end: callEndFailed,
        analytics: analyticsFailed,
        crm: crmFailed,
        classify_analytics: classifyFailed,
        insights: insightsFailed,
      },
      'DLQ has failed jobs — data loss risk, investigate immediately',
    );
  }
}, 5 * 60 * 1000);

// Graceful shutdown
const shutdown = async () => {
  logger.info('Workers shutting down');
  await Promise.all([
    callEndWorker.close(),
    analyticsWorker.close(),
    crmWorker.close(),
    classifyAnalyticsWorker.close(),
    insightsWorker.close(),
  ]);
  await Promise.all([
    callEndQueue.close(),
    analyticsQueue.close(),
    crmQueue.close(),
    classifyAnalyticsQueue.close(),
    insightsQueue.close(),
  ]);
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('BullMQ workers ready');
