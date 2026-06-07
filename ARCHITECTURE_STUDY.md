# Serena — Architecture Study

> Conversion-focused **voice AI sales agent** that calls cart-abandonment customers (or fields inbound presales calls), converts them through a **single function-calling LLM with native tools**, and follows up on WhatsApp. Built as a **polyglot system** (Bun/Fastify gateway + Python/FastAPI brain + Next.js dashboard) backed by Postgres, Redis, and Pinecone, and provider-agnostic across **Vapi and Telnyx** telephony.

> 📚 **For studying the codebase with actual code excerpts, see [docs/](docs/README.md):**
> - [docs/01-runtime-flow.md](docs/01-runtime-flow.md) — per-turn flow with code (provider → gateway → brain → response)
> - [docs/02-data-and-tools.md](docs/02-data-and-tools.md) — schema, observation tools, offers system
> - [docs/03-prompt-and-conversion.md](docs/03-prompt-and-conversion.md) — system prompt, persistent probe, voice rules
>
> This file is the high-level map; the docs are the deep-dive companions.

---

## 1. Elevator pitch

When a customer leaves items in their cart, Serena dials them through Vapi **or Telnyx**, opens with their name + cart contents + a 5% call-completion discount, and lets a single GPT-4o function-calling LLM drive the whole conversation. The LLM can talk, look up real facts (inventory, reviews, delivery ETA, recent purchases, **DB-backed promotional offers**, catalog browse), or fire side-effect tools that actually send a WhatsApp checkout link. There's no rules engine, no tactic library — sales competence lives in an ~80-line system prompt + 8 tool schemas. The "brain" is stateless; all session state lives in Redis (live dialog) and Postgres (audit trail). Discounts are clamped to 10% in three independent layers (Pydantic schema → route validation → gateway dispatcher), and the agent is trained to **prefer DB-authorized bundle/quantity offers over flat discounts** — so it sounds like a real salesperson upselling, not a desperate one giving away margin.

The agent is conversion-focused, not service-focused. **PERSISTENT PROBE**: soft signals like *"just browsing"* or *"not interested"* trigger a 3-attempt push pattern (diagnostic question → value push with real reviews/offers → clean ask with reason-why) before any graceful exit. **HARD NO**: an explicit short list (*"stop calling"*, hostility, identity mismatch, true out-of-fit) ends the call immediately. The same brain runs two **call modes** — `OUTBOUND_RECOVERY` (the cart-abandon follow-up above) and `INBOUND_PRESALES` (the customer called *you*, warm, pre-purchase) — which branch the opener and the mission (see §4.10). Time-of-day, customer segment (FIRST_TIME / RETURNING / VIP / LAPSED), past order history, and cart freshness all flow into the prompt to make every call sound contextual rather than templated. A **human-feel pacing** layer goes further — the prompt adapts in real time to the customer's recent sentiment, hesitation, response latency, and disengagement signals, the agent emits thinking-aloud fillers to cover tool latency, and outbound calls are tuned for natural conversational pacing (see §4.9).

The provider runs in **Custom LLM mode**: it calls the gateway's OpenAI-compatible `/llm/chat/completions` adapter (also mounted at the legacy `/vapi-llm/chat/completions`) on every turn, the gateway routes through to the brain's `/converse/stream`, and the agent's text streams back as OpenAI-format SSE chunks. This means every phone call goes through the same converse pipeline as the type-and-talk demo — no separate code path, regardless of whether Vapi or Telnyx is driving the call.

---

## 2. High-level architecture

```
                         ┌──────────────────────────┐
   phone call ──────────►│  Vapi OR Telnyx          │  STT, TTS, call control
                         │  (telephony)             │
                         └─────┬─────┬──────────────┘
                               │     │
                  Custom-LLM   │     │  webhook events (per provider,
                  /chat/       │     │   auto-detected: assistant-request /
                  completions  │     │   call.started · call.ended ·
                               │     │   recording.ready · speech.boundary)
                               ▼     ▼
                         ┌──────────────────────────────────────┐
                         │  node-gateway   (Bun + Fastify)      │
                         │  ─ /llm  (OpenAI-compat adapter,     │
                         │     also /vapi-llm; provider-agnostic)│
                         │  ─ /webhook  (auto-detect + verify)  │
                         │  ─ voice-provider/ abstraction       │
                         │     (Vapi + Telnyx adapters)         │
                         │  ─ /calls/trigger (outbound)         │
                         │  ─ session lifecycle (Redis)         │
                         │  ─ DB-loaded product catalog         │
                         │  ─ tool dispatch (WhatsApp side fx)  │
                         │  ─ Postgres writes (Prisma)          │
                         └──┬─────────┬──────────────┬──────────┘
                            │ HTTP/SSE │ BullMQ        │ Redis live:<id>
                            ▼          ▼               ▼ pub/sub
                ┌──────────────────┐ ┌────────────────────┐ ┌────────────────┐
                │ fastapi-brain    │ │ node-worker (BullMQ)│ │ dashboard      │
                │ (Python +        │ │  ─ call-end-queue   │ │ (Next.js :4000)│
                │  FastAPI)        │ │  ─ insights-queue   │ │  ─ overview    │
                │                  │ │  ─ analytics-queue  │ │  ─ calls/live  │
                │ ─ /converse +    │ │  ─ crm-queue        │ │  ─ trigger/talk│
                │   /converse/stream│ │  ─ classify-analytics│ │  ─ insights    │
                │ ─ /classify      │ └──────────┬──────────┘ └────────────────┘
                │   (analytics-only)│           │
                │ ─ /insights/     │            │
                │   generate       │            │
                │ ─ /products/     │            │
                │   alternatives   │            │
                └────┬─────────┬───┘            │
                     │         │                │
         OpenAI GPT-4o    Pinecone              │
         (chat + tools)  (product +             │
                          objection vectors)    │
                                                │
                ┌───────────────────────────────┴──────┐
                │  PostgreSQL (Neon) via Prisma        │
                │  customers, carts, cart_items,       │
                │  products, product_reviews,          │
                │  purchases, calls, call_turns,       │
                │  call_insights, offers (BUNDLE /     │
                │  QUANTITY)                            │
                └──────────────────────────────────────┘
                     ▲
                     │ TTL session keys
                     │
                ┌─────────────────┐
                │  Redis          │  call sessions, BullMQ queues,
                │                 │  rate-limit counters, live:<id> pub/sub,
                │                 │  pending_call:<id> handoff
                └─────────────────┘
```

| Service | Tech | Port | Role |
|---|---|---|---|
| `node-gateway` | Bun + Fastify | 3000 | Provider webhook handler (Vapi + Telnyx), session state, tool dispatch, DB writes, outbound calls |
| `fastapi-brain` | Python + FastAPI + Prisma-py | 8000 | LLM orchestration (function-calling), observation tools, classifier, insights generator, vector search |
| `node-worker` | Bun + BullMQ | — | Background jobs: call-end persistence, insight generation, analytics, CRM, post-hoc objection tagging |
| `dashboard` | Next.js 15 + shadcn | 4000 | Operator cockpit: overview, calls list/detail, live-tail SSE, trigger/talk, products/offers/customers CRUD |
| `redis` | Redis 7 | 6379 | Session store, BullMQ queues, rate limits, `live:<id>` pub/sub, call-trigger handoff |
| `postgres` | Neon | — | Source of truth for customers, products, carts, calls, insights, audit trail |
| `Pinecone` | external | — | Two indexes: `voice-agent-products` (catalog), `voice-agent-objections` (classifier seeds) |

**Why split the gateway and brain?** The gateway is real-time, latency-sensitive, and lives next to telephony / Redis / Postgres. The brain is LLM-bound, slower, and benefits from Python's ML/Pydantic ecosystem (Prisma-py for observation tools, OpenAI SDK, Pinecone client). They communicate over HTTP, secured by `X-Internal-Secret` ([fastapi-brain/app/middleware/auth.py:12](fastapi-brain/app/middleware/auth.py#L12)). The streaming endpoint uses SSE so the gateway can stream the **first** text chunk straight back to the provider's TTS for low time-to-first-word.

---

## 3. The conversation lifecycle (one inbound utterance, end-to-end)

### 3.1 Call start

1. Either the provider receives an inbound call OR an operator hits `POST /calls/trigger` ([node-gateway/src/routes/calls.ts:44](node-gateway/src/routes/calls.ts#L44)). The trigger validates with Zod (E.164 phone, valid product_id, trigger reason in {cart_abandon, page_view, wishlist, manual}, optional `provider` override), enforces a Redis-counter limit of 3 calls/number/day, calls `provider.createPhoneCall(...)` (Vapi `/call/phone` or Telnyx `/v2/calls`, picked by the override or the `VOICE_PROVIDER` env — see §4.1.1), and stashes `pending_call:<callId> → { productId, triggerReason }` in Redis with a 60s TTL.
2. The provider POSTs a lifecycle webhook to `/webhook` ([webhook.ts:191](node-gateway/src/routes/webhook.ts#L191)). `detectWebhookProvider` sniffs the headers (Telnyx → `telnyx-signature-ed25519`, Vapi → `Authorization: Bearer`), the matching adapter verifies the signature, and `parseWebhook` normalizes the native payload into a `call.started` event. The handler reads `pending_call:<id>` from Redis, falls back to `metadata.product_id` or `prod-001`, and calls `ensureSessionForCall(...)` ([session.service.ts:167](node-gateway/src/services/session.service.ts#L167)) which writes a JSON-serialized `CallSession` to Redis at `session:<callId>` with a 2-hour TTL, then `createCallRecord(...)` ([db.service.ts:51](node-gateway/src/services/db.service.ts#L51)) inserts the row in Postgres (stamping the detected `voiceProvider`).
3. For Vapi's synchronous `assistant-request`, returns `{ assistantId: VAPI_ASSISTANT_ID }`. (Telnyx has no synchronous assistant handshake; its `call.initiated`/`call.answered` just create the session.)

### 3.2 Each user utterance (the hot path)

Under **Custom LLM mode**, every turn arrives at `POST /llm/chat/completions` (also mounted at the legacy `POST /vapi-llm/chat/completions`, [llm.ts](node-gateway/src/routes/llm.ts)) — the gateway acts as an OpenAI-compatible chat-completions endpoint that the provider calls per turn. `detectLlmProvider` resolves which adapter owns the request (Telnyx → `x-telnyx-call-control-id` header; Vapi → `body.call.id`). Vapi's transcript event still fires on `/webhook` but produces no normalized event, so the turn is never double-processed.

`/llm/chat/completions` flow ([llmCompletionsHandler](node-gateway/src/routes/llm.ts#L113)):

1. **Auth** — `provider.verifyLlmAuth(...)` checks the Bearer token (Vapi reuses the webhook secret; Telnyx has its own `TELNYX_LLM_SHARED_SECRET`). Dev-mode permissive (logs mismatch, doesn't reject) since tunnel URLs are obscure; tighten before prod. A callId-less request (Telnyx's portal "Validate LLM connection" button) gets a minimal OpenAI-compatible stub response so the validator passes ([llm.ts:142](node-gateway/src/routes/llm.ts#L142)).
2. **Parse envelope + lazy session** — `provider.parseLlmEnvelope(...)` extracts `callId` / phone / `metadata` (incl. `product_id`, `discount_pct`, `call_mode`). Outbound calls may not fire an init webhook first, so `ensureSessionForCall(...)` ([session.service.ts:167](node-gateway/src/services/session.service.ts#L167)) lazily creates the session from `pending_call:<id>` Redis metadata or the metadata `product_id`. Idempotent across subsequent turns.
3. **Latest utterance extraction** — pulls the last user message from the provider's `messages[]` array.
4. **Build context** — looks up the current product from the **DB-loaded catalog** (no longer hardcoded — see §4.1), fetches a **cheaper alternative AND a premium alternative in parallel** from Pinecone (both category-filtered), and loads the caller's **live customer profile + real abandoned cart** via `getCachedCallContext()` (cached per call in Redis `call_ctx:<callId>`, ~30 min TTL) plus a `getRecentTurnSignals()` snapshot — see §4.9. It also resolves this turn's **pre-response latency** (provider `speech.boundary` measurement preferred, TTS estimate as fallback — see §4.9) and reads `call_mode` + `opening_offer_percent` from metadata. Conversation history comes from the Redis session (authoritative — it holds the agent's actually-streamed text, including interrupted turns), falling back to the provider's `messages[]` only on the very first turn. The premium alt is the "anchor up" lever — the agent uses it to make the current product feel right-sized rather than expensive.
5. **Stream from the brain** — calls `converseStream(...)` ([brain.service.ts:289](node-gateway/src/services/brain.service.ts#L289)) → `fastapi-brain/converse/stream`, passing `call_mode` + `opening_offer_percent` in the `ConverseRequest`, and re-streams text deltas back to the provider as **OpenAI-format SSE chunks** (`data: {choices:[{delta:{content:"..."}}]}`). It also fires thinking-fillers during observation-tool dead-air and publishes each delta on Redis `live:<callId>` for the dashboard's live-tail.
6. **Dispatch any tool** — when the brain emits a `tool_call` event (after the agent's text streamed), `dispatchToolCall(...)` ([converse-dispatcher.ts:43](node-gateway/src/services/converse-dispatcher.ts#L43)) silently clamps `discount_percent ∈ [0,10]` and routes to `whatsapp.service.ts`. Side-effect tools are NOT forwarded to the provider as OpenAI tool_calls — the provider just speaks the text the agent already streamed ("Sending it to your WhatsApp now").
7. **Persist + emit `[DONE]`** — `persistTurnPair(...)` writes USER + AGENT turns to Postgres (with tool attribution, observation calls, push-attempt + latency columns), updates the session in Redis with the discount tier offered, enqueues `classify-analytics` for the USER row, then a `checkSpokenDiscount` reconciliation alarms on any spoken-vs-applied divergence. Finally sends `data: [DONE]\n\n` and ends the response.

### 3.3 Inside the brain (single-call function-calling LLM)

The gateway's request hits `POST /converse/stream` at [fastapi-brain/app/routes/converse.py:139](fastapi-brain/app/routes/converse.py#L139):

1. **Build inputs** ([converse.py:34](fastapi-brain/app/routes/converse.py#L34)):
   - `build_converse_system_prompt(...)` ([converse_prompt_builder.py:635](fastapi-brain/app/services/converse_prompt_builder.py#L635)) assembles the prompt: objective (mission branches on `call_mode` — see §4.10) + language/voice/disfluency rules + call-opening pattern + sales principles + adaptive-behavior block + tool guidance + customer/cart/product/alt facts + discount facts + hard constraints. The ~85-line opener block is skipped once `agent_has_spoken`. Reusable pieces (`VOICE_RULES`, `HARD_CONSTRAINTS`, `format_product`, `format_cart`, `format_customer`) live in [prompt_sections.py](fastapi-brain/app/services/prompt_sections.py).
   - `build_chat_messages(...)` takes the last 4 history turns + current utterance and shapes them as OpenAI chat messages — USER turns wrapped in `<customer_utterance>` markers (prompt-injection fence; see §5.4).
2. **Stream the LLM** via `converse_response_stream(...)` ([llm.py:135](fastapi-brain/app/services/llm.py#L135)):
   - Calls OpenAI `chat.completions.create` with `tools=OPENAI_TOOLS` ([tools.py:139](fastapi-brain/app/services/tools.py#L139)), `tool_choice='auto'`, `stream=True`, `max_tokens=250`, `temperature=0.7`.
   - Parses SSE chunks: yields `{type: 'text', delta}` for content deltas, accumulates tool-call argument fragments per index, builds parsed tool calls when complete.
   - **Observation-tool loop:** if the model called any of the 6 observation tools (`check_inventory | get_recent_purchases | get_review_summary | get_delivery_eta | get_available_offers | list_products`), the brain emits a `{type: 'thinking', tool}` event (so the gateway can fire a TTS filler — see §4.9), runs them **concurrently** (`asyncio.gather`) server-side via `execute_observation_tool(db, name, args)` ([observations.py](fastapi-brain/app/services/observations.py)) against the live Prisma client (mounted on `app.state.db` in [main.py:35](fastapi-brain/app/main.py#L35)), emits a `{type: 'observation', ...}` event with each result, appends the `tool` messages back into the conversation, and re-streams from OpenAI. Bounded by `MAX_TOOL_TURNS = 4` to prevent runaways.
   - **Side-effect tools** (`send_whatsapp_*`) end the LLM's turn and bubble up to the gateway as a single `tool_call` SSE event. If a side-effect tool fires with zero spoken text, a Hinglish confirmation is injected so the customer hears *something*.
   - The full SSE event vocabulary is therefore: `text`, `thinking`, `observation`, `tool_call`, `done`.
3. **Validate** every side-effect tool call via Pydantic (`parse_tool_call`, [tools.py:275](fastapi-brain/app/services/tools.py#L275); route guard `_validate_side_effect_tool` at [converse.py:83](fastapi-brain/app/routes/converse.py#L83)). Invalid → log `tool_call_invalid`, drop the tool, text still streams. Observation-tool leaks are dropped here too, so only the 2 WhatsApp tools ever reach the gateway.

### 3.4 Call end

The provider POSTs its end-of-call signal — Vapi's `end-of-call-report` (JSON `/webhook`) or Telnyx's `call.hangup` (JSON) / TeXML status callback (`/webhook/telnyx`) — which `parseWebhook` normalizes to a `call.ended` event ([handleCallEnded, webhook.ts:54](node-gateway/src/routes/webhook.ts#L54)). The gateway:

- Decides outcome by querying Postgres for any `call_turn` with `toolCalled = 'send_whatsapp_checkout_link'` → CONVERTED, else DROPPED (defaults to DROPPED on query failure so end-of-call processing never aborts).
- Ends the Redis session, then enqueues three BullMQ jobs with failure isolation (`runIsolated` — one failed enqueue can't silently drop the others):
  - `call-end-queue`: writes endedAt/outcome/duration to the `calls` row, bumps `Customer.priorCallsCount`, logs a `tool_dispatch_summary`, deletes the Redis session, and **enqueues an `insights-queue` job** to generate the call's `CallInsight` (§4.2).
  - `analytics-queue`: stub log (would push to Mixpanel/Segment).
  - `crm-queue`: stub log (would call CRM API).
- A separate `recording.ready` event persists the recording URLs; a `speech.boundary` event anchors response-latency (§4.9).

---

## 4. Subsystem catalog

### 4.1 `node-gateway` — orchestration & telephony glue

**Tech:** Bun runtime, Fastify, Prisma JS, BullMQ, Opossum circuit breakers, `got` HTTP client, Zod validation, tweetnacl (Ed25519 webhook verify), helmet/cors/rate-limit plugins, ioredis (BullMQ internal) + Bun's `Bun.redis` (gateway uses).

**Entry points:**

- [src/server.ts](node-gateway/src/server.ts) — boots Fastify, listens on `PORT`, handles SIGTERM/SIGINT.
- [src/app.ts](node-gateway/src/app.ts) — pings Redis (refuse to start if unreachable), loads the product catalog, registers helmet/cors/formbody, global rate-limit (300 req/min, Redis-backed via `BunRedisStore`), route plugins, error handler.
- [src/workers.ts](node-gateway/src/workers.ts) — separate process for BullMQ workers; never co-located with the HTTP server in prod (`docker-compose.yml` runs it as `node-worker`).

**Routes:**

| File | Endpoints |
|---|---|
| [routes/llm.ts](node-gateway/src/routes/llm.ts) | **`POST /llm/chat/completions` (and legacy `POST /vapi-llm/chat/completions`) — the per-turn hot path.** Provider-agnostic OpenAI-compatible adapter that Vapi or Telnyx calls in Custom LLM mode. `detectLlmProvider` picks the adapter, lazy-creates the session, reads `call_mode` + `discount_pct` from metadata, builds the brain's `ConverseRequest`, streams the brain's text-delta events back as OpenAI chunks, fires thinking-fillers, dispatches any side-effect tool, persists turns, and publishes `live:<callId>` deltas. `GET /llm/models` + `/vapi-llm/models` advertise the single `serena-converse` model for Telnyx's portal picker. Auth permissive in dev. |
| [routes/webhook.ts](node-gateway/src/routes/webhook.ts) | `POST /webhook` (JSON lifecycle events, both providers). `detectWebhookProvider` sniffs the headers, the adapter verifies the signature (Vapi Bearer `timingSafeEqual` / Telnyx Ed25519), and `parseWebhook` normalizes to `call.started`/`call.ended`/`recording.ready`/`speech.boundary`. `POST /webhook/telnyx` handles Telnyx's `application/x-www-form-urlencoded` TeXML status callbacks separately (no Ed25519). `GET /debug/session/:callId` dev-only. |
| [routes/calls.ts](node-gateway/src/routes/calls.ts) | `POST /calls/trigger` — `x-admin-secret`-gated outbound call trigger; Zod-validated; 3 calls/number/day cap; optional per-request `provider` override (else `VOICE_PROVIDER`). `GET /calls/web-config` mints the dashboard's web-call config (Vapi `public_key` vs Telnyx `jwt`/`anonymous`). `POST /calls/opener` renders a `CallMode`-aware opener. `GET /calls/by-bridge/:uuid` resolves a Telnyx web-call bridge to a callId. `GET /calls/:id/recording` re-fetches a fresh recording URL via the provider (caches `providerRecordingId`). Surfaces upstream provider errors verbatim under `details` as `PROVIDER_REJECTED`. |
| [routes/health.ts](node-gateway/src/routes/health.ts) | health/readiness probes |

#### 4.1.1 Multi-provider voice abstraction ([services/voice-provider/](node-gateway/src/services/voice-provider/))

The gateway drives either Vapi or Telnyx behind a single `VoiceProvider` interface ([types.ts:132](node-gateway/src/services/voice-provider/types.ts#L132)) — `createPhoneCall`, `getCall`, `verifyWebhook`, `parseWebhook`, `parseLlmEnvelope`, `verifyLlmAuth`, `getWebClientConfig`. Each adapter normalizes its provider's native call-create / webhook / Custom-LLM / web-client shapes into a common taxonomy (`NormalizedVoiceEvent`, `LlmRequestEnvelope`, `WebClientConfig`).

| File | Responsibility |
|---|---|
| [voice-provider/index.ts](node-gateway/src/services/voice-provider/index.ts) | Singleton registry + auto-detection. `getVoiceProvider(name)` lazily constructs + caches an adapter; `voiceProvider()` returns the active one from `config.VOICE_PROVIDER`. `detectWebhookProvider(headers)` routes by `telnyx-signature-ed25519` (Telnyx) vs `Authorization` (Vapi); `detectLlmProvider(headers, body)` routes by `x-telnyx-call-control-id` / `body.telnyx_call` (Telnyx) vs `body.call.id` (Vapi). |
| [voice-provider/vapi-provider.ts](node-gateway/src/services/voice-provider/vapi-provider.ts) | Vapi adapter. `POST /call/phone` with `assistantOverrides` (custom-llm model + pacing — see §4.9); Bearer-token webhook/LLM auth via `timingSafeEqual`; maps `assistant-request` → `call.started`, `end-of-call-report` → `call.ended` + `recording.ready`, `speech-update` → `speech.boundary`. Web config mode `public_key`. |
| [voice-provider/telnyx-provider.ts](node-gateway/src/services/voice-provider/telnyx-provider.ts) | Telnyx adapter. `POST /v2/calls` with a base64 `client_state` carrying `product_id`/`trigger_reason`/`call_mode`; Ed25519 webhook verify; maps `call.initiated`/`call.answered` → `call.started`, `call.hangup` → `call.ended`, `call.recording.saved` → `recording.ready`; `parseTexmlStatusCallback` handles the separate TeXML form path; recordings route by `v3:` call_control_id (list-filter) vs UUID (singular endpoint); web config `anonymous` (default) or `jwt` (when a DID + telephony credential are set). |
| [voice-provider/ed25519.ts](node-gateway/src/services/voice-provider/ed25519.ts) | `verifyTelnyxSignature` — `tweetnacl.sign.detached.verify` over `` `${timestamp}|${rawBody}` ``, raw 32-byte key / 64-byte sig length checks, ±300s replay window. `TELNYX_INSECURE_DEV='1'` bypasses it while wiring up a new assistant (never in prod). |

**Services:**

| File | Responsibility |
|---|---|
| [services/brain.service.ts](node-gateway/src/services/brain.service.ts) | HTTP client for `/classify`, `/converse`, `/converse/stream`, `/products/alternatives`. The three blocking calls each get a separate Opossum breaker (timeout, errorThreshold 50%, resetTimeout 30s, volumeThreshold 5); `converseStream` is a raw SSE reader (no breaker). Owns the `ConverseRequest` contract (incl. `call_mode` + `opening_offer_percent`) and the gateway-side `ToolName` type (only the 2 WhatsApp side-effect tools — observation tools run inside the brain). **Critical:** the converse fallback returns text-only ("Give me just a moment.") and **never** synthesizes a tool call — that would risk firing a WhatsApp send during a brain outage. |
| [services/converse-dispatcher.ts](node-gateway/src/services/converse-dispatcher.ts) | Translates `ConverseToolCall → side effect`. Belt-and-suspenders silent clamp on `discount_percent` ([0,10], `MAX_DISCOUNT_PERCENT`). Exhaustive `switch` over the 2 side-effect tools (TS errors if a new one is added without a case); skips with `no_product_in_session` when there's no product. |
| [services/whatsapp.service.ts](node-gateway/src/services/whatsapp.service.ts) | **Demo implementation** of `sendCheckoutLinkOnWhatsApp` (applies the discount, builds a checkout URL) and `sendProductInfoOnWhatsApp` (no checkout link — the graceful-exit variant). Logs structured events + a fake `wa_demo_` message id instead of hitting the WhatsApp Business API; swap `simulateSend` for a real fetch when going live. The function signatures are the contract. |
| [services/opener.service.ts](node-gateway/src/services/opener.service.ts) | Authoritative opener generator backing `POST /calls/opener` and the LLM endpoint's empty-utterance first turn. `INBOUND_PRESALES` returns a fixed greet; `OUTBOUND_RECOVERY` loads the live product + active `Offer` from Postgres and renders one weighted-random template from the pool — see §4.10. |
| [services/session.service.ts](node-gateway/src/services/session.service.ts) | Redis-backed `CallSession` CRUD with 2-hour TTL, JSON serialization of Date fields. `ensureSessionForCall` (idempotent lazy create, stamps `voiceProvider`), `mutateSession` (atomic read-modify-write under a per-call key-mutex), `getRecentHistory`, `endSession`. Seeds the latency anchors `agentSpeechEndedAtMs` / `pendingResponseLatencyMs` / `lastAgentFinishedAt`. |
| [services/product.service.ts](node-gateway/src/services/product.service.ts) | **Catalog loaded from Postgres at boot** via `loadCatalog()` (called in [app.ts](node-gateway/src/app.ts) before listening) into an in-memory `Map<id, Product>`. `getProductById` stays sync. Replaces the previous hardcoded array that drifted from seed data. `findAlternativeProduct(currentProductId, reason)` calls the brain's `/products/alternatives` with a **category filter** + a `direction` param: `'PRICE'` (cheaper alt) or `'PREMIUM'` (anchor-up alt), memoized per `productId:reason`. The gateway fetches both in parallel per turn. |
| [services/db.service.ts](node-gateway/src/services/db.service.ts) | Prisma writes: `createCallRecord` (persists the `voiceProvider` column), `updateCallRecord` (P2025-tolerant — orphan call-end jobs from crashed runs no longer retry forever), `insertCallTurn` (writes tool-attribution + observation + push/latency columns), `updateCallTurnAnalytics` (classify-analytics worker), `incrementCustomerCallsCount` + `getToolDispatchSummary` (call-end worker). Also `getCachedCallContext`/`loadCallContext` (live customer + abandoned-cart hydration) and `getRecentTurnSignals` (sentiment / filler / length-trend / response-latency snapshot) — see §4.9. |
| [services/thinking-filler.ts](node-gateway/src/services/thinking-filler.ts) | Short TTS fillers ("one sec, checking stock —") streamed while an observation tool runs — see §4.9. EN/HI tables, language detection, a rolling per-tool p50 suppressor (skips the filler when the tool reliably returns faster than ~280ms), suppressed when the LLM already opened with its own disfluency. |
| [lib/tts-estimate.ts](node-gateway/src/lib/tts-estimate.ts) | `estimateSpeechMs(text)` — words ÷ 165 WPM. Advances the response-latency anchor to "when the customer finished *hearing* the agent" — the fallback used when no provider `speech.boundary` event is available (§4.9). |

**Queues** ([queues/index.ts](node-gateway/src/queues/index.ts)) — five BullMQ queues, all with `attempts: 3` + exponential backoff:

- `call-end-queue` — finalizes the `Call` row, **bumps `Customer.priorCallsCount`**, **logs a `tool_dispatch_summary`** (count of side-effect tools fired during the call, e.g. `{ send_whatsapp_checkout_link: 1 }` plus a `checkout_fired: true/false` boolean), tears down the Redis session, then **enqueues an `insights-queue` job**.
- `insights-queue` — POSTs the brain's `/insights/generate` (60s timeout); throws on non-2xx so BullMQ retries transient OpenAI failures. The brain's upsert is idempotent, so the eager enqueue and the dashboard's lazy-on-first-view path are both safe (§4.2).
- `analytics-queue` — fire-and-forget logging stub (Mixpanel/Segment hook).
- `crm-queue` — fire-and-forget CRM API stub.
- `classify-analytics-queue` — **the converse pipeline's analytics-only classifier path**. Each USER turn is enqueued; the worker calls `/classify` and writes `objection_type / subtype / sentiment` back to the `call_turns` row.

**Key cross-cutting choices:**

- **BunRedisStore** for `@fastify/rate-limit` ([lib/rate-limit-store.ts](node-gateway/src/lib/rate-limit-store.ts)) — uses Bun's native Redis client.
- All env validated by Zod ([config/env.ts](node-gateway/src/config/env.ts)) with a `VOICE_PROVIDER` discriminator (`superRefine` requires the active provider's secrets); fails fast on boot.
- Logger is `pino` via Fastify's `loggerInstance`; pretty-prints in dev.
- Worker process has a DLQ monitor that logs every 5 min if any failed jobs sit in any of the five queues ([workers.ts:182](node-gateway/src/workers.ts#L182)).

### 4.2 `fastapi-brain` — LLM orchestration & observation tools

**Tech:** Python 3, FastAPI, Pydantic, Prisma-py (asyncio), OpenAI SDK (async), Pinecone client, slowapi (rate limit), structlog.

**Entry point:** [app/main.py](fastapi-brain/app/main.py) — lifespan connects Prisma to Postgres with a 5-second timeout (failure logged as a warning, not fatal); `verify_internal_secret` global dependency; request-id + structured access logging middleware.

**Routes:**

| File | Endpoints |
|---|---|
| [routes/converse.py](fastapi-brain/app/routes/converse.py) | `POST /converse` (blocking) and `POST /converse/stream` (SSE). Both build the prompt (branching on `call_mode`), run the LLM with the observation-tool loop, validate side-effect calls via Pydantic, and emit typed events. |
| [routes/classify.py](fastapi-brain/app/routes/classify.py) | `POST /classify` — used **only** by the analytics worker now. Returns `{objection_type, sentiment, confidence, subtype}`. |
| [routes/insights.py](fastapi-brain/app/routes/insights.py) | `POST /insights/generate` — on-demand call-insight writer. Loads the `Call` + its turns, asks the LLM (`response_format: json_object`) for a structured `summary / overall_sentiment / emotions / sentiment_trend / service_concerns / tags`, and upserts the `call_insights` row. Idempotent: a READY insight is returned as-is unless `regenerate=true`. `@limiter 30/minute`. |
| [routes/products.py](fastapi-brain/app/routes/products.py) | `POST /products/alternatives` — Pinecone semantic search; `direction: 'premium'` (anchor up, `min_price`) vs `'cheaper'` vs generic. |
| [routes/health.py](fastapi-brain/app/routes/health.py) | `/health`, `/ready` (auth-exempt). |

All five routers are mounted in [main.py:91-95](fastapi-brain/app/main.py#L91); every route except `/health` and `/ready` is gated by the `X-Internal-Secret` global dependency.

**Services:**

| File | Responsibility |
|---|---|
| [services/llm.py](fastapi-brain/app/services/llm.py) | The core. `converse_response_stream` and `converse_response`: streaming OpenAI client, multi-pass observation-tool loop (observation tools run **concurrently** via `asyncio.gather`), typed event yielding (`text`, `thinking`, `observation`, `tool_call`, `done`), a Hinglish spoken-fallback when a side-effect tool fires silently, error mapping to `LLMError`. `MAX_TOOL_TURNS = 4`; converse params `max_tokens=250`, `temperature=0.7`, `tool_choice='auto'`. Imports `OBSERVATION_TOOLS` from tools.py so routing never drifts. |
| [services/tools.py](fastapi-brain/app/services/tools.py) | Pydantic schemas for all **8 tools** — the single source of truth. `OPENAI_TOOLS` is the JSON-schema payload sent to OpenAI; `SIDE_EFFECT_TOOLS` (2) and `OBSERVATION_TOOLS` (6) split the set. `parse_tool_call(name, args)` validates LLM-returned args. `MAX_DISCOUNT_PERCENT = 10` enforced via `Field(ge=0, le=10)`. |
| [services/converse_prompt_builder.py](fastapi-brain/app/services/converse_prompt_builder.py) | Composes the per-call system prompt. Branches the **objective** and the **opener** on `call_mode` (`_objective` at [line 183](fastapi-brain/app/services/converse_prompt_builder.py#L183); `_inbound_opening` vs `_call_opening` chosen at [line 667](fastapi-brain/app/services/converse_prompt_builder.py#L667)) — see §4.10. Sections: objective + language/voice/disfluency rules + opening pattern (with **LAPSED + VIP segment-specific guidance**) + sales principles + **ADAPTIVE BEHAVIOR** block + tool guidance + **local-time context** (rendered when `customer.timezone` is set, e.g. *"It's 7:42pm Tuesday in their timezone — late evening, keep it brief"*) + customer/cart/product facts + cheaper alt + **premium alt anchor** + discount facts + hard constraints. The opener block is skipped once `agent_has_spoken`. The principles block carries **SALES MINDSET** (preamble), **FAST TRACK** (close immediately on unambiguous yes), **PERSISTENT PROBE** (3-attempt push pattern: diagnostic → value → clean ask before any graceful exit), **HARD NO list** (signals that bypass probing), **price-objection ladder** (reviews → DB offer → cheaper alt → flat discount), **REASON-WHY on concessions**, **CROSS-SELL from past_orders**, **HONOR preferred_contact**, and narrowly-scoped **GRACEFUL EXIT TRIGGERS**. The default identity is `agent_name='Serena'` / `business_name='Muscleblaze'`. |
| [services/prompt_sections.py](fastapi-brain/app/services/prompt_sections.py) | Reusable constants (`LANGUAGE_RULES`, `VOICE_RULES`, `DISFLUENCY_AND_HUMOR`, `HARD_CONSTRAINTS`) and formatters (`format_product`, `format_cart`, `format_customer`, `build_chat_messages`). Customer segment notes (FIRST_TIME / RETURNING / VIP / LAPSED) shape the agent's tone. `VOICE_RULES` permits **natural disfluencies** ("Got it.", "Right.", "Yeah —", "Hmm —"), **light on-brand humor**, and **interrupt handling** (finish your current word, yield, don't restart the sentence). `build_chat_messages` fences USER turns in `<customer_utterance>` markers (prompt-injection guard; see §5.4). `format_cart` derives a 5-bucket **freshness urgency cue** (`just now` / `~45 min ago` / `~3h ago` / `yesterday` / `4 days ago`) from `Cart.abandonedAt` and renders matching tone guidance into the prompt. |
| [services/observations.py](fastapi-brain/app/services/observations.py) | Implementations of the **6 observation tools** — all hit Postgres via Prisma, all defensive (return structured `error`/`unknown`, never raise). `check_inventory` (with `LOW_STOCK_THRESHOLD = 10`, tz-aware restock math), `get_recent_purchases` (count by date window), `get_review_summary` (DB-side count + avg + top positive/critical quote), `get_delivery_eta` (zip-prefix → days lookup table), **`get_available_offers`** (active BUNDLE/QUANTITY offers, batched bundle lookups, ordered by discount desc), and **`list_products`** (category summary + small list over active products). Dispatched by `execute_observation_tool(db, name, args)`. |
| [services/classifier.py](fastapi-brain/app/services/classifier.py) | Hybrid objection classifier with three modes via `settings.classifier_mode`: `pinecone` (NN with LLM fallback), `shadow` (run both, return LLM, log agreement — current default), `llm` (kill switch). Few-shot examples for the LLM path; the Pinecone path adds a fine-grained `subtype` the LLM fallback leaves null. |
| [services/objection_index.py](fastapi-brain/app/services/objection_index.py) | Pinecone-backed Tier-1 nearest-neighbor classifier; "strict win" (top-1 ≥ `classifier_top1_strict_threshold`, 0.85) or "consensus win" (top-3 same label, mean ≥ `classifier_confidence_threshold`, 0.78). Lazily initializes the index; returns the matched `subtype`. |
| [services/product.py](fastapi-brain/app/services/product.py) | Pinecone product search — `find_alternatives` (with optional `category` + `min_price` filters for premium anchoring) and `find_cheaper_alternative` (category-filtered, price < current). The `/products/alternatives` route accepts a `direction: 'cheaper' \| 'premium'` param so the gateway can pull both in one call cycle. |

**Two tool categories** (the central design idea) — **8 tools total**:

| Tool | Category | What it does |
|---|---|---|
| `send_whatsapp_checkout_link(discount_percent: 0-10)` | side-effect | Ends the turn; gateway dispatches the WhatsApp send. |
| `send_whatsapp_product_info()` | side-effect | Graceful exit; sends product details, no checkout link. |
| `check_inventory(product_id)` | observation | Returns `{in_stock, low_stock, restock_eta_days}`. |
| `get_recent_purchases(product_id, days)` | observation | Returns `{count, days}` for honest social proof. |
| `get_review_summary(product_id)` | observation | Returns count, avg rating, top positive + top critical quote. |
| `get_delivery_eta(zip_code, product_id)` | observation | Returns `{standard_days, expedited_days}` by zip prefix. |
| `get_available_offers(product_id)` | observation | Returns active BUNDLE/QUANTITY offers for the product. The agent calls this BEFORE escalating to a flat negotiation discount. |
| `list_products(category?, max_results)` | observation | Catalog browse — categories + a small product list. Used only when the customer asks broadly *"what else do you have?"*, not for the standard alt pivot. |

Side-effect tools end the turn; observation tools loop server-side and feed grounded facts back to the LLM, then it re-streams text. This is what the talking-points "real reviews, real inventory, real recent purchases, real offers" refer to — **no fabrication, the model only mentions data the tool returned**. Note: the 6 observation tools execute **inside the brain**; only the 2 WhatsApp side-effect tools ever surface to the gateway as a `ToolName`.

### 4.3 Data layer — Prisma + Postgres ([prisma/schema.prisma](prisma/schema.prisma))

Two Prisma generators run off the same schema: `prisma-client-js` for the gateway, `prisma-client-py` (asyncio) for the brain.

| Table | Purpose | Notable columns |
|---|---|---|
| `customers` | Person on the other end of the call | phone (E.164, unique), name, email, segment (FIRST_TIME/RETURNING/VIP/LAPSED), `lifetime_value`, `prior_calls_count`, timezone, `preferred_contact` |
| `carts` + `cart_items` | Abandoned carts the agent calls about | `status` (ACTIVE/ABANDONED/CONVERTED/DELETED), `abandoned_at`, line items with `price_at_add` |
| `purchases` | Past orders (powers VIP detection + social proof) | `purchased_at` indexed |
| `products` | Catalog (43 active products: chairs, proteins, apparel, accessories) | `inventory_count`, `restock_eta`, `stock_updated_at` (powers `check_inventory`); `metadata` jsonb (rich nutrition/dimensions/material data per product); `embedding_synced` flag |
| `product_reviews` | Powers `get_review_summary` | rating 1-5, body, `helpful` count |
| `offers` | DB-authorized promotional offers the agent pitches before flat discounts | `type` (BUNDLE \| QUANTITY), `discount_percent`, `bundle_product_id` (BUNDLE), `min_quantity` (QUANTITY), `short_pitch` (phone-friendly one-liner), `description`, `is_active`, `valid_until` |
| `calls` | One row per call attempt | `outcome` (CONVERTED/DROPPED/NO_ANSWER/ERROR), `duration_seconds`, `discount_given`, `voice_provider` (which adapter ran the call), `recording_url` / `stereo_recording_url` / `provider_recording_id` |
| `call_insights` | 1:1 with `calls` (PK `call_id`); the dashboard's post-call summary | `status` (PENDING/READY/FAILED), `summary`, `overall_sentiment` (POSITIVE/NEUTRAL/NEGATIVE/MIXED), `emotions[]`, `sentiment_trend`, `service_concerns` (jsonb), `tags` (jsonb), `model_used`, `fallback_used`, `prompt_tokens` / `completion_tokens`, `retry_count` |
| `call_turns` | Audit trail, one row per USER + one per AGENT utterance | `tool_called`, `tool_args` (jsonb), `observations_called` (jsonb), `objection_type`, `objection_subtype`, `sentiment` (these three populated async by the analytics worker); turn-quality signals `push_attempt` (AGENT), `response_latency_ms` (USER), `observation_latencies_ms` (jsonb, AGENT) |
| `scoring_config` | Vestigial rules-engine table, kept for backwards-compat | (no longer used in critical path) |

**Legacy columns are gone, not just dormant.** Migration `20260522120000_turn_quality_signals_and_drop_legacy` **dropped** `CallTurn.score_before` / `score_after` / `stage` and `Call.final_score` / `stage_reached` — the rules-engine / stage-machine remnants are physically removed from the schema. Outcome is derived from `tool_called`, not any score or stage. Only the `scoring_config` model/table itself survives.

**Migrations** — ten in [prisma/migrations](prisma/migrations/) (the converse pivot, the customer/cart/offers graph, the dashboard + insights support, the Telnyx provider columns, and the turn-quality / legacy-drop are the load-bearing ones):

1. `20240101000000_initial` — base schema.
2. `20260419091741_product_schema_update`.
3. `20260501000000_call_turn_tactic_attribution` — added now-removed tactic columns (`objection_subtype` survives).
4. `20260501100000_converse_tool_attribution` — **the converse pivot**: drops `tactic`, `tactic_reasoning`, `pipeline`; adds `tool_called`, `tool_args`.
5. `20260502000000_customer_cart_reviews` — added the customer/cart/review tables + product inventory snapshot.
6. `20260502100000_product_retail_price` — placeholder no-op.
7. `20260502200000_add_offers` — **the offers system**: adds `OfferType` enum and `offers` table with FKs back to `products` for both the primary and bundle product.
8. `20260518100000_dashboard_support` — adds the `call_insights` table + `OverallSentiment`/`InsightStatus` enums, the `recording_url` / `stereo_recording_url` columns on `calls`, and `observations_called` on `call_turns`.
9. `20260520000000_telnyx_provider_columns` — adds `voice_provider` + `provider_recording_id` on `calls` (the multi-provider attribution the abstraction writes).
10. `20260522120000_turn_quality_signals_and_drop_legacy` — adds `push_attempt` / `response_latency_ms` / `observation_latencies_ms` on `call_turns` AND drops the last rules-engine columns (see above).

### 4.4 Conversion playbook — offers ladder, persistent probe, graceful exit

The agent's behavioral spec lives in three intertwined principles that the prompt enforces. Together they make the agent push hard on conversion without sounding desperate or pestering.

#### 4.4.1 Offers ladder — value-add before margin erosion

The `offers` table changes the agent's behavior on price hesitation. Before: agent immediately escalated 5% → 10%. After: agent calls `get_available_offers(product_id)` and pitches a **value-add** — *"add the creatine and I can knock 5% off the whole order"* — which **increases order value** rather than just eroding margin.

| Offer type | Shape | Example |
|---|---|---|
| `BUNDLE` | Buy primary product **with** `bundle_product_id` → discount on the cart | Whey Isolate + Creatine Mono → 5% off |
| `QUANTITY` | Buy ≥ `min_quantity` of the primary product → discount | 2 tubs of Whey Concentrate → 10% off |

17 offers are seeded — protein × creatine bundles, protein × shaker bundles, protein 2× quantity, chair × mat / lumbar pillow bundles, and apparel bundles/2-packs.

The 4-step price-objection ladder:

1. **Reviews / social proof first** — `get_review_summary` quote, or `get_recent_purchases` count. *"4.7 stars from 142 buyers, one of them said …"* persuades better than 5% off.
2. **DB-backed bundle/quantity offer** — `get_available_offers` and pitch the `short_pitch` verbatim.
3. **Anchor against alternatives** — pivot to the cheaper alt OR anchor up against the premium alt to make the current product feel right-sized.
4. **Flat negotiation discount as last resort** — only escalate to 10% if steps 1-3 don't fit. Concession must be paired with a **reason-why** ("I can do 5% because you've been with us a couple years").

The agent is explicitly told **never to invent an offer** the tool didn't return. This keeps marketing in control of promotional inventory while letting the LLM pick the right pitch.

#### 4.4.2 Persistent probe — 3-attempt push pattern

Soft signals (*"no"*, *"not interested"*, *"just browsing"*, *"maybe later"*, *"not sure"*) are data, not verdicts. The agent runs a 3-attempt push before any graceful exit:

| Attempt | What the agent does |
|---|---|
| **1 — Diagnostic** | One question to surface the real concern. *"Got it — what were you thinking when you added it though?"* |
| **2 — Value push** | Given their answer, give NEW info. Quote a review, surface an offer, mention low stock, anchor an alt. Lands as new data, not counter-argument. |
| **3 — Clean ask + reason-why** | One final clear ask with a concrete justification. *"Look — I can do 5% if it's just budget, otherwise I'll send the details. Which one?"* |

After 3 push attempts that don't move the needle → graceful exit with `send_whatsapp_product_info`. Never push past three on the same call: that's where persistence becomes pestering.

#### 4.4.3 Hard-no list — bypasses probing entirely

These signals end the call immediately, no probing, no counter-offer:

- *"Stop calling me"* / *"take me off your list"* / *"do not call"*
- Direct hostility or profanity aimed at the agent
- Identity mismatch — *"wrong number"*, *"this isn't Sarah"*
- True out-of-fit — *"I already bought one yesterday"*, *"I'm not the decision maker"*, *"different country, can't ship here"*

Honest disqualification applies **only** to this list — never to hedges like *"just browsing"*. That's the difference between a sales call and a service call.

#### 4.4.4 Graceful exit triggers — narrow and explicit

Only one of these ever triggers `send_whatsapp_product_info` + end:

1. Hard-no list above (immediate)
2. Three persistent-probe attempts that produced no positive movement
3. Customer explicitly asks to end the call

### 4.5 Vector layer — Pinecone (two indexes)

- **`voice-agent-products`** (dim=1536, cosine) — embeds product description+tags. Powers `/products/alternatives`. Seeded by [scripts/embed-products.py](scripts/embed-products.py) (idempotent, re-runnable).
- **`voice-agent-objections`** — labeled utterance examples for the hybrid classifier. Seed data at [fastapi-brain/data/objection_seed.jsonl](fastapi-brain/data/objection_seed.jsonl); embedded by [scripts/embed-objections.py](scripts/embed-objections.py).

### 4.6 Cache / queue layer — Redis

- `session:<callId>` — 2-hour TTL serialized `CallSession` (gateway's source of truth during a live call).
- `call_ctx:<callId>` — 30-min TTL cache of the caller's live customer profile + abandoned cart (`getCachedCallContext` result), so Postgres is hit once per call rather than once per turn.
- `pending_call:<callId>` — 60s handoff between `/calls/trigger` and the first webhook/LLM turn (carries productId + triggerReason).
- `web_call_bridge:<uuid>` — short-TTL (300s) map from a Telnyx web-call bridge UUID to the canonical callId (lets the dashboard's Telnyx talk button resolve the call).
- `call_limit:<phone>:<date>` — daily call-cap counter (24h TTL).
- `live:<callId>` — pub/sub channel: the LLM route publishes each text delta; the dashboard's SSE route subscribes and forwards them so the live-tail streams chunk-by-chunk.
- BullMQ queues: `call-end-queue`, `insights-queue`, `analytics-queue`, `crm-queue`, `classify-analytics-queue`.
- `@fastify/rate-limit` global counters, BunRedisStore-backed.

### 4.7 Shared contracts

[shared/contracts/brain-api.types.ts](shared/contracts/brain-api.types.ts) — a re-export shell (`export * from './brain-api.generated'`) plus a hand-curated SSE event union: `ToolName` (only the 2 WhatsApp side-effect tools) and `ConverseStreamEvent` (`text | thinking | observation | tool_call | done`). The generated half, [brain-api.generated.ts](shared/contracts/brain-api.generated.ts), is produced by [scripts/gen-brain-types.py](scripts/gen-brain-types.py) (`bun run gen:types`) reflecting over [fastapi-brain/app/models/requests.py](fastapi-brain/app/models/requests.py) and [responses.py](fastapi-brain/app/models/responses.py) — `ConverseRequest`, `ConverseResponse`, `ProductContext`, `CartContext`, StrEnums, etc. **Caveats:** the generator only reflects over `requests`/`responses`, so the insights models (in `routes/insights.py`) are never emitted; and the checked-in generated file is currently **stale** — it predates `call_mode`, so it is missing the `CallMode` enum and `ConverseRequest.call_mode` until `gen:types` is re-run.

### 4.8 Scripts ([scripts/](scripts/))

| Script | Purpose |
|---|---|
| [seed.ts](scripts/seed.ts) | Legacy/minimal seeder — generates clothing-variant products only (size×color upserts). Separate from `seed-demo-data.ts`. |
| [seed-demo-data.ts](scripts/seed-demo-data.ts) | Idempotently seeds **43 products** (9 chairs/accessories, 14 nutrition products including creatine + shaker, 20 apparel size-variants), **72 reviews**, **10 customers** across all segments with carts/purchases, and **17 promotional offers**. Proteins are generated from a per-type fingerprint that scales realistic per-100g amino-acid profiles to actual scoop sizes — so a 30g whey-isolate scoop has 27g protein and 6.1g BCAAs while a 30g pea-isolate scoop has 24g protein and 4.3g BCAAs. **This is what powers the interactive CLI and eval suite.** |
| [gen-brain-types.py](scripts/gen-brain-types.py) | Pydantic→TypeScript contract generator (`bun run gen:types`) — see §4.7. |
| [cleanup-non-serena-products.py](scripts/cleanup-non-serena-products.py) | Defensive — marks every product NOT in the Serena allowlist as `isActive=false`. Useful when the DB picks up junk from a prior project. |
| [embed-products.py](scripts/embed-products.py) | **Wipes Pinecone first**, then reads active products from DB, generates OpenAI embeddings, upserts into the product index. Idempotent and stale-resistant. |
| [embed-objections.py](scripts/embed-objections.py) | Same pattern, for the objection classifier index. |
| [interactive-cli.py](scripts/interactive-cli.py) | **Type-and-talk demo CLI.** Loads a customer + their cart from the seeded DB, drops you into a chat with the agent. Runs the real LLM and the observation tools (live DB queries). Commands: `/list /switch /state /reset /exit`. (Its docstring still lists only 4 observation tools and it defaults to the older Alex/ShopEase persona — stale relative to the live pipeline.) |
| [run-eval.py](scripts/run-eval.py) | Eval suite runner — drives the canonical scenarios in [fastapi-brain/eval/scenarios.jsonl](fastapi-brain/eval/scenarios.jsonl) (22 lines), captures responses + tool calls, applies two layers of scoring: (1) **heuristic invariants** from the scenario (right tool fired, forbidden phrase not used, opener mentions name/business/cart, persistent-probe pattern correct, etc.), (2) **gpt-4o-mini judge** scores 1-5 with reasoning. Outputs JSON to `eval-results/`. (The scenarios still assert the old `alex`/`shopease` persona while the prompt builder now defaults to Serena/Muscleblaze — opener heuristics mismatch unless overridden.) |
| [simulate-call.ts](scripts/simulate-call.ts) | End-to-end gateway test — POSTs a Vapi-shaped `assistant-request`, then 5 scripted utterances that walk the agent through the full converse pipeline (cold open → quality concern → inventory question → price pushback → bundle accept → checkout). Polls `/debug/session` to print agent responses + state per turn. No Vapi account required; Vapi-shaped only (no Telnyx variant). |
| [smoke-test-classifier.py](scripts/smoke-test-classifier.py), [smoke-test-generate-tactic.py](scripts/smoke-test-generate-tactic.py) | **Both dead** — they import `decision.py` / `speech_prompt_builder.py` / `llm.generate_response`, all removed in the converse refactor. They will crash on import; remove from any "how to test" list. |

### 4.9 Human-feel pacing

A cross-cutting layer that makes the agent sound like a person on a real call rather than a templated bot. Six pieces:

**Live customer + cart context.** `getCachedCallContext(callId, phoneNumber)` ([db.service.ts](node-gateway/src/services/db.service.ts)) hydrates the real customer profile (segment, lifetime value, past orders) and the most-recent **abandoned cart** (items, total, `abandoned_minutes_ago`) from Postgres. The gateway caches the result per call in Redis (`call_ctx:<callId>`, 30-min TTL) so it hits Postgres once per call, not once per turn, and passes it to the brain as `customer_context` / `cart_context`. When a call was triggered without an explicit `product_id`, the gateway also adopts the cart's first product as `currentProductId`.

**Sentiment- and latency-adaptive behavior.** `getRecentTurnSignals(callId, 3)` reads the last few USER turns and derives a `RecentUserSignals` snapshot: `sentiments[]` (from the async classify-analytics tags), `filler_density` (hesitation tokens/phrases), `length_trend` (linear-regression slope of utterance lengths — negative means disengaging), and `repeated_objection` (same `objection_type` twice in a row). The gateway layers two session-derived signals on top before sending: `push_attempt` (from session state) and `response_latency_ms` (the gap it just measured for this turn). The brain's `converse_prompt_builder._adaptive_behavior()` turns those into an in-context **ADAPTIVE BEHAVIOR** block — a `push_attempt` 1→5 persistence ladder, soften and shorten on a negative streak, slow down + ask a diagnostic on high filler density, switch tactic on a repeated objection, and latency-band cues (`<500ms` visceral / `>5000ms` distracted / `1500-3500ms` considering). It's inserted between the principles and tool guidance so the model reads it as a situational override, not a hard rule. (The signal math lives entirely in the gateway — the brain's old `signals.py` was removed.)

**Thinking fillers.** Observation tools cost a Postgres round-trip (~200–700 ms). Before awaiting one, the brain emits a `{type: 'thinking', tool}` SSE event; the gateway's [thinking-filler.ts](node-gateway/src/services/thinking-filler.ts) responds by streaming a short TTS-bound phrase ("one sec, checking stock —" / Hindi "ek second, stock dekh leti hoon —") so the customer never hears dead air. Filler language is sniffed from the caller's actual utterance (Devanagari + Romanized-Hindi tokens), falling back to timezone. It is suppressed when the LLM's own text already opened with a disfluency cue, or when the tool's rolling p50 latency is fast enough (`<280ms` over ≥3 samples) that the filler would land *after* the result and just sound robotic.

**Provider-measured response latency.** Pre-response latency (the customer's think-time between the agent finishing and the user replying) is anchored on the provider's `speech.boundary` webhook events when available — `handleSpeechBoundary` ([webhook.ts:131](node-gateway/src/routes/webhook.ts#L131)) sets `agentSpeechEndedAtMs` on the agent-stopped event and computes `pendingResponseLatencyMs` on the user-started event. When no `speech.boundary` is available (Telnyx currently emits none, so Telnyx calls always take this path), the gateway falls back to `estimateSpeechMs` (165 WPM, [lib/tts-estimate.ts](node-gateway/src/lib/tts-estimate.ts)) to advance the anchor to "when the customer finished hearing the agent." The measured value is persisted as `CallTurn.responseLatencyMs` and fed back to the brain as `recent_user_signals.response_latency_ms`.

**Voice tuning.** Outbound Vapi calls ([vapi-provider.ts](node-gateway/src/services/voice-provider/vapi-provider.ts), `ASSISTANT_PACING`) send `assistantOverrides` tuned for a sales call: `silenceTimeoutSeconds: 12`, `responseDelaySeconds: 0.4`, `numWordsToInterruptAssistant: 2`, `backchannelingEnabled: true`, and `endCallPhrases` (EN + Hindi). Voice selection is timezone-aware — `VAPI_VOICE_HI` for `Asia/Kolkata` / `Asia/Calcutta`, else `VAPI_VOICE_EN` — and a `custom-llm` model override pointing at `VAPI_CUSTOM_LLM_URL` is wired in.

**New prompt blocks.** `prompt_sections.py` carries `LANGUAGE_RULES` (mirror the customer's language; emit **Romanized** Hindi only — the TTS engine mispronounces Devanagari) and `DISFLUENCY_AND_HUMOR` (thinking-aloud openers, soft acknowledgments, ≤1 joke/call). `converse_prompt_builder._objective()` defines the agent as explicitly **female**, with detailed Hindi feminine-verb-form rules. The full per-call composition order: objective → LANGUAGE_RULES → VOICE_RULES → DISFLUENCY_AND_HUMOR → call-opening (skipped once `agent_has_spoken`) → principles → ADAPTIVE BEHAVIOR (conditional) → tool guidance → local-time → customer → cart → product/alts → discounts → HARD_CONSTRAINTS.

### 4.10 Call modes — outbound recovery vs inbound presales

The same brain serves two call modes, carried end-to-end as `call_mode` (`CallMode` enum, default `OUTBOUND_RECOVERY`):

- **`OUTBOUND_RECOVERY`** — the cart-abandon follow-up. The agent opens cold against the abandoned cart + the call-completion discount, and its mission is to *convert the cart or exit gracefully*.
- **`INBOUND_PRESALES`** — the customer called *you*, warm, before buying. The opener drops the cold pitch and abandoned-cart reference; the mission is to *understand what they need, answer honestly, build confidence, and guide them to the right purchase*.

`call_mode` flows from the trigger metadata (Vapi `metadata.call_mode` / Telnyx `X-Call-Mode` custom header → `extra_metadata`), is parsed in [llm.ts:239](node-gateway/src/routes/llm.ts#L239) (only the two known values forwarded, else null → brain default), and reaches `build_converse_system_prompt(call_mode=...)` where it branches both the **objective** (`_objective`, [converse_prompt_builder.py:183](fastapi-brain/app/services/converse_prompt_builder.py#L183)) and the **opener** (`_inbound_opening` vs `_call_opening`, chosen at [line 667](fastapi-brain/app/services/converse_prompt_builder.py#L667)). The gateway's own `opener.service.ts` (`generateOpener`) and `POST /calls/opener` branch on the same `CallMode`. It is **request-only** — there is no `call_mode` column persisted on the `Call` row. A separate `opening_offer_percent` (default 5, clamped 0-10) rides alongside it to carry the opener's call-completion discount.

### 4.11 `dashboard` — operator cockpit (Next.js)

A Next.js 15 App Router app (server components + a few client islands, port 4000) for operating the agent: overview cockpit (KPIs, daily/hourly charts, top objections/products/tools, Tool-ROI), calls list/detail, live-tail, trigger/talk pages, and content CRUD (products/offers/customers). Reads come straight from Postgres via Prisma ([lib/db-queries.ts](dashboard/src/lib/db-queries.ts)); writes/side-effects proxy to the gateway ([lib/gateway.ts](dashboard/src/lib/gateway.ts), `X-Admin-Secret`) and to the brain (insights routes, `X-Internal-Secret`).

It is **multi-provider aware**: a header `ProviderSelector` writes a `serena_voice_provider` cookie that `lib/provider.ts` resolves server-side, the calls/detail views render a `PlatformBadge` from `Call.voiceProvider`, and the Talk page renders provider-specific Vapi (`@vapi-ai/web`) or Telnyx (`@telnyx/ai-agent-lib`) web-call buttons. Both web-call buttons expose an Inbound/Outbound toggle and forward `call_mode`. The **live-tail** ([api/live/[callId]/stream/route.ts](dashboard/src/app/api/live/%5BcallId%5D/stream/route.ts)) is a 1.5s Postgres poll plus a Redis subscription to the gateway's `live:<callId>` channel, emitting user/agent turns, tool-call + observation chips, and the turn-quality signals (`responseLatencyMs`, `pushAttempt`, `discountOffered`). The **insights panel** polls [api/calls/[callId]/insights/route.ts](dashboard/src/app/api/calls/%5BcallId%5D/insights/route.ts) (which fires brain generation and auto-heals stale PENDING rows after 90s) with a regenerate button. Auth is an HMAC-signed `ff_dash_session` cookie ([lib/auth.ts](dashboard/src/lib/auth.ts)) with a cheap edge-middleware shape check.

---

## 5. Cross-cutting policies

### 5.1 Defense-in-depth on discount enforcement

| Layer | Mechanism | File |
|---|---|---|
| **Schema** | Pydantic `Field(ge=0, le=10)` on `SendCheckoutLinkArgs.discount_percent` — surfaces the cap to the LLM via the JSON schema in tool definitions | [tools.py:33](fastapi-brain/app/services/tools.py#L33) |
| **Route validation** | `/converse` re-validates with Pydantic (`_validate_side_effect_tool`); invalid → log `tool_call_invalid` and drop the tool (text still streams) | [converse.py:83](fastapi-brain/app/routes/converse.py#L83) |
| **Gateway dispatcher** | Silent clamp `Math.min(10, Math.max(0, n))` immediately before the WhatsApp call — last line of defense | [converse-dispatcher.ts:40](node-gateway/src/services/converse-dispatcher.ts#L40) |

Beyond the clamp, the LLM route runs a `checkSpokenDiscount` reconciliation ([discount-guard.ts](node-gateway/src/services/discount-guard.ts)) after each turn: it parses the discount the agent *spoke* in free text and alarms when it exceeds either the cap or what the link actually applied — a verbal-commitment liability that can't be un-spoken.

### 5.2 Resilience

- **Circuit breakers** (Opossum) on the brain's blocking calls — `classify`, `converse`, `products/alternatives` — each with an explicit fallback. The `converse` fallback returns text-only ("Give me just a moment.") and **never synthesizes a tool call** — preventing rogue WhatsApp sends during brain outages. (The streaming `/converse/stream` path is a raw SSE reader, not breaker-wrapped; the LLM route catches its failures directly.)
- **SSE → text fallback:** if `converseStream` fails mid-turn, the LLM route streams "Give me just a moment." and closes the SSE cleanly. Tool calls are never synthesized in these paths.
- **Atomic session mutation** — concurrent turns serialize their read-modify-write on the session via a per-call in-process key-mutex (`mutateSession` / `withKeyLock`), so racing turns can't clobber `pushAttempt` / `turnCount`.
- **Failure-isolated end-of-call enqueues** — `runIsolated` (`Promise.allSettled` fan-out) so one failed BullMQ add can't silently drop the others (the webhook 200s and the provider won't retry).
- **DLQ monitor** in workers.ts logs every 5 min if any of the five queues has failed jobs.
- **Brain's observation-tool loop** is bounded by `MAX_TOOL_TURNS = 4`.
- **Session TTL** (2h) prevents Redis leaks if a call dies mid-conversation.

### 5.3 Provider integration mode (Vapi + Telnyx)

Both providers run in **Custom LLM mode** with the gateway as the LLM provider. The active default is the `VOICE_PROVIDER` env (`vapi` | `telnyx`, default `vapi`); the dashboard and `/calls/trigger` can pass a per-request override. The LLM and webhook routes auto-detect the provider per request (`detectLlmProvider` / `detectWebhookProvider`), so a single deployment can serve both.

| Provider field | Vapi | Telnyx |
|---|---|---|
| Custom-LLM URL | `https://<host>/llm` (also `/vapi-llm`); provider appends `/chat/completions` | `https://<host>/llm/chat/completions` |
| Custom-LLM auth | Bearer `VAPI_WEBHOOK_SECRET` | Bearer `TELNYX_LLM_SHARED_SECRET` |
| Lifecycle webhook | `https://<host>/webhook` (Bearer-verified) | `https://<host>/webhook` (Ed25519) + `/webhook/telnyx` (TeXML status) |
| Webhook secret | `VAPI_WEBHOOK_SECRET` | `TELNYX_PUBLIC_KEY` (Ed25519 verify) |

This is what makes phone calls run through the same converse pipeline as the type-and-talk CLI: the provider sends OpenAI-format chat-completions requests per turn, the matching adapter translates to/from `ConverseRequest`/SSE, and the brain's behavior is identical regardless of transport or provider.

Vapi's `assistant-request` doesn't fire on outbound calls (Vapi already has the `assistantId` from `/calls/trigger`), and Telnyx has no synchronous assistant handshake at all, so `/llm` lazily creates the session on first request — pulling product context from `pending_call:<id>` Redis metadata that `/calls/trigger` set.

### 5.4 Security

- **Internal-service auth:** every brain call carries `X-Internal-Secret`, validated with `secrets.compare_digest` ([auth.py:12](fastapi-brain/app/middleware/auth.py#L12)).
- **Webhook auth (per provider):** Vapi's Bearer secret is verified with `crypto.timingSafeEqual`; Telnyx webhooks are verified with **Ed25519** (`tweetnacl.sign.detached.verify` over `` `${timestamp}|${rawBody}` ``, ±300s replay window) — [voice-provider/ed25519.ts:20](node-gateway/src/services/voice-provider/ed25519.ts#L20). A `TELNYX_INSECURE_DEV='1'` escape hatch bypasses Telnyx verification while wiring up a new assistant (never in prod); the TeXML `/webhook/telnyx` path is currently unverified.
- **Admin auth:** `x-admin-secret` (separate from internal secret), timing-safe-compared, on the `/calls/*` admin surface.
- **Helmet + CORS** on the gateway.
- **Rate limits:** global 300/min, per-call 10/10s on webhook (keyed on the call id), daily 3/number on outbound trigger; brain endpoints rate-limited via slowapi (`/converse` + `/classify` 60/min, `/insights/generate` 30/min).
- **Prompt-injection guard** — USER turns are fenced in `<customer_utterance>` markers (`build_chat_messages`) and `HARD_CONSTRAINTS` instructs the model to treat fenced text as data only, never as instructions ([prompt_sections.py:126](fastapi-brain/app/services/prompt_sections.py#L126)).

---

## 6. The "converse pivot" — the architectural inflection point worth talking about in interviews

[CONVERSION_ENGINE.md](CONVERSION_ENGINE.md) explains it: an earlier version of Serena had a **rules engine + 16-tactic library + speech-prompt-builder** pipeline. Every conversational edge case demanded a new tactic, new rule, new tests — 10 PRs in 24 hours patching behavior. That whole pipeline (`decision.py`, `tactics.py`, `decide.py` route, `prompt_builder.py`, `speech_prompt_builder.py`, `decide-request.builder.ts`, `scoring.service.ts`, `stage.service.ts`, `negotiation.service.ts`, `signals.ts`, `vapi-llm.ts`, `admin.ts` and their tests — about ~1500 LOC) was deleted.

It was replaced with ~600 LOC: a single function-calling LLM call per turn (`converse_response_stream`), a tool registry (now 8 definitions), an observation-tool loop, and an analytics-only classifier worker. The LLM decides whether to talk, look something up, or fire a side effect. Sales competence lives entirely in the system prompt + tool schemas.

**Schema impact:** the migration [20260501100000_converse_tool_attribution](prisma/migrations/20260501100000_converse_tool_attribution/migration.sql) drops `tactic`, `tactic_reasoning`, `pipeline` from `call_turns` and adds `tool_called`, `tool_args` (jsonb). Outcome detection shifted from "did we reach a CLOSE stage?" to "did the LLM ever fire `send_whatsapp_checkout_link`?" ([handleCallEnded, webhook.ts:54](node-gateway/src/routes/webhook.ts#L54)). The last score/stage columns were dropped later, in `20260522120000` (§4.3).

---

## 7. Build / run / dev

- `make setup` → copy `.env.example`, `bun install`, `uv sync`, start Redis, generate Prisma clients (both JS + Py), `prisma migrate deploy`, `seed`. **Note:** the committed `.env.example` is stale — it documents only the Vapi vars and omits the entire `VOICE_PROVIDER` + `TELNYX_*` block (`config/env.ts` is the source of truth).
- `make dev` → `docker-compose up` (redis + node-gateway + fastapi-brain + node-worker).
- `bun run dev:all` (`scripts/dev-all.sh`) → the full local stack: Redis (docker), brain (uvicorn :8000), gateway (bun :3000), BullMQ worker, and the **Next dashboard** (:4000), via `concurrently`. The lighter `bun run dev` boots only gateway + brain.
- Regenerate the shared TS contract: `bun run gen:types` (see §4.7).
- `make simulate-call` → end-to-end script against the gateway (5 scripted utterances, no Vapi account required).
- `make test` → `bun test` (gateway unit tests) + `pytest` (brain unit + integration).
- Type-and-talk: `bun run scripts/seed-demo-data.ts && uv run python scripts/interactive-cli.py [+phone]`.
- Eval: `uv run python scripts/run-eval.py [--scenario X] [--no-judge]` over the 22 canonical scenarios in `fastapi-brain/eval/scenarios.jsonl`.

---

## 8. How to talk about this in an interview (one suggested pitch)

> "Serena is a voice AI sales agent that calls cart abandoners (or fields inbound presales calls) and converts them. A Bun/Fastify gateway, a Python/FastAPI brain, and a Next.js operator dashboard — and it's provider-agnostic across Vapi and Telnyx behind one `VoiceProvider` interface, with per-request auto-detection and Ed25519 webhook verification for Telnyx. The interesting design call was replacing a brittle rules-engine + tactic-library with a single function-calling LLM. The model gets a system prompt with sales principles (FAST TRACK on a clear yes, PERSISTENT PROBE — push 2-3 times before any graceful exit, reviews-before-discount, DB-offers-before-flat-discount, reason-why on every concession, an explicit hard-no list that bypasses probing), eight tool definitions, and the live customer/cart context — including time-of-day, segment-aware opener guidance, and cart freshness. The same prompt branches on a call_mode for inbound presales vs outbound recovery. The LLM decides whether to talk, observe (real reviews, inventory, recent purchases, bundle/quantity offers, catalog browse — all from the DB), or fire a side effect like sending a WhatsApp checkout link. The provider runs in Custom LLM mode and calls our `/llm/chat/completions` adapter on every turn, so the phone path and the type-and-talk path go through the exact same brain. The agent doesn't throw discounts at the customer — it pushes 3 times with diagnostic + value + clean-ask before backing off; on price specifically, it surfaces a real reviewer's quote, then a value-add bundle (*'add the creatine and I can knock 5% off the whole order'*), then anchors against alternatives; only then does it escalate to the flat 10% ceiling. Discounts are clamped in three independent layers — Pydantic schema, route validation, gateway dispatcher — plus a spoken-vs-applied reconciliation alarm. State lives in Redis (live session, 2h TTL) and Postgres (audit trail with `tool_called` + `tool_args` + turn-quality latency signals, plus an end-of-call `tool_dispatch_summary` and an LLM-written call insight). Eval suite of canonical scenarios catches regressions when I tweak the prompt."

Pick whichever subsystem the interviewer pulls on — the converse loop, the multi-provider voice abstraction, the Custom-LLM adapter pattern, the persistent-probe ladder, the offers-first discount ladder, the observation-tool category, the defense-in-depth on discounts, the response-latency telemetry, the eval harness, or the rules-engine → LLM migration are all good landing spots.
