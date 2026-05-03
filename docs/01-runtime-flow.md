# 01 — Runtime flow: one phone-call turn, end to end

This doc walks a single user utterance — *"the chair's a bit out of my budget"* — from the moment Vapi transcribes it until the agent's reply hits the customer's ear and (optionally) a WhatsApp link goes out. Everything below is real code from the repo, with file:line references.

> **Mental model**: Vapi is in **Custom LLM mode**. That means Vapi treats the gateway as if it were OpenAI — it POSTs to `/vapi-llm/chat/completions` once per turn with the conversation history, and waits for an OpenAI-compatible streaming response. The gateway translates that to/from our brain's converse pipeline.

---

## 1. The request shape Vapi sends us

When the customer speaks, Vapi runs STT and POSTs this to the gateway:

```jsonc
POST /vapi-llm/chat/completions
Authorization: Bearer <VAPI_WEBHOOK_SECRET>
{
  "model": "any-string-vapi-puts-here",
  "messages": [
    { "role": "system",    "content": "<assistant system prompt from Vapi dashboard — ignored>" },
    { "role": "assistant", "content": "Hi Sarah, this is Alex from ShopEase..." },
    { "role": "user",      "content": "the chair's a bit out of my budget" }
  ],
  "stream": true,
  "call": {
    "id": "019de802-16fd-7000-82a4-aee2bfa6832a",
    "customer": { "number": "+15551234567" },
    "metadata": { "product_id": "prod-001", "trigger_reason": "cart_abandon" }
  }
}
```

Vapi expects an OpenAI-format SSE response back: `data: {"choices":[{"delta":{"content":"..."}}]}` chunks ending with `data: [DONE]`.

---

## 2. Auth check (dev-permissive)

[node-gateway/src/routes/vapi-llm.ts:65-87](../node-gateway/src/routes/vapi-llm.ts#L65-L87)

```ts
const authHeader = request.headers['authorization'] as string | undefined;
if (authHeader !== undefined) {
  const expected = `Bearer ${config.VAPI_WEBHOOK_SECRET}`;
  const expBuf = Buffer.from(expected);
  const authBuf = Buffer.from(authHeader);
  const matches =
    authBuf.length === expBuf.length && crypto.timingSafeEqual(authBuf, expBuf);
  if (!matches) {
    request.log.warn({ ... }, 'vapi-llm auth mismatch — proceeding anyway (DEV)');
  }
}
```

**Why permissive in dev:** the ngrok tunnel URL is obscure enough to not be a public attack surface, and rejecting on first deploy when the Vapi dashboard's "API Key" field hasn't been set yet is a frustrating debug experience. The TODO is to tighten before prod (timing-safe compare with rejection on mismatch, identical to the `/webhook` handler).

---

## 3. Lazy session creation

[node-gateway/src/routes/vapi-llm.ts:98-119](../node-gateway/src/routes/vapi-llm.ts#L98-L119)

```ts
let session = await getSession(callId);
if (!session) {
  const pendingRaw = await redis.get(`pending_call:${callId}`);
  let productId = 'prod-001';
  if (pendingRaw) {
    try {
      productId = (JSON.parse(pendingRaw) as { productId: string }).productId;
    } catch { /* ignore */ }
  } else if (typeof body.call?.metadata?.['product_id'] === 'string') {
    productId = body.call.metadata['product_id'] as string;
  }
  const phoneNumber = body.call?.customer?.number ?? 'unknown';
  session = await createSession({ callId, phoneNumber, productId });
  createCallRecord(session).catch((err) => log.error({ err }, 'createCallRecord failed'));
}
```

**Why lazy:** Vapi's `assistant-request` webhook (which used to create the session) only fires for **inbound** calls. For **outbound** calls — what `/calls/trigger` initiates — Vapi already has the assistantId at dial time, so it never calls `assistant-request`. The first `/vapi-llm` request is therefore the first time we see this `call.id` in the gateway, and we have to bootstrap the session here.

**The handoff path:** `/calls/trigger` writes `pending_call:<vapiCallId> → { productId, triggerReason }` to Redis with a 60s TTL. The first `/vapi-llm` hit reads that key, peels out `productId`, and `createSession()` writes the full `CallSession` JSON to `session:<callId>` with a 2-hour TTL.

[node-gateway/src/services/session.service.ts:43-65](../node-gateway/src/services/session.service.ts#L43-L65)

```ts
export async function createSession(input: SessionCreateInput): Promise<CallSession> {
  const now = new Date();
  const session: CallSession = {
    callId: input.callId,
    phoneNumber: input.phoneNumber,
    productId: input.productId,
    stage: ConversationStage.INTRO,
    score: 50,
    discountsOffered: [],
    objectionsEncountered: [],
    conversationHistory: [],
    turnCount: 0,
    currentProductId: input.productId,
    closeAttempted: false,
    followUpRequested: false,
    followUpNote: null,
    createdAt: now,
    lastUpdatedAt: now,
    isActive: true,
  };
  await redis.set(key(input.callId), serialize(session), 'EX', SESSION_TTL);
  return session;
}
```

The session stays in Redis for the call's lifetime, holds `discountsOffered` (so subsequent turns know what's already been promised), and is read fresh on every `/vapi-llm` request.

---

## 4. Build the brain context

The gateway needs to assemble what the brain calls a `ConverseRequest`: the latest utterance + history + product/cart context + any alternative products + how many discounts have been offered.

### 4.1 Latest utterance + history

[node-gateway/src/routes/vapi-llm.ts:121-173](../node-gateway/src/routes/vapi-llm.ts#L121-L173)

```ts
const lastUserMessage = [...body.messages]
  .reverse()
  .find((m) => m.role === 'user' && typeof m.content === 'string');
const utterance = lastUserMessage?.content ?? '';

// ...

// Conversation history from Vapi's messages, excluding the latest user
// utterance (we pass that as `utterance` separately to the brain).
const history: BrainConversationTurn[] = body.messages
  .filter((m) =>
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' &&
    m.content.length > 0,
  )
  .slice(0, -1)
  .slice(-HISTORY_TURNS_TO_INCLUDE)
  .map((m) => ({
    speaker: m.role === 'user' ? 'USER' : 'AGENT',
    utterance: m.content as string,
    timestamp: new Date().toISOString(),
  }));
```

**Why we strip the system message:** Vapi's dashboard might have a system prompt configured (we recommend leaving it empty). Even if it has content, the brain builds its own per-call system prompt from the `ConverseRequest`. Filtering by `m.role === 'user' || 'assistant'` drops it cleanly.

**Why we slice off the latest user message:** the brain expects `utterance` (the new message) and `conversation_history` (everything before) as separate fields. Avoids duplicating the latest user input.

### 4.2 Product + cheaper alt + premium alt (parallel Pinecone lookups)

[node-gateway/src/routes/vapi-llm.ts:126-141](../node-gateway/src/routes/vapi-llm.ts#L126-L141)

```ts
const product = getProductById(session.currentProductId);
const productContext = product ? toProductContext(product) : null;

let alternativeContext = null;
let premiumContext = null;
if (product) {
  // Cheaper + premium in parallel — both feed the prompt's anchor pattern.
  const [cheaperRes, premiumRes] = await Promise.allSettled([
    findAlternativeProduct(session.currentProductId, 'PRICE'),
    findAlternativeProduct(session.currentProductId, 'PREMIUM'),
  ]);
  if (cheaperRes.status === 'fulfilled') alternativeContext = cheaperRes.value;
  else log.warn({ err: cheaperRes.reason }, 'cheaper alt lookup failed (non-fatal)');
  if (premiumRes.status === 'fulfilled') premiumContext = premiumRes.value;
  else log.warn({ err: premiumRes.reason }, 'premium alt lookup failed (non-fatal)');
}
```

**Why both:** the prompt has an anchoring rule — *"I can show you the [premium] for $429 if you're spec-shopping, OR the Lite for $199 — but for $349, the Pro is what most people land on."* The agent can only do that if it has both poles to anchor against.

**Why `Promise.allSettled` not `Promise.all`:** if Pinecone is flaky, a failed cheaper lookup shouldn't kill the whole turn. We log the failure, continue with `null`, and the prompt builder simply omits that section.

`getProductById` is a synchronous lookup against an in-memory `Map` that was loaded from Postgres at gateway boot:

[node-gateway/src/services/product.service.ts:33-54](../node-gateway/src/services/product.service.ts#L33-L54)

```ts
let catalog: Map<string, Product> = new Map();

export async function loadCatalog(): Promise<void> {
  const rows = await prisma.product.findMany({ where: { isActive: true } });
  const next = new Map<string, Product>();
  for (const r of rows) {
    next.set(r.id, {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      price: Number(r.price),
      category: r.category ?? null,
      tags: r.tags,
      isActive: r.isActive,
    });
  }
  catalog = next;
  logger.info({ product_count: catalog.size }, 'Product catalog loaded from DB');
}

export function getProductById(productId: string): Product | null {
  return catalog.get(productId) ?? null;
}
```

The `loadCatalog()` call happens in [app.ts](../node-gateway/src/app.ts) before the server starts listening — so by the first request, the map is populated. This replaces an older hardcoded `CATALOG` array that drifted from seed data.

---

## 5. Stream from the brain → re-stream as OpenAI chunks to Vapi

This is where the gateway acts as the OpenAI translator.

[node-gateway/src/routes/vapi-llm.ts:175-222](../node-gateway/src/routes/vapi-llm.ts#L175-L222)

```ts
// ── Stream OpenAI-compatible SSE response ──────────────────────────
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

const completionId = `chatcmpl-${callId}-${Date.now()}`;
const created = Math.floor(Date.now() / 1000);
const model = body.model ?? 'serena-converse';

const sendChunk = (
  delta: { content?: string; role?: 'assistant' },
  finishReason: string | null = null,
) => {
  const chunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
};

sendChunk({ role: 'assistant' });    // OpenAI's first chunk always announces the role

// Now call into the brain, and forward every text delta as an OpenAI chunk.
const result = await converseStream(
  {
    call_id: callId,
    utterance,
    conversation_history: history,
    product_context: productContext,
    alternative_product_context: alternativeContext,
    premium_product_context: premiumContext,
    cart_context: cartContext,
    discounts_already_offered: session.discountsOffered,
  },
  (delta) => {
    fullText += delta;
    sendChunk({ content: delta });
  },
);
```

**The shape conversion:**
- The brain's `/converse/stream` emits typed events: `{ type: 'text', delta: '...' }` and (after all text streams) `{ type: 'tool_call', name, args }` and finally `{ type: 'done', finish_reason }`.
- Vapi expects OpenAI's chat-completions chunks: `{ choices: [{ index: 0, delta: { content: '...' }, finish_reason: null }] }`.
- The `sendChunk` closure does this translation per text delta.

**Why this matters:** Vapi's TTS pipeline starts speaking on the first chunk. Streaming gives sub-second time-to-first-word, even though the full response might take 2-3s to complete.

**`Promise.allSettled` and SSE:** the `converseStream` function in [brain.service.ts](../node-gateway/src/services/brain.service.ts) hits the brain's `/converse/stream` SSE endpoint, parses incoming events, and calls our `onTextDelta` callback for each. If the stream errors after partial text was sent, the gateway catches the error and emits one fallback chunk + `[DONE]`:

[node-gateway/src/routes/vapi-llm.ts:246-257](../node-gateway/src/routes/vapi-llm.ts#L246-L257)

```ts
} catch (err) {
  log.error({ err }, 'Vapi LLM turn failed');
  try {
    sendChunk({ content: 'Give me just a moment.' });
    sendChunk({}, 'stop');
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  } catch { /* connection probably closed */ }
  return;
}
```

This means **the agent NEVER goes silent on Vapi**. Worst case it says "Give me just a moment" — which buys a turn for the brain to recover or for a retry.

---

## 6. Dispatch any side-effect tool

After all text has streamed, the brain's response may include a `tool_call` event for `send_whatsapp_checkout_link` or `send_whatsapp_product_info`. The gateway dispatches it server-side:

[node-gateway/src/routes/vapi-llm.ts:224-241](../node-gateway/src/routes/vapi-llm.ts#L224-L241)

```ts
if (result.tool_call) {
  dispatch = dispatchToolCall(result.tool_call, {
    callId,
    phoneNumber: session.phoneNumber,
    product: product
      ? { id: product.id, name: product.name, price: product.price }
      : null,
  });
  log.info({
    tool: dispatch.toolName,
    applied_args: dispatch.appliedArgs,
    whatsapp_message_id: dispatch.whatsapp?.messageId,
    skipped: dispatch.skipped,
  }, 'Tool dispatched');
}
```

The dispatcher itself enforces the discount cap as a final defensive layer:

[node-gateway/src/services/converse-dispatcher.ts:38-103](../node-gateway/src/services/converse-dispatcher.ts#L38-L103)

```ts
function clampDiscountPercent(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.min(MAX_DISCOUNT_PERCENT, Math.max(0, n));
}

export function dispatchToolCall(
  toolCall: ConverseToolCall,
  ctx: DispatchContext,
): DispatchResult {
  if (!ctx.product) { /* skip with reason */ }

  switch (toolCall.name) {
    case 'send_whatsapp_checkout_link': {
      const discount = clampDiscountPercent(toolCall.args['discount_percent']);
      const result = sendCheckoutLinkOnWhatsApp({
        to: ctx.phoneNumber,
        productId: ctx.product.id,
        productName: ctx.product.name,
        price: ctx.product.price,
        discountPercent: discount,
      });
      return { toolName: toolCall.name, appliedArgs: { discount_percent: discount }, whatsapp: result };
    }
    case 'send_whatsapp_product_info': { /* similar */ }
    default: {
      const _exhaustive: never = toolCall.name;  // TS error if ToolName grows without a case
      // ...
    }
  }
}
```

**Critical detail:** side-effect tool calls are **NOT forwarded to Vapi** as OpenAI tool_calls. Vapi just speaks whatever text the agent already streamed (e.g. *"Sending it to your WhatsApp now."*) and the actual WhatsApp send happens out-of-band on our side. This sidesteps Vapi's tool-handling layer entirely.

**Why three layers of discount enforcement:**
1. `tools.py` Pydantic schema (the JSON schema the LLM sees) → `Field(ge=0, le=10)`
2. The `/converse` route re-validates with Pydantic and drops invalid tool calls
3. This dispatcher silently clamps as last resort

If any one of those layers breaks, the others catch the rogue value. The agent literally cannot give >10%.

---

## 7. Persist + emit `[DONE]`

[node-gateway/src/routes/vapi-llm.ts:243-325](../node-gateway/src/routes/vapi-llm.ts#L243-L325)

```ts
sendChunk({}, 'stop');
reply.raw.write('data: [DONE]\n\n');
reply.raw.end();

// ── Persist turns and update session (best-effort, off the response path)
const sessionUpdates: Parameters<typeof updateSession>[1] = {};
if (dispatch?.toolName === 'send_whatsapp_checkout_link') {
  const offered = (dispatch.appliedArgs['discount_percent'] as number | undefined) ?? 0;
  if (offered > 0 && !session.discountsOffered.includes(offered)) {
    sessionUpdates.discountsOffered = [...session.discountsOffered, offered];
  }
}
if (Object.keys(sessionUpdates).length > 0) {
  await updateSession(callId, sessionUpdates);
}

const now = new Date();
await appendTurn(callId, { speaker: 'USER', utterance, timestamp: now });
await appendTurn(callId, { speaker: 'AGENT', utterance: fullText, timestamp: new Date() });

// Postgres turn writes are fire-and-forget — they don't block the response.
const turnBase = { scoreBefore: 0, scoreAfter: 0, stage: session.stage };

insertCallTurn(callId, { turnNumber: session.turnCount + 1, speaker: 'USER', utterance, ...turnBase })
  .then((userTurnId) =>
    classifyAnalyticsQueue.add('classify', {
      callId, callTurnId: userTurnId, utterance, stage: session.stage, score: 50,
    }).catch((err) => log.warn({ err }, 'enqueue classify-analytics failed'))
  )
  .catch((err) => log.error({ err }, 'DB turn insert failed (user)'));

insertCallTurn(callId, {
  turnNumber: session.turnCount + 2,
  speaker: 'AGENT',
  utterance: fullText,
  toolCalled: dispatch?.toolName ?? null,
  toolArgs: dispatch?.appliedArgs ?? null,
  discountOffered: discountAmount,
  ...turnBase,
}).catch((err) => log.error({ err }, 'DB turn insert failed (agent)'));
```

**Order matters:** we send `[DONE]` before doing any of the post-processing (Postgres writes, classify-analytics enqueue). That way Vapi gets its response back ASAP and starts TTS — the persistence is best-effort and async.

**Three durability tiers per turn:**
1. **Redis session** (`appendTurn`) — fast, ephemeral (2h TTL), used by future turns in this call.
2. **Postgres `call_turns`** (`insertCallTurn`) — durable audit trail with `tool_called` + `tool_args` jsonb. Survives restarts.
3. **BullMQ `classify-analytics-queue`** — kicks off async sentiment/objection tagging on the USER turn. Runs in `node-worker`.

---

## 8. Call end (lifecycle, not in /vapi-llm)

When the customer hangs up, Vapi POSTs `end-of-call-report` to `/webhook` (NOT `/vapi-llm` — that's per-turn only). The gateway:

[node-gateway/src/routes/webhook.ts:309-363](../node-gateway/src/routes/webhook.ts#L309-L363)

```ts
if (type === 'end-of-call-report') {
  const session = await getSession(callId);
  if (!session) return reply.send({});

  // Outcome under the converse pipeline: CONVERTED iff the LLM ever
  // fired the checkout tool during the call. Anything else is DROPPED.
  const checkoutTurn = await prisma.callTurn.findFirst({
    where: { callId, toolCalled: 'send_whatsapp_checkout_link' },
    select: { id: true, toolArgs: true },
  });
  const outcome: 'CONVERTED' | 'DROPPED' = checkoutTurn ? 'CONVERTED' : 'DROPPED';

  // ... enqueue 3 BullMQ jobs:
  await callEndQueue.add('call-end', { ...job data... });
  await analyticsQueue.add('analytics', { ... });
  await crmQueue.add('crm-update', { ... });
}
```

The `call-end-queue` worker finalizes Postgres state, increments `Customer.priorCallsCount`, and logs a tool dispatch summary:

[node-gateway/src/workers.ts:23-58](../node-gateway/src/workers.ts#L23-L58)

```ts
const callEndWorker = new Worker<CallEndJobData>(
  'call-end-queue',
  async (job) => {
    const { callId, outcome, finalScore, discountGiven, stageReached, durationSeconds, phoneNumber } = job.data;
    const log = logger.child({ call_id: callId, job_id: job.id });

    await updateCallRecord(callId, {
      endedAt: new Date(),
      outcome, finalScore, discountGiven, stageReached, durationSeconds,
    });

    // Best-effort: bump the customer's prior_calls_count + summarize which
    // side-effect tools fired. Either failing should not crash the worker.
    let toolSummary: Record<string, number> = {};
    try {
      [, toolSummary] = await Promise.all([
        incrementCustomerCallsCount(phoneNumber),
        getToolDispatchSummary(callId),
      ]);
    } catch (err) {
      log.warn({ err }, 'priorCallsCount/toolSummary post-processing failed');
    }

    await deleteSession(callId);
    log.info({
      outcome, finalScore,
      tool_dispatch_summary: toolSummary,
      checkout_fired: (toolSummary['send_whatsapp_checkout_link'] ?? 0) > 0,
    }, 'call-end job complete');
  },
  { connection: redisConnection },
);
```

**Why outcome detection is "did the checkout tool fire?":** under the old rules-engine pipeline, outcome was tracked by reaching a CLOSE stage. The converse pivot deleted stages; the only ground truth left is whether the agent emitted `send_whatsapp_checkout_link` at any point in the call. Simple and unambiguous.

---

## Connecting the dots

The whole turn, in one flow:

```
Vapi STT
   │
   ▼
POST /vapi-llm/chat/completions
   │ ├─ auth check (permissive)
   │ ├─ lazy session create / load from Redis
   │ ├─ extract latest utterance + history from messages[]
   │ ├─ DB-loaded product lookup (sync, in-memory map)
   │ └─ parallel Pinecone: cheaper + premium alts
   │
   ▼
converseStream(...) → fastapi-brain /converse/stream
   │ (see 02-data-and-tools.md and 03-prompt-and-conversion.md
   │  for what happens inside the brain)
   │
   ◄── SSE: text deltas, then maybe tool_call, then done
   │
   ├─► sendChunk({ content }) per text delta → OpenAI-format SSE → Vapi → TTS → speaker
   │
   ├─► dispatchToolCall(tool_call) → WhatsApp side effect, clamped to ≤10%
   │
   ├─► sendChunk({}, 'stop') + 'data: [DONE]\n\n' → response complete
   │
   └─► (async, off the hot path)
        ├─ updateSession with new discount tier
        ├─ appendTurn × 2 (USER + AGENT) to Redis
        ├─ insertCallTurn × 2 to Postgres
        └─ enqueue classify-analytics for the USER row
```

Every architectural choice in this flow is making a tradeoff between:
- **Latency** (Vapi/TTS needs first chunk fast → streaming, parallel Pinecone, sync product lookup)
- **Durability** (call audit trail must survive failures → fire-and-forget Postgres writes, BullMQ for analytics)
- **Safety** (the agent must never give >10% off, never call rogue tools → 3 layers of validation, dispatcher clamp, fallback returns text-only)

Continue to **[02-data-and-tools.md](02-data-and-tools.md)** for the data model + observation tools, or **[03-prompt-and-conversion.md](03-prompt-and-conversion.md)** for the prompt that drives all of this.
