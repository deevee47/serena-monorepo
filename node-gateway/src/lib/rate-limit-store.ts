import type { FastifyRateLimitStore } from '@fastify/rate-limit';
import type { RouteOptions } from 'fastify';
import { redis } from './redis.js';

export class BunRedisStore implements FastifyRateLimitStore {
  private readonly prefix: string;

  constructor(_options: object, prefix = 'rl-') {
    this.prefix = prefix;
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow = 60_000,
  ): void {
    const fullKey = this.prefix + key;
    (async () => {
      const current = await redis.incr(fullKey);
      if (current === 1) {
        await redis.pexpire(fullKey, timeWindow);
        return { current, ttl: timeWindow };
      }
      const pttl = await redis.pttl(fullKey);
      if (pttl < 0) {
        await redis.pexpire(fullKey, timeWindow);
        return { current, ttl: timeWindow };
      }
      return { current, ttl: pttl };
    })()
      .then((result) => callback(null, result))
      .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
  }

  child(
    routeOptions: RouteOptions & { path: string; prefix: string },
  ): FastifyRateLimitStore {
    const opts = routeOptions as unknown as { routeInfo?: { method?: string; url?: string } };
    const method = opts.routeInfo?.method ?? '';
    const url = opts.routeInfo?.url ?? routeOptions.path;
    return new BunRedisStore({}, `${this.prefix}${method}${url}-`);
  }
}
