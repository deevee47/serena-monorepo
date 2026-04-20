import pino from 'pino';
import { config } from '../config/env.js';

const rootLogger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'node-gateway' },
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }
    : {}),
});

export const logger = rootLogger;

export function createCallLogger(callId: string) {
  return rootLogger.child({ call_id: callId });
}
