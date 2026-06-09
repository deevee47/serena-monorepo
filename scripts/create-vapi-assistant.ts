/**
 * Create Serena's Vapi assistant in a (new) Vapi account.
 *
 * Why this exists: the assistant's model (our custom LLM), webhook server, and
 * pacing live on the Vapi *assistant* object — not in our env — so moving to a
 * new Vapi account means recreating it. This wires the new assistant to the
 * gateway exactly the way the code expects:
 *   - model      → custom-llm at  <PUBLIC_URL>/vapi-llm/chat/completions
 *   - server     → <PUBLIC_URL>/webhook   (end-of-call, speech-update, …)
 *   - auth       → Authorization: Bearer <VAPI_WEBHOOK_SECRET> on both, so the
 *                  gateway's verifyLlmAuth / verifyWebhook pass (this is what
 *                  the "invalid_bearer_token" dev warnings were about)
 *   - endpointing→ smart endpointing (provider 'vapi', multilingual) so pauses
 *                  don't split a turn
 *
 * It reads VAPI_API_KEY (the new key) + VAPI_WEBHOOK_SECRET from .env (Bun
 * auto-loads). The PUBLIC URL can't be inferred (it's your ngrok / deployed
 * gateway host), so pass it as the first arg.
 *
 * Usage:
 *   bun scripts/create-vapi-assistant.ts https://your-gateway.ngrok-free.dev
 *   bun scripts/create-vapi-assistant.ts https://your-gateway.ngrok-free.dev --dry-run
 *
 * After it prints the new assistant id:
 *   1. set VAPI_ASSISTANT_ID=<that id> in .env
 *   2. set VAPI_PUBLIC_KEY=<new account's public key> (Vapi dashboard → API keys)
 *   3. voice + transcriber default to Vapi's defaults — pick a Hindi-capable
 *      11labs voice + a multilingual transcriber in the dashboard for Hinglish
 *   4. PSTN also needs a phone number imported in the new account
 *      (→ VAPI_PHONE_NUMBER_ID)
 */

const PUBLIC_URL = process.argv[2];
const DRY_RUN = process.argv.slice(2).includes('--dry-run');

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!PUBLIC_URL || PUBLIC_URL.startsWith('--')) {
  die(
    'Pass your public gateway URL as the first arg, e.g.\n' +
      '    bun scripts/create-vapi-assistant.ts https://your-gateway.ngrok-free.dev',
  );
}
let base: string;
try {
  base = new URL(PUBLIC_URL).origin; // strip any path/trailing slash
} catch {
  die(`"${PUBLIC_URL}" is not a valid URL`);
}

const apiKey = process.env['VAPI_API_KEY'];
const webhookSecret = process.env['VAPI_WEBHOOK_SECRET'];
if (!apiKey) die('VAPI_API_KEY is not set (check .env — should be the NEW account key).');
if (!webhookSecret) die('VAPI_WEBHOOK_SECRET is not set (check .env).');

// Keep pacing/endpointing in sync with ASSISTANT_PACING in
// node-gateway/src/services/voice-provider/vapi-provider.ts.
// Mirrors the proven production config (see the cloned assistant). Voice +
// transcriber carry NO credentialId, so Vapi uses the account's shared
// 11labs/deepgram — connect your own in the dashboard if a provider needs it.
const assistant = {
  name: 'Serena — Sera',
  // Empty opener + model-generated mode: the brain writes the first line.
  // (Web /talk overrides this via vapi.start with a product-specific opener.)
  firstMessage: '',
  firstMessageMode: 'assistant-speaks-first-with-model-generated-message',
  model: {
    provider: 'custom-llm',
    // Vapi appends `/chat/completions` itself, so this is the BASE path.
    url: `${base}/vapi-llm`,
    model: 'gpt-4o-mini',
    maxTokens: 220,
    // Gateway verifyLlmAuth expects this exact header.
    headers: { Authorization: `Bearer ${webhookSecret}` },
  },
  voice: {
    provider: '11labs',
    voiceId: 'mmSZflZFDoe6qEecRgIO',
    model: 'eleven_multilingual_v2',
    stability: 0.45,
    similarityBoost: 0.8,
    speed: 1,
  },
  // Hinglish STT: nova-3 'multi' does Hindi/English code-switching.
  transcriber: {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'multi',
  },
  server: {
    url: `${base}/webhook`,
    // Gateway verifyWebhook expects this exact header.
    headers: { Authorization: `Bearer ${webhookSecret}` },
  },
  serverMessages: ['end-of-call-report', 'status-update'],
  startSpeakingPlan: {
    // 1.5s floor so the caller gets a beat to think before the agent responds.
    waitSeconds: 1.5,
    smartEndpointingPlan: { provider: 'vapi' },
  },
  // Interruption (barge-in) handling: a real phrase interrupts; bilingual
  // backchannels never do; explicit "stop/ruko" words always do.
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 1.0,
    acknowledgementPhrases: [
      'haan', 'haan haan', 'ji', 'ji haan', 'hmm', 'mhm', 'uh huh', 'ok', 'okay',
      'yeah', 'yes', 'yep', 'achha', 'theek hai', 'right', 'sure', 'got it', 'go on', 'cool',
    ],
    interruptionPhrases: [
      'stop', 'wait', 'hold on', 'one sec', 'one second', 'ruko', 'ruko zara',
      'suno', 'sun', 'ek minute', 'ek second', 'nahi nahi', 'no no', 'excuse me',
    ],
  },
  silenceTimeoutSeconds: 12,
  numWordsToInterruptAssistant: 2,
  backchannelingEnabled: true,
  backgroundDenoisingEnabled: true,
  endCallPhrases: ['bye', 'goodbye', 'thank you bye', 'alvida', 'rakhti hoon'],
};

function maskedPayload() {
  return JSON.stringify(assistant, null, 2).replace(
    new RegExp(`Bearer ${webhookSecret}`, 'g'),
    'Bearer ***',
  );
}

async function main() {
  // If VAPI_ASSISTANT_ID is set, CONFIGURE that existing assistant (PATCH);
  // otherwise CREATE a fresh one (POST). PATCH merges, so we send the full
  // config either way.
  const existingId = process.env['VAPI_ASSISTANT_ID'];
  const url = existingId
    ? `https://api.vapi.ai/assistant/${existingId}`
    : 'https://api.vapi.ai/assistant';
  const method = existingId ? 'PATCH' : 'POST';

  console.log(`${method} ${existingId ?? '(new assistant)'} → gateway ${base}`);
  console.log(`Payload:\n${maskedPayload()}`);

  if (DRY_RUN) {
    console.log('— dry run, nothing changed —');
    return;
  }

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(assistant),
  });

  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: unknown };
  if (!res.ok) {
    die(`Vapi rejected the request (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }

  console.log(`\n✓ Assistant ${existingId ? 'configured' : 'created'}: ${body.id ?? existingId}`);
  if (!existingId) {
    console.log(`  → set VAPI_ASSISTANT_ID=${body.id} in .env`);
  }
  console.log('Remaining (dashboard / account-specific):');
  console.log('  • pick a Hindi-capable VOICE (11labs multilingual / Azure hi-IN) — the');
  console.log('    transcriber is already set to deepgram nova-2 multi for Hinglish STT');
  console.log('  • import a phone number for PSTN → VAPI_PHONE_NUMBER_ID');
}

main().catch((err) => die(`create failed: ${err}`));
