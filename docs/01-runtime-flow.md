# 01 — Runtime flow: one phone-call turn, end to end

This doc walks a single user utterance — *"the chair's a bit out of my budget"* — from the moment the provider transcribes it until the agent's reply hits the customer's ear and (optionally) a WhatsApp link goes out. Everything below is real code from the repo, with file:line references.

> **Mental model**: the telephony provider — **Vapi or Telnyx** — is in **Custom LLM mode**. That means the provider treats the gateway as if it were OpenAI — it POSTs to `/llm/chat/completions` once per turn with the conversation history, and waits for an OpenAI-compatible streaming response. The gateway translates that to/from our brain's converse pipeline.
>
> **One handler, both providers.** The same endpoint serves Vapi and Telnyx. The gateway auto-detects which provider a request came from (`detectLlmProvider` / `detectWebhookProvider`) and dispatches to that provider's adapter for auth, envelope-parsing, and call-create — so the per-turn flow below is provider-agnostic. Where it matters (auth scheme, latency anchoring) the provider-specific branch is called out. The canonical route is `/llm/chat/completions`; the legacy `/vapi-llm/chat/completions` alias is still mounted so existing Vapi assistant configs keep working untouched.

---

## 1. The request shape the provider sends us

When the customer speaks, the provider runs STT and POSTs an OpenAI-shaped chat-completions request to the gateway. Vapi's looks like this:

```jsonc
POST /llm/chat/completions          // (or the legacy /vapi-llm/chat/completions)
Authorization: Bearer <VAPI_WEBHOOK_SECRET>
{
  "model": "any-string-the-provider-puts-here",
  "messages": [
    { "role": "system",    "content": "<assistant system prompt from the provider dashboard — ignored>" },
    { "role": "assistant", "content": "Hi Sarah, this is Serena from Muscleblaze..." },
    { "role": "user",      "content": "the chair's a bit out of my budget" }
  ],
  "stream": true,
  "call": {
    "id": "019de802-16fd-7000-82a4-aee2bfa6832a",
    "customer": { "number": "+15551234567" },
    "metadata": { "product_id": "prod-001", "trigger_reason": "cart_abandon", "call_mode": "OUTBOUND_RECOVERY" }
  }
}
```

**Each provider wraps the call identity differently** — that's exactly what the gateway abstracts away. Vapi nests `call.id` / `call.customer.number` / `call.metadata` inside the body; Telnyx supplies `x-telnyx-call-control-id` (and a `telnyx_call` block) in the headers, with its trigger metadata riding in an `extra_metadata` map. `detectLlmProvider(headers, body)` ([voice-provider/index.ts:68](../node-gateway/src/services/voice-provider/index.ts#L68)) sniffs those markers — `x-telnyx-call-control-id` / `body.telnyx_call` → Telnyx, `body.call.id` → Vapi — and the matching adapter's `parseLlmEnvelope` normalizes both into one `{ callId, phoneNumber, metadata }` shape ([llm.ts:140](../node-gateway/src/routes/llm.ts#L140)). Everything downstream reads `env.callId` / `env.metadata` and never sees the provider's native shape.

The provider expects an OpenAI-format SSE response back: `data: {"choices":[{"delta":{"content":"..."}}]}` chunks ending with `data: [DONE]`.

---

## 2. Auth check (provider-delegated, dev-permissive)

The handler doesn't know how to check auth itself — it asks the detected provider's adapter. [node-gateway/src/routes/llm.ts:135-138](../node-gateway/src/routes/llm.ts#L135-L138)

```ts
const auth = provider.verifyLlmAuth(request.headers);
if (!auth.ok) {
  request.log.warn({ reason: auth.reason }, 'llm auth mismatch — proceeding anyway (DEV)');
}
```

**Each provider verifies its own way:**
- **Vapi** reuses its webhook secret — `verifyLlmAuth` just delegates to `verifyWebhook`, a timing-safe `crypto.timingSafeEqual` against `Bearer ${VAPI_WEBHOOK_SECRET}` ([vapi-provider.ts:200](../node-gateway/src/services/voice-provider/vapi-provider.ts#L200)).
- **Telnyx** carries its own `Bearer ${TELNYX_LLM_SHARED_SECRET}` on the Custom-LLM request ([telnyx-provider.ts:387](../node-gateway/src/services/voice-provider/telnyx-provider.ts#L387)). (Telnyx's *lifecycle webhooks* — section 8 — use **Ed25519** instead: `tweetnacl.sign.detached.verify` over `` `${timestamp}|${rawBody}` `` with a ±300s replay window, [ed25519.ts:20](../node-gateway/src/services/voice-provider/ed25519.ts#L20).)

**Why permissive in dev:** the ngrok tunnel URL is obscure enough to not be a public attack surface, and rejecting on first deploy when the provider dashboard's shared-secret field hasn't been set yet is a frustrating debug experience. The TODO is to tighten before prod (reject on mismatch, identical to the `/webhook` handler, which already 401s).

**One special case before we even get a session:** Telnyx's portal "Validate LLM connection" button POSTs a probe with no call envelope. `parseLlmEnvelope` returns a null `callId`, and the handler short-circuits into a minimal OpenAI-compatible stub response (`role` → `"ok"` → `stop` → `[DONE]`, plus a usage-only chunk when `stream_options.include_usage` is set) so the validator passes without touching the brain. [llm.ts:142-211](../node-gateway/src/routes/llm.ts#L142-L211)

---

## 3. Parse the metadata, then lazily create the session

First the handler peels the trigger metadata out of the normalized envelope — the per-call levers that ride alongside `product_id`. [node-gateway/src/routes/llm.ts:220-243](../node-gateway/src/routes/llm.ts#L220-L243)

```ts
// Call-completion offer (X-Discount-Pct → dynamic var → extra_metadata).
const rawDiscount = env.metadata['discount_pct'];
const parsedDiscount = /* Number(rawDiscount) or NaN */;
const openingOfferPercent = Number.isFinite(parsedDiscount)
  ? Math.min(10, Math.max(0, Math.round(parsedDiscount)))   // clamp to 0-10
  : null;
// Call mode (X-Call-Mode → dynamic var → extra_metadata).
const rawCallMode = env.metadata['call_mode'];
const callMode =
  rawCallMode === 'INBOUND_PRESALES' || rawCallMode === 'OUTBOUND_RECOVERY'
    ? rawCallMode
    : null;   // anything else → null → brain falls back to OUTBOUND_RECOVERY
```

**`call_mode`** is the call's *reason for existing*: `OUTBOUND_RECOVERY` (we dialed them about an abandoned cart — the default) vs `INBOUND_PRESALES` (the customer called *you*, warm, pre-purchase). It branches the brain's opener + objective (see [03-prompt-and-conversion.md](03-prompt-and-conversion.md)). Only the two known values are forwarded; anything else collapses to `null` so the brain applies its own default. It rides the trigger metadata the same way `product_id` does — Vapi `metadata.call_mode`, Telnyx `X-Call-Mode` custom header → `extra_metadata`. The sibling `discount_pct` carries the opener's call-completion discount, clamped to the authorized 0-10 range right here. Both are forwarded into the `ConverseRequest` in section 5.

Then the session itself, via the idempotent `ensureSessionForCall`:

[node-gateway/src/routes/llm.ts:244-257](../node-gateway/src/routes/llm.ts#L244-L257)

```ts
const ensured = await ensureSessionForCall({
  callId,
  phoneNumber,
  metadataProductId,
  voiceProvider: provider.name,
});
let session = ensured.session;
const triggerProvidedProduct = ensured.productFromTrigger;
```

**Why lazy:** Vapi's `assistant-request` webhook (which eagerly creates the session) only fires for **inbound** calls. For **outbound** calls — what `/calls/trigger` initiates — Vapi already has the assistantId at dial time, so it never calls `assistant-request`; Telnyx has no synchronous assistant handshake at all. The first `/llm/chat/completions` request is therefore often the first time we see this `call.id` in the gateway, and we have to bootstrap the session here. `ensureSessionForCall` is the *same* call the webhook path uses ([session.service.ts:167](../node-gateway/src/services/session.service.ts#L167)) — idempotent, guarded by a short-lived Redis lock so a race between the webhook and the first LLM turn can't produce two sessions.

**The handoff path + product resolution order:** `/calls/trigger` writes `pending_call:<callId> → { productId, triggerReason }` to Redis with a 60s TTL. `ensureSessionForCall` resolves the product in order — (1) `pending_call:<callId>`, (2) the envelope's `metadataProductId`, (3) `DEFAULT_PRODUCT_ID` (`'prod-001'`) — then `createSession()` writes the full `CallSession` JSON to `session:<callId>` with a 2-hour TTL and fires `createCallRecord(session, voiceProvider)` to insert the Postgres `calls` row, **stamping which adapter ran the call** ([db.service.ts:51](../node-gateway/src/services/db.service.ts#L51)). `productFromTrigger` tells the caller whether the product came from a real source or just the default — section 4.3 uses it to decide whether to adopt the cart's first product instead.

[node-gateway/src/services/session.service.ts:49-75](../node-gateway/src/services/session.service.ts#L49-L75)

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
    pushAttempt: 0,
    objectionsEncountered: [],
    conversationHistory: [],
    turnCount: 0,
    currentProductId: input.productId,
    closeAttempted: false,
    followUpRequested: false,
    followUpNote: null,
    lastAgentFinishedAt: null,
    agentSpeechEndedAtMs: null,
    pendingResponseLatencyMs: null,
    createdAt: now,
    lastUpdatedAt: now,
    isActive: true,
  };
  await redis.set(key(input.callId), serialize(session), 'EX', SESSION_TTL);
  return session;
}
```

The session stays in Redis for the call's lifetime, holds `discountsOffered` (so subsequent turns know what's already been promised) and `pushAttempt` (the persistence counter — section 7), and is read fresh on every `/llm/chat/completions` request. The three latency anchors (`lastAgentFinishedAt` / `agentSpeechEndedAtMs` / `pendingResponseLatencyMs`) seed null and are filled in by the speech-boundary path (section 8) — they're how this turn measures the customer's think-time.

---

## 4. Build the brain context

The gateway needs to assemble what the brain calls a `ConverseRequest`: the latest utterance + history + product/cart context + alternative products + the live customer profile + recent-turn signals + how many discounts have been offered.

### 4.1 Latest utterance + history

[node-gateway/src/routes/llm.ts:274-277](../node-gateway/src/routes/llm.ts#L274-L277)

```ts
const lastUserMessage = [...body.messages]
  .reverse()
  .find((m) => m.role === 'user' && typeof m.content === 'string');
const utterance = lastUserMessage?.content ?? '';
```

The latest user message is passed to the brain as `utterance`; everything before it is `conversation_history` — two separate `ConverseRequest` fields, so the brain never double-counts the new input.

**History comes from the Redis session, not the provider's `messages[]`.** [llm.ts:426-459](../node-gateway/src/routes/llm.ts#L426-L459)

```ts
const sessionHistory = await getRecentHistory(callId, HISTORY_TURNS_TO_INCLUDE)
  .catch(() => []);

let history: BrainConversationTurn[];
if (sessionHistory.length > 0) {
  history = sessionHistory.map((t) => ({
    speaker: t.speaker,
    utterance: t.utterance,
    timestamp: t.timestamp.toISOString(),
  }));
} else {
  // Fallback for the very first turn, before the Redis session has any turns:
  // derive history from the provider's messages[] (drops the system message,
  // slices off the latest user utterance).
  history = body.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(0, -1)
    .slice(-HISTORY_TURNS_TO_INCLUDE)
    .map((m) => ({ /* …USER/AGENT… */ }));
}
```

**Why the Redis session wins:** it holds the agent's *actually-streamed* text — including turns the customer interrupted, and gateway-emitted thinking fillers. The provider's `messages[]` can drop or reshape an interrupted opener; if the LLM doesn't see its own (partial) opener in history, it thinks it hasn't opened yet and re-introduces itself every turn. `body.messages` is only the fallback for the very first turn, when the session has no turns yet.

**Opener backfill (first turn only).** When `session.turnCount === 0`, the handler also scans `body.messages` for the provider's locally-spoken first line (e.g. Vapi's `firstMessage` "Hi, this is Serena from Muscleblaze…") — the provider TTSes that itself and never round-trips it through this endpoint, so without a backfill the opener is missing from history, the transcript, and the live tail. `persistOpenerIfMissing(callId, opener)` writes it once, idempotently, as AGENT turn 1, then the session is re-read so the opener counts as already-spoken. [llm.ts:412-424](../node-gateway/src/routes/llm.ts#L412-L424)

### 4.2 Product, alternatives + recent-turn signals (one parallel batch)

[node-gateway/src/routes/llm.ts:327-379](../node-gateway/src/routes/llm.ts#L327-L379)

```ts
const product = getProductById(session.currentProductId);
const productContext = product ? toProductContext(product) : null;

let alternativeContext = null;
let premiumContext = null;
let recentSignals = null;

// One Promise.allSettled batch: recent-turn signals always, plus the
// cheaper + premium Pinecone lookups when we have a product.
const signalLookups: Promise<unknown>[] = [
  getRecentTurnSignals(callId, 3)
    .then((s) => { recentSignals = s; })
    .catch((err) => log.warn({ err }, 'getRecentTurnSignals failed (non-fatal)')),
];
if (product) {
  signalLookups.push(
    findAlternativeProduct(session.currentProductId, 'PRICE')
      .then((v) => { alternativeContext = v; })
      .catch((err) => log.warn({ err }, 'cheaper alt lookup failed (non-fatal)')),
    findAlternativeProduct(session.currentProductId, 'PREMIUM')
      .then((v) => { premiumContext = v; })
      .catch((err) => log.warn({ err }, 'premium alt lookup failed (non-fatal)')),
  );
}
await Promise.allSettled(signalLookups);
```

**Why the cheaper *and* premium alt:** the prompt has an anchoring rule — *"I can show you the [premium] for $429 if you're spec-shopping, OR the Lite for $199 — but for $349, the Pro is what most people land on."* The agent can only do that if it has both poles to anchor against.

**Why `Promise.allSettled`:** if Pinecone is flaky, a failed alt lookup shouldn't kill the turn — we log it, continue with `null`, and the prompt builder omits that section.

**Recent-turn signals** ride in the same batch. `getRecentTurnSignals(callId, 3)` ([db.service.ts:265](../node-gateway/src/services/db.service.ts#L265)) reads the last 3 USER turns and derives a `RecentUserSignals` snapshot: `sentiments[]` (from the async classify-analytics tags), `filler_density`, `length_trend` (linear-regression slope of utterance lengths — negative = disengaging), `repeated_objection` (same `objection_type` on the last two USER turns), and the most recent USER `response_latency_ms`. After the batch settles, the handler layers two **session-derived** signals on top before sending: `push_attempt` (the persistence counter from session state, not inferred from transcript) and `response_latency_ms` (the gap it just measured for *this* turn — fresher than whatever the DB had) ([llm.ts:366-379](../node-gateway/src/routes/llm.ts#L366-L379)). The merged snapshot becomes `recent_user_signals` in the `ConverseRequest`; the brain renders it into an ADAPTIVE BEHAVIOR block — see [03-prompt-and-conversion.md](03-prompt-and-conversion.md).

`getProductById` is a synchronous lookup against an in-memory `Map` that was loaded from Postgres at gateway boot:

[node-gateway/src/services/product.service.ts:34-57](../node-gateway/src/services/product.service.ts#L34-L57)

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
  alternativesMemo.clear();   // re-seed must not serve stale alternatives
  logger.info({ product_count: catalog.size }, 'Product catalog loaded from DB');
}

export function getProductById(productId: string): Product | null {
  return catalog.get(productId) ?? null;
}
```

The `loadCatalog()` call happens in [app.ts](../node-gateway/src/app.ts) before the server starts listening — so by the first request, the map is populated. This replaces an older hardcoded `CATALOG` array that drifted from seed data.

### 4.3 Live customer + cart context

The gateway also hydrates the caller's real profile and abandoned cart — this is what makes the opener reference the *actual* cart instead of a placeholder. The caching is now folded into `getCachedCallContext`, so the route just calls it:

[node-gateway/src/routes/llm.ts:308-325](../node-gateway/src/routes/llm.ts#L308-L325)

```ts
const loaded = await getCachedCallContext(callId, session.phoneNumber);

// If the call was triggered without an explicit product_id, prefer the
// customer's actually-abandoned product over the prod-001 default.
if (!triggerProvidedProduct && loaded.primaryProductId && session.currentProductId === 'prod-001') {
  session = { ...session, currentProductId: loaded.primaryProductId };
  void updateSession(callId, { currentProductId: loaded.primaryProductId })  // fire-and-forget
    .catch((err) => log.warn({ err }, 'product-override updateSession failed (non-fatal)'));
}
```

`getCachedCallContext(callId, phoneNumber)` ([db.service.ts:159](../node-gateway/src/services/db.service.ts#L159)) wraps `loadCallContext` ([db.service.ts:179](../node-gateway/src/services/db.service.ts#L179)) with the Redis cache — read `call_ctx:<callId>`, and on a miss run the DB lookup (the same one the type-and-talk CLI does: the `Customer` row, their 5 most recent purchases, and the most-recent `ABANDONED` cart with its items plus `abandoned_minutes_ago`) and `setex` it at a 30-min TTL. So Postgres is hit **once per call**, not once per turn. Unknown numbers degrade gracefully to all-nulls — the brain treats them as a first-time visitor.

**`triggerProvidedProduct` decides the product override.** This is `ensured.productFromTrigger` from section 3 — when it's false *and* the session still carries the `prod-001` default, the call was triggered without an explicit product, so the gateway adopts the cart's first product as `currentProductId`. The in-memory session is updated synchronously (this turn uses it) but the Redis write is fire-and-forget so it never gates first-token — it's idempotent if a later turn races ahead.

The customer + cart objects become `customer_context` / `cart_context` in the `ConverseRequest`. When there's no DB cart, the gateway falls back to a synthetic single-product cart so the agent still has something to reference ([llm.ts:381-399](../node-gateway/src/routes/llm.ts#L381-L399)).

---

## 5. Stream from the brain → re-stream as OpenAI chunks to the provider

This is where the gateway acts as the OpenAI translator.

[node-gateway/src/routes/llm.ts:461-575](../node-gateway/src/routes/llm.ts#L461-L575)

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

// Now call into the brain, forwarding text deltas as OpenAI chunks and
// turning `thinking` events into TTS fillers. call_mode + opening_offer_percent
// ride along only when set — otherwise the brain applies its own defaults.
const result = await converseStream(
  {
    call_id: callId,
    utterance,
    conversation_history: history,
    product_context: productContext,
    alternative_product_context: alternativeContext,
    premium_product_context: premiumContext,
    cart_context: cartContext,
    customer_context: loaded.customer,
    recent_user_signals: recentSignals,
    discounts_already_offered: session.discountsOffered,
    ...(openingOfferPercent !== null ? { opening_offer_percent: openingOfferPercent } : {}),
    ...(callMode !== null ? { call_mode: callMode } : {}),
  },
  {
    onTextDelta: (delta) => {
      fullText += delta;
      sendChunk({ content: delta });
      publishLive(callId, { type: 'text_delta', delta });   // dashboard live-tail
    },
    onThinking: (toolName) => {
      // The brain is about to run an observation tool (a Postgres round-trip).
      // Stream a short TTS filler so the customer doesn't hear dead air —
      // unless the LLM already opened with its own disfluency cue, or the
      // tool's rolling p50 is fast enough that the filler would land late.
      if (isDisfluencyOpener(fullText)) return;
      if (!shouldEmitFiller(toolName)) return;
      const filler = thinkingFillerFor(toolName, fillerLang);
      fullText += filler;
      sendChunk({ content: filler });
    },
    onObservation: (obs) => { /* collect for persistence + per-tool latency */ },
  },
);
```

This is also where **`call_mode`** (parsed back in section 3) reaches the brain — spread into the `ConverseRequest` only when non-null, so an absent or unrecognized mode leaves the brain on its `OUTBOUND_RECOVERY` default. `opening_offer_percent` rides the same way ([llm.ts:529-532](../node-gateway/src/routes/llm.ts#L529-L532)). The `ConverseRequest` contract — including these two fields — lives in [brain.service.ts](../node-gateway/src/services/brain.service.ts) and on the brain side in [requests.py:164](../fastapi-brain/app/models/requests.py#L164) (`CallMode` enum at [requests.py:6](../fastapi-brain/app/models/requests.py#L6)).

**The shape conversion:**
- The brain's `/converse/stream` emits five typed event kinds: `{ type: 'text', delta }`, `{ type: 'thinking', tool }` (right before an observation-tool round-trip), `{ type: 'observation', name, args, result }`, `{ type: 'tool_call', name, args }` (side-effect tools), and `{ type: 'done', finish_reason }`. The union lives at [brain.service.ts:119](../node-gateway/src/services/brain.service.ts#L119) (`ConverseStreamEvent`).
- The provider expects OpenAI's chat-completions chunks: `{ choices: [{ index: 0, delta: { content: '...' }, finish_reason: null }] }`.
- `onTextDelta` translates `text` events into OpenAI chunks (and publishes each on Redis `live:<callId>` for the dashboard's live-tail); `onThinking` turns a `thinking` event into a streamed TTS filler ("one sec, checking stock —") so the customer never hears dead air during the DB round-trip (see `thinking-filler.ts` and [ARCHITECTURE_STUDY.md §4.9](../ARCHITECTURE_STUDY.md#49-human-feel-pacing)). It's suppressed when the LLM already opened with its own disfluency *or* when `shouldEmitFiller` decides the tool's rolling p50 latency is too fast to bother. `onObservation` collects each observation event for persistence + per-tool latency timing but is **not** forwarded to the provider.

**Why this matters:** the provider's TTS pipeline starts speaking on the first chunk. Streaming gives sub-second time-to-first-word, even though the full response might take 2-3s to complete.

**`converseStream` and SSE:** the `converseStream` function in [brain.service.ts](../node-gateway/src/services/brain.service.ts) hits the brain's `/converse/stream` SSE endpoint, parses incoming events, and calls our callbacks for each. If the stream errors after partial text was sent, the gateway catches the error and emits one fallback chunk + `[DONE]`:

[node-gateway/src/routes/llm.ts:602-613](../node-gateway/src/routes/llm.ts#L602-L613)

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

This means **the agent NEVER goes silent on the provider**. Worst case it says "Give me just a moment" — which buys a turn for the brain to recover or for a retry. Critically, the fallback never synthesizes a tool call, so a brain outage can't accidentally fire a WhatsApp send.

---

## 6. Dispatch any side-effect tool

After all text has streamed, the brain's response may include a `tool_call` event for `send_whatsapp_checkout_link` or `send_whatsapp_product_info`. The gateway dispatches it server-side:

[node-gateway/src/routes/llm.ts:577-597](../node-gateway/src/routes/llm.ts#L577-L597)

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

**Critical detail:** side-effect tool calls are **NOT forwarded to the provider** as OpenAI tool_calls. The provider just speaks whatever text the agent already streamed (e.g. *"Sending it to your WhatsApp now."*) and the actual WhatsApp send happens out-of-band on our side. This sidesteps the provider's tool-handling layer entirely.

**Why three layers of discount enforcement:**
1. `tools.py` Pydantic schema (the JSON schema the LLM sees) → `Field(ge=0, le=10)` ([tools.py:33-39](../fastapi-brain/app/services/tools.py#L33-L39))
2. The `/converse` route re-validates every side-effect call with Pydantic (`_validate_side_effect_tool`, [converse.py:83](../fastapi-brain/app/routes/converse.py#L83)) and drops invalid tool calls — text still streams
3. This dispatcher silently clamps as last resort (`clampDiscountPercent`, [converse-dispatcher.ts:38](../node-gateway/src/services/converse-dispatcher.ts#L38))

If any one of those layers breaks, the others catch the rogue value. The agent literally cannot give >10%. A fourth check, the post-turn `checkSpokenDiscount` reconciliation (section 7), alarms when the agent *spoke* a number above the cap even if no link applied it.

---

## 7. Persist + emit `[DONE]`

The `[DONE]` and `reply.raw.end()` happen *inside* the try block, the moment the brain stream finishes (section 5) — so the provider gets its response back before any persistence runs. What's left is best-effort, off the hot path:

[node-gateway/src/routes/llm.ts:615-665](../node-gateway/src/routes/llm.ts#L615-L665)

```ts
// Anchor for the NEXT turn's pre-response latency. The provider's TTS still
// has to *speak* fullText — the customer can't reply until they've heard it —
// so advance the anchor by the estimated speech duration rather than "now".
const agentSpeechEndsAt = new Date(Date.now() + estimateSpeechMs(fullText)).toISOString();
updateSession(callId, { lastAgentFinishedAt: agentSpeechEndsAt }).catch(/* non-fatal */);

// ── Persist turns and update session (best-effort, off the response path)
await persistTurnPair({
  callId,
  session,
  utterance,
  agentText: fullText,
  dispatch,
  observations,
  userResponseLatencyMs: currentUserLatencyMs,
  observationLatenciesMs: observationLatencies.length > 0 ? observationLatencies : null,
  recentSignals,
});

const discountAmount = /* dispatch.appliedArgs.discount_percent or null */;

// Reconcile the SPOKEN discount (free LLM text, now TTS'd) against what the
// link applied + the absolute cap. We can't un-speak it, but a divergence is
// a verbal-commitment liability worth alarming on.
const discountCheck = checkSpokenDiscount(fullText, discountAmount ?? 0);
if (discountCheck.exceedsCap || discountCheck.exceedsApplied) {
  log.warn({ /* spoken vs applied */ }, 'discount_divergence: …');
}
```

**Order matters:** `[DONE]` goes out before any of the post-processing. That way the provider gets its response back ASAP and starts TTS — the persistence is best-effort and async.

**`persistTurnPair` does the heavy lifting** ([turn-persist.service.ts:121](../node-gateway/src/services/turn-persist.service.ts#L121)) in one place: a single atomic `mutateSession` read-modify-write appends both the USER and AGENT turns to Redis, advances `turnCount`, folds the offered discount into `discountsOffered`, and updates `pushAttempt` — incrementing on a real persuasion push, resetting on checkout or the opener, holding steady on pure clarifications (`isRealPush` decides). Then it fire-and-forgets the two Postgres `insertCallTurn` writes with their turn-quality columns — `responseLatencyMs` on the USER row, `toolCalled` / `toolArgs` / `observationsCalled` / `pushAttempt` / `observationLatenciesMs` on the AGENT row — and enqueues `classify-analytics` for the USER turn.

**Three durability tiers per turn:**
1. **Redis session** — fast, ephemeral (2h TTL), used by future turns in this call. Now written atomically (both turns + pushAttempt + discountsOffered move together under one per-call lock, so concurrent turns can't clobber the counter).
2. **Postgres `call_turns`** (`insertCallTurn`) — durable audit trail with `tool_called` + `tool_args` jsonb, plus the turn-quality columns `push_attempt` / `response_latency_ms` / `observations_called` / `observation_latencies_ms`. Survives restarts.
3. **BullMQ `classify-analytics-queue`** — kicks off async sentiment/objection tagging on the USER turn. Runs in `node-worker`.

**Response latency, closing the loop.** `currentUserLatencyMs` was measured at the top of this turn ([llm.ts:288-306](../node-gateway/src/routes/llm.ts#L288-L306)) as the gap between the prior agent reply finishing and this user utterance arriving. It prefers the provider-measured value (`session.pendingResponseLatencyMs`, set from `speech.boundary` webhooks — section 8) and falls back to the `lastAgentFinishedAt` anchor advanced by `estimateSpeechMs` ([tts-estimate.ts](../node-gateway/src/lib/tts-estimate.ts), 165 WPM). It's persisted as `CallTurn.responseLatencyMs` and, on the next turn, fed back to the brain as `recent_user_signals.response_latency_ms`.

---

## 8. Call end (lifecycle, on /webhook — not /llm)

When the customer hangs up, the provider POSTs its end-of-call signal to `/webhook` (NOT `/llm` — that's per-turn only). This is the *other* place provider abstraction kicks in: `detectWebhookProvider(headers)` ([webhook.ts:215](../node-gateway/src/routes/webhook.ts#L215)) routes by header — Telnyx carries `telnyx-signature-ed25519`, Vapi carries `Authorization: Bearer` — the matching adapter verifies the signature (Vapi `timingSafeEqual` / Telnyx Ed25519), and `provider.parseWebhook` normalizes the native payload (Vapi's `end-of-call-report`, Telnyx's `call.hangup`) into a common `call.ended` event. The route also handles `call.started` (eager session create), `recording.ready`, and `speech.boundary`; Telnyx's TeXML status callbacks come in `application/x-www-form-urlencoded` on a separate `/webhook/telnyx` path ([webhook.ts:297](../node-gateway/src/routes/webhook.ts#L297)).

The `call.ended` event lands in `handleCallEnded`:

[node-gateway/src/routes/webhook.ts:54-129](../node-gateway/src/routes/webhook.ts#L54-L129)

```ts
async function handleCallEnded(event) {
  const session = await getSession(event.callId);
  if (!session) return;

  // Outcome under the converse pipeline: CONVERTED iff the LLM ever fired
  // the checkout tool during the call. Anything else is DROPPED. Compute
  // defensively — a failed query defaults to DROPPED so end-of-call
  // processing (endSession + the enqueues) never aborts.
  let outcome: 'CONVERTED' | 'DROPPED' = 'DROPPED';
  try {
    const checkoutTurn = await prisma.callTurn.findFirst({
      where: { callId: event.callId, toolCalled: 'send_whatsapp_checkout_link' },
      select: { id: true },
    });
    outcome = checkoutTurn ? 'CONVERTED' : 'DROPPED';
  } catch (err) { /* default DROPPED */ }

  await endSession(event.callId);

  // Enqueue the three end-of-call jobs with failure isolation — a Redis blip
  // on one add must not silently drop the others (the webhook 200s and the
  // provider won't retry, so a dropped enqueue is permanent data loss).
  await runIsolated([
    { label: 'call-end',   run: () => callEndQueue.add('call-end', { ... }) },
    { label: 'analytics',  run: () => analyticsQueue.add('analytics', { ... }) },
    { label: 'crm-update', run: () => crmQueue.add('crm-update', { ... }) },
  ], (queueLabel, err) => log.error({ err, queue: queueLabel }, 'end-of-call enqueue failed'));
}
```

The `call-end-queue` worker finalizes Postgres state, increments `Customer.priorCallsCount`, logs a tool dispatch summary, and **eagerly enqueues the call's insight generation**:

[node-gateway/src/workers.ts:29-75](../node-gateway/src/workers.ts#L29-L75)

```ts
const callEndWorker = new Worker<CallEndJobData>(
  'call-end-queue',
  async (job) => {
    const { callId, outcome, discountGiven, durationSeconds, phoneNumber } = job.data;
    const log = logger.child({ call_id: callId, job_id: job.id });

    await updateCallRecord(callId, {
      endedAt: new Date(),
      outcome, discountGiven, durationSeconds,
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

    // Kick off insight generation eagerly. The brain is upsert-idempotent on
    // the CallInsight row, so this is safe even if the dashboard later
    // triggers a fallback generation when someone opens the call page.
    await insightsQueue.add('insights', { callId }).catch((err) =>
      log.warn({ err }, 'failed to enqueue insights job (lazy fallback will cover)'),
    );

    log.info({
      outcome,
      tool_dispatch_summary: toolSummary,
      checkout_fired: (toolSummary['send_whatsapp_checkout_link'] ?? 0) > 0,
    }, 'call-end job complete');
  },
  { connection: redisConnection },
);
```

Note the worker no longer touches `finalScore` / `stageReached` — those columns were dropped with the rest of the rules-engine remnants in migration `20260522120000`, so the `Call` row update is just `endedAt` / `outcome` / `discountGiven` / `durationSeconds`.

**Why outcome detection is "did the checkout tool fire?":** under the old rules-engine pipeline, outcome was tracked by reaching a CLOSE stage. The converse pivot deleted stages; the only ground truth left is whether the agent emitted `send_whatsapp_checkout_link` at any point in the call. Simple and unambiguous.

---

## Connecting the dots

The whole turn, in one flow:

```
Vapi OR Telnyx — STT
   │
   ▼
POST /llm/chat/completions   (legacy alias: /vapi-llm/chat/completions)
   │ ├─ detectLlmProvider → adapter (Telnyx header / Vapi body.call.id)
   │ ├─ provider.verifyLlmAuth (Vapi Bearer / Telnyx Bearer) — permissive in dev
   │ ├─ parseLlmEnvelope → { callId, phone, metadata }; parse call_mode + discount_pct
   │ ├─ ensureSessionForCall: lazy create / load from Redis (stamps voiceProvider)
   │ ├─ extract latest utterance; history from Redis session (fallback: messages[])
   │ ├─ DB-loaded product lookup (sync, in-memory map)
   │ ├─ getCachedCallContext: live customer + abandoned cart (Redis-cached, call_ctx:)
   │ └─ parallel batch: cheaper alt + premium alt (Pinecone) + getRecentTurnSignals
   │
   ▼
converseStream(... , call_mode, opening_offer_percent) → fastapi-brain /converse/stream
   │ (see 02-data-and-tools.md and 03-prompt-and-conversion.md
   │  for what happens inside the brain)
   │
   ◄── SSE: text deltas + thinking/observation events, then maybe tool_call, then done
   │
   ├─► onTextDelta → sendChunk({ content }) → OpenAI-format SSE → provider → TTS → speaker
   │                 (+ publishLive on live:<callId> for the dashboard)
   │
   ├─► onThinking → thinking-filler.ts streams a short TTS filler ("one sec —")
   │
   ├─► dispatchToolCall(tool_call) → WhatsApp side effect, clamped to ≤10%
   │
   ├─► sendChunk({}, 'stop') + 'data: [DONE]\n\n' → response complete
   │
   └─► (async, off the hot path)
        ├─ advance lastAgentFinishedAt by estimateSpeechMs (latency anchor)
        ├─ persistTurnPair: atomic Redis mutate (2 turns + pushAttempt + discount tier),
        │                   2× insertCallTurn (Postgres, w/ latency cols),
        │                   enqueue classify-analytics for the USER row
        └─ checkSpokenDiscount reconciliation (alarm on spoken > applied / cap)
```

Every architectural choice in this flow is making a tradeoff between:
- **Latency** (the provider's TTS needs the first chunk fast → streaming, parallel Pinecone, sync product lookup)
- **Durability** (call audit trail must survive failures → fire-and-forget Postgres writes, BullMQ for analytics)
- **Safety** (the agent must never give >10% off, never call rogue tools → 3 layers of validation, dispatcher clamp, spoken-discount reconciliation, fallback returns text-only)

Continue to **[02-data-and-tools.md](02-data-and-tools.md)** for the data model + observation tools, or **[03-prompt-and-conversion.md](03-prompt-and-conversion.md)** for the prompt that drives all of this.
