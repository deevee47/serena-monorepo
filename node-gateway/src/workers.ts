import { Worker } from 'bullmq';
import { logger } from './utils/logger.js';
import { updateCallRecord } from './services/db.service.js';
import { deleteSession } from './services/session.service.js';
import {
  redisConnection,
  callEndQueue,
  analyticsQueue,
  crmQueue,
  type CallEndJobData,
  type AnalyticsJobData,
  type CrmJobData,
} from './queues/index.js';

logger.info('BullMQ workers starting');

const callEndWorker = new Worker<CallEndJobData>(
  'call-end-queue',
  async (job) => {
    const { callId, outcome, finalScore, discountGiven, stageReached, durationSeconds } = job.data;
    const log = logger.child({ call_id: callId, job_id: job.id });

    await updateCallRecord(callId, {
      endedAt: new Date(),
      outcome,
      finalScore,
      discountGiven,
      stageReached,
      durationSeconds,
    });

    await deleteSession(callId);
    log.info({ outcome, finalScore }, 'call-end job complete');
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

// Log errors from workers
for (const worker of [callEndWorker, analyticsWorker, crmWorker]) {
  worker.on('failed', (job, err) => {
    logger.error({ job_id: job?.id, queue: worker.name, err }, 'Job failed');
  });
}

// DLQ monitor — alert every 5 minutes if any failed jobs remain
setInterval(async () => {
  const [callEndFailed, analyticsFailed, crmFailed] = await Promise.all([
    callEndQueue.getFailedCount(),
    analyticsQueue.getFailedCount(),
    crmQueue.getFailedCount(),
  ]);
  const total = callEndFailed + analyticsFailed + crmFailed;
  if (total > 0) {
    logger.error(
      { call_end: callEndFailed, analytics: analyticsFailed, crm: crmFailed },
      'DLQ has failed jobs — data loss risk, investigate immediately',
    );
  }
}, 5 * 60 * 1000);

// Graceful shutdown
const shutdown = async () => {
  logger.info('Workers shutting down');
  await Promise.all([callEndWorker.close(), analyticsWorker.close(), crmWorker.close()]);
  await Promise.all([callEndQueue.close(), analyticsQueue.close(), crmQueue.close()]);
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('BullMQ workers ready');
