/// <reference types="bun-types" />
// Usage: bun run scripts/simulate-call.ts
// Requires node-gateway running at localhost:3000 with NODE_ENV=development

const GATEWAY_URL = process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
const VAPI_WEBHOOK_SECRET = process.env['VAPI_WEBHOOK_SECRET'] ?? 'dev-webhook-secret';
const CALL_ID = `sim-${Date.now()}`;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 8000;

// Walks the agent through the full converse pipeline:
//   1. Cold open — agent should open with name + cart + 5% offer
//   2. Quality concern → triggers get_review_summary
//   3. Inventory question → triggers check_inventory
//   4. Price pushback → should trigger get_available_offers BEFORE flat discount
//   5. Customer accepts the bundle → triggers send_whatsapp_checkout_link
const SCENARIO = [
  "hey",
  "is the chair actually any good?",
  "how many do you guys actually have left in stock?",
  "the price is a bit much for me right now",
  "okay yeah let's do the bundle, send me the link",
];

const FALLBACK_AGENT_REPLIES = new Set([
  'Give me just a moment.',
  'Let me think about the best way to explain this.',
  "That's a great point — could you say a bit more about that?",
  'I want to make sure I get this right for you.',
  'Could you give me just a second?',
  'Thank you so much for your time today.',
]);

type Session = {
  stage?: string;
  score?: number;
  objectionsEncountered?: string[];
  discountsOffered?: number[];
  turnCount?: number;
  conversationHistory?: Array<{ speaker: string; utterance: string }>;
  error?: string;
};

async function sendWebhook(payload: unknown) {
  const res = await fetch(`${GATEWAY_URL}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VAPI_WEBHOOK_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function getSession(): Promise<Session> {
  const res = await fetch(`${GATEWAY_URL}/debug/session/${CALL_ID}`);
  return res.json() as Promise<Session>;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll until turnCount reaches expectedTurns or timeout
async function waitForTurn(expectedTurnCount: number): Promise<Session> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await getSession();
    if (session.error) return session;
    if ((session.turnCount ?? 0) >= expectedTurnCount) return session;
    await sleep(POLL_INTERVAL_MS);
  }
  return getSession();
}

async function main() {
  console.log(`\n=== Serena Call Simulator ===`);
  console.log(`Call ID: ${CALL_ID}`);
  console.log(`Gateway: ${GATEWAY_URL}\n`);

  // Step 1: assistant-request
  console.log('[1] Sending assistant-request...');
  const assistantRes = await sendWebhook({
    message: {
      type: 'assistant-request',
      call: { id: CALL_ID, customer: { number: '+15551234567' } },
    },
  }) as { assistantId?: string };
  console.log(`    assistantId: ${assistantRes.assistantId}\n`);

  // Step 2: Each utterance in the scenario
  for (let i = 0; i < SCENARIO.length; i++) {
    const utterance = SCENARIO[i];
    // Each turn appends 2 entries (USER + AGENT), so after turn i+1 we expect (i+1)*2 total
    const expectedTurnCount = (i + 1) * 2;

    console.log(`[Turn ${i + 1}] User: "${utterance}"`);

    await sendWebhook({
      message: {
        type: 'transcript',
        call: { id: CALL_ID, customer: { number: '+15551234567' } },
        role: 'user',
        transcriptType: 'final',
        transcript: utterance,
      },
    });

    const session = await waitForTurn(expectedTurnCount);

    if (session.error) {
      console.log(`    [session ended]\n`);
      continue;
    }

    // Last agent utterance from history
    const history = session.conversationHistory ?? [];
    const lastAgent = [...history].reverse().find((t) => t.speaker === 'AGENT');
    const agentText = lastAgent?.utterance ?? '(no response yet)';
    const fallbackMarker = FALLBACK_AGENT_REPLIES.has(agentText) ? ' [FALLBACK]' : '';

    console.log(`    Agent${fallbackMarker}: "${agentText}"`);
    console.log(`    stage=${session.stage} score=${session.score} objections=[${(session.objectionsEncountered ?? []).join(',')}] discounts=[${(session.discountsOffered ?? []).join(',')}]\n`);
  }

  // Step 3: end-of-call-report
  console.log('[Final] Sending end-of-call-report...');
  await sendWebhook({
    message: {
      type: 'end-of-call-report',
      call: { id: CALL_ID },
      durationSeconds: SCENARIO.length * 15,
    },
  });

  console.log('\n=== Simulation complete ===');
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
