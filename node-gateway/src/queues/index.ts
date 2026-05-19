import { Queue } from 'bullmq';
import { config } from '../config/env.js';

// Parse REDIS_URL into a host/port connection config so BullMQ uses its own
// ioredis connection internally — we never import ioredis directly.
const redisUrl = new URL(config.REDIS_URL);
export const redisConnection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
};

export type CallEndJobData = {
  callId: string;
  outcome: 'CONVERTED' | 'DROPPED' | 'NO_ANSWER' | 'ERROR';
  finalScore: number;
  discountGiven: number;
  stageReached: string;
  turnCount: number;
  phoneNumber: string;
  productId: string;
  durationSeconds?: number;
};

export type AnalyticsJobData = {
  callId: string;
  outcome: string;
  finalScore: number;
  discountGiven: number;
  stageReached: string;
  turnCount: number;
};

export type CrmJobData = {
  callId: string;
  phoneNumber: string;
  outcome: string;
  discount: number;
  productId: string;
};

// Fire-and-forget classification of a USER turn for analytics. The /converse
// pipeline doesn't run /classify in the critical path; this queue picks up
// the slack so the call_turns row gets objection_type + subtype populated
// for downstream dashboards. Survives gateway restarts (better than
// `void promise.catch(...)`).
export type ClassifyAnalyticsJobData = {
  callId: string;
  callTurnId: string; // FK into call_turns
  utterance: string;
  stage: string;
  score: number;
};

// Post-call insight generation. Enqueued from callEndWorker after the call
// row has its endedAt + outcome stamped, so the brain has a stable snapshot
// to summarize. Worker just POSTs to brain `/insights/generate`; the brain
// owns the OpenAI call + DB write. BullMQ retries handle transient OpenAI
// failures so the dashboard isn't the only retry surface anymore.
export type InsightsJobData = {
  callId: string;
};

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
};

export const callEndQueue = new Queue<CallEndJobData>('call-end-queue', {
  connection: redisConnection,
  defaultJobOptions,
});

export const analyticsQueue = new Queue<AnalyticsJobData>('analytics-queue', {
  connection: redisConnection,
  defaultJobOptions,
});

export const crmQueue = new Queue<CrmJobData>('crm-queue', {
  connection: redisConnection,
  defaultJobOptions,
});

export const classifyAnalyticsQueue = new Queue<ClassifyAnalyticsJobData>(
  'classify-analytics-queue',
  { connection: redisConnection, defaultJobOptions },
);

export const insightsQueue = new Queue<InsightsJobData>('insights-queue', {
  connection: redisConnection,
  // OpenAI calls can take 5-15s; bump the per-attempt timeout headroom
  // and give it 3 attempts with exponential backoff (2s, 4s, 8s).
  defaultJobOptions,
});
