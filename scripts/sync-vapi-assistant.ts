/**
 * Push Serena's call-pacing (incl. SMART ENDPOINTING) onto the Vapi assistant
 * itself, so it applies to EVERY call — phone and browser — regardless of
 * whether a per-call override propagates.
 *
 * Why: web calls start with `vapi.start(assistantId, { startSpeakingPlan })`,
 * but that override isn't reliably honored, so mid-sentence pauses were still
 * being treated as end-of-turn and split into separate LLM turns. Setting the
 * plan on the assistant is the durable fix; the per-call overrides stay as a
 * belt-and-suspenders.
 *
 * Keep these values in sync with ASSISTANT_PACING in
 * `node-gateway/src/services/voice-provider/vapi-provider.ts` and the web
 * override in `dashboard/src/components/talk-button-vapi.tsx`.
 *
 * Usage:
 *   bun scripts/sync-vapi-assistant.ts            # PATCH the assistant
 *   bun scripts/sync-vapi-assistant.ts --dry-run  # print payload, change nothing
 *
 * Bun auto-loads .env (VAPI_API_KEY, VAPI_ASSISTANT_ID).
 */

// `provider: 'vapi'` is the multilingual smart-endpointing model — it holds
// through natural Hindi/Hinglish pauses (livekit is English-only). waitSeconds
// is the floor before the assistant may respond; the smart plan extends it.
const PACING = {
  silenceTimeoutSeconds: 12,
  numWordsToInterruptAssistant: 2,
  backchannelingEnabled: true,
  endCallPhrases: ['bye', 'goodbye', 'thank you bye', 'alvida', 'rakhti hoon'],
  startSpeakingPlan: {
    waitSeconds: 0.8,
    smartEndpointingPlan: { provider: 'vapi' as const },
  },
};

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const apiKey = process.env['VAPI_API_KEY'];
  const assistantId = process.env['VAPI_ASSISTANT_ID'];

  if (!apiKey || !assistantId) {
    console.error('✗ VAPI_API_KEY and VAPI_ASSISTANT_ID must be set (check .env).');
    process.exitCode = 1;
    return;
  }

  console.log(`Assistant: ${assistantId}`);
  console.log('Payload:', JSON.stringify(PACING, null, 2));

  if (dryRun) {
    console.log('— dry run, no changes made —');
    return;
  }

  const res = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(PACING),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`✗ Vapi PATCH failed (HTTP ${res.status}): ${body}`);
    process.exitCode = 1;
    return;
  }

  const updated = (await res.json().catch(() => ({}))) as {
    startSpeakingPlan?: unknown;
  };
  console.log('✓ Assistant updated. startSpeakingPlan is now:');
  console.log(JSON.stringify(updated.startSpeakingPlan ?? '(not echoed)', null, 2));
}

main().catch((err) => {
  console.error('✗ Sync failed:', err);
  process.exitCode = 1;
});
