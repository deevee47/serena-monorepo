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
