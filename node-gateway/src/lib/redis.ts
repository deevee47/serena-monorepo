import { config } from '../config/env.js';

// Module-level singleton — shared across routes and services. Auto-reconnect
// is disabled so a missing Redis fails fast at startup (`redis.ping()` in
// app.ts) instead of flooding stderr with thousands of ECONNREFUSED retries.
// The offline queue stays on so the initial `.ping()` can wait for the lazy
// connection to open before sending.
export const redis = new Bun.RedisClient(config.REDIS_URL, {
  autoReconnect: false,
  connectionTimeout: 2000,
});
