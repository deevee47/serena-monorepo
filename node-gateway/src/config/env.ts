import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load a service-local .env first, then fall back to the repo root .env for monorepo dev.
loadEnv();
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']),
  VAPI_WEBHOOK_SECRET: z.string().min(1),
  VAPI_API_KEY: z.string().min(1),
  VAPI_ASSISTANT_ID: z.string().min(1),
  FASTAPI_BRAIN_URL: z.string().url(),
  INTERNAL_SERVICE_SECRET: z.string().min(1),
  ADMIN_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = result.data;
