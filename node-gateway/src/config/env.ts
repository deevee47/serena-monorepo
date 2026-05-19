import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load a service-local .env first, then fall back to the repo root .env for monorepo dev.
loadEnv();
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']),
  // Active voice/telephony provider. Selected once at boot; do not switch
  // per-request (would let in-flight calls mix providers and break the lazy
  // session pattern).
  VOICE_PROVIDER: z.enum(['vapi', 'telnyx']).default('vapi'),
  // ── Vapi (required when VOICE_PROVIDER=vapi) ──────────────────────────
  VAPI_WEBHOOK_SECRET: z.string().min(1).optional(),
  VAPI_API_KEY: z.string().min(1).optional(),
  VAPI_ASSISTANT_ID: z.string().min(1).optional(),
  VAPI_PHONE_NUMBER_ID: z.string().min(1).optional(),
  VAPI_PUBLIC_KEY: z.string().min(1).optional(),
  // Voice IDs Vapi resolves through its TTS provider. Optional — when unset,
  // assistantOverrides won't include a voice and the assistant's default wins.
  VAPI_VOICE_EN: z.string().min(1).optional(),
  VAPI_VOICE_HI: z.string().min(1).optional(),
  // The Custom-LLM URL Vapi calls instead of OpenAI. Optional — only set when
  // the gateway is publicly reachable (ngrok / staging / prod).
  VAPI_CUSTOM_LLM_URL: z.string().url().optional(),
  // ── Telnyx (required when VOICE_PROVIDER=telnyx) ──────────────────────
  TELNYX_API_KEY: z.string().min(1).optional(),
  // Base64-encoded Ed25519 public key for webhook signature verification.
  TELNYX_PUBLIC_KEY: z.string().min(1).optional(),
  // Default assistant; per-locale overrides via TELNYX_ASSISTANT_EN/HI.
  TELNYX_ASSISTANT_ID: z.string().min(1).optional(),
  TELNYX_ASSISTANT_EN: z.string().min(1).optional(),
  TELNYX_ASSISTANT_HI: z.string().min(1).optional(),
  TELNYX_PHONE_NUMBER: z.string().min(1).optional(),
  TELNYX_PHONE_NUMBER_ID: z.string().min(1).optional(),
  // Used by /calls/web-token to mint short-lived JWTs for the dashboard.
  TELNYX_TELEPHONY_CREDENTIAL_ID: z.string().min(1).optional(),
  // Bearer secret Telnyx attaches to Custom-LLM POSTs.
  TELNYX_LLM_SHARED_SECRET: z.string().min(1).optional(),
  // Public gateway URL the assistant POSTs to (Custom-LLM endpoint).
  LLM_URL: z.string().url().optional(),
  // Dev escape hatch: when '1', skip Ed25519 webhook signature verification
  // and log the raw headers/body of webhook + LLM requests. Use ONLY while
  // wiring up a new Telnyx assistant — never in prod.
  TELNYX_INSECURE_DEV: z.enum(['0', '1']).optional().default('0'),
  // ── Shared ────────────────────────────────────────────────────────────
  FASTAPI_BRAIN_URL: z.string().url(),
  INTERNAL_SERVICE_SECRET: z.string().min(1),
  ADMIN_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).superRefine((env, ctx) => {
  if (env.VOICE_PROVIDER === 'vapi') {
    for (const key of ['VAPI_WEBHOOK_SECRET', 'VAPI_API_KEY', 'VAPI_ASSISTANT_ID'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when VOICE_PROVIDER=vapi`,
        });
      }
    }
  }
  if (env.VOICE_PROVIDER === 'telnyx') {
    for (const key of ['TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_ASSISTANT_ID'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when VOICE_PROVIDER=telnyx`,
        });
      }
    }
  }
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = result.data;
