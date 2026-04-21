import { config } from '../config/env.js';

// Module-level singleton — shared across routes and services
export const redis = new Bun.RedisClient(config.REDIS_URL);
