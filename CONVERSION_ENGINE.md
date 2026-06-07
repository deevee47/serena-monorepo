# Serena — Conversion Engine

> Voice agent that calls cart abandoners (or fields inbound presales calls) and
> converts them through a single function-calling LLM with native tools.
> Vapi **or** Telnyx (telephony) → node-gateway (orchestration) → fastapi-brain
> (LLM) → Postgres + Pinecone + Redis.

---

## Architecture

```
USER utterance
    │  Vapi OR Telnyx (Custom LLM mode) POSTs it per-turn to:
    ▼
node-gateway  POST /llm/chat/completions  (legacy /vapi-llm/chat/completions)
    │  (the OpenAI-compatible adapter, provider-agnostic. detectLlmProvider
    │   picks the Vapi/Telnyx adapter per request. Vapi's transcript webhook
    │   events still arrive on /webhook but are intentionally ignored.)
    │
    ├──► load live customer + abandoned-cart context + recent-turn signals
    │       + read call_mode (INBOUND_PRESALES | OUTBOUND_RECOVERY) from metadata
    │
    ├──► /converse/stream  (single OpenAI chat.completions call with 8 tools)
    │       inputs: history + system prompt (objective branches on call_mode +
    │               voice/language/disfluency rules + opening + sales principles +
    │               adaptive-behavior block + product/cart/customer facts +
    │               tool schemas)
    │       output: SSE events {type:'text'|'thinking'|'observation'|'tool_call'|'done'}
    │
    ├──► text deltas → re-streamed to the provider as OpenAI chunks (low time-to-first-word)
    │
    ├──► thinking event → thinking-filler.ts streams a short TTS filler
    │
    ├──► tool_call event → converse-dispatcher → whatsapp.service.ts
    │       silent clamp on discount_percent ∈ [0, 10]
    │
    └──► persist USER+AGENT turns to Postgres
            ├── AGENT row gets `tool_called`, `tool_args` if any
            └── enqueue `classify-analytics` BullMQ job for the USER row
                  (background classifier writes objection_type/sentiment later)
```

**Single LLM call per turn.** The model decides whether to talk, call a tool,
or both. No rules engine. No tactic library. Sales competence lives in a
~80-line system prompt + tool definitions.

**Provider-agnostic telephony.** The gateway drives either Vapi or Telnyx
behind one `VoiceProvider` interface ([voice-provider/](node-gateway/src/services/voice-provider/)),
selected by the `VOICE_PROVIDER` env (default `vapi`) and auto-detected per
request. The converse pipeline below is identical regardless of which provider
is on the line — see [the voice-provider abstraction](#multi-provider-voice-abstraction).

---

## What's where

### Brain (`fastapi-brain/`)

| File | Purpose |
|---|---|
| [app/services/converse_prompt_builder.py](fastapi-brain/app/services/converse_prompt_builder.py) | Builds the per-call system prompt (objective + language/voice/disfluency rules + opening + principles + adaptive-behavior block + tool guidance + customer/cart/product/discount facts + hard constraints). Branches the objective (`_objective`) and the opener (`_inbound_opening` vs `_call_opening`) on `call_mode` |
| [app/services/prompt_sections.py](fastapi-brain/app/services/prompt_sections.py) | Reusable helpers: `LANGUAGE_RULES`, `VOICE_RULES`, `DISFLUENCY_AND_HUMOR`, `HARD_CONSTRAINTS`, `format_product`, `format_cart`, `format_customer`, `build_chat_messages` |
| [app/services/tools.py](fastapi-brain/app/services/tools.py) | All 8 tool schemas, Pydantic-validated — 2 side-effect (`send_whatsapp_checkout_link`, `send_whatsapp_product_info`) + 6 observation (`check_inventory`, `get_recent_purchases`, `get_review_summary`, `get_delivery_eta`, `get_available_offers`, `list_products`) |
| [app/services/observations.py](fastapi-brain/app/services/observations.py) | The 6 observation-tool implementations (Prisma queries against the live DB), dispatched by `execute_observation_tool(db, name, args)` |
| [app/services/llm.py](fastapi-brain/app/services/llm.py) | `converse_response_stream` yields typed events; tool args are accumulated server-side and emitted as one parsed `tool_call` event |
| [app/routes/converse.py](fastapi-brain/app/routes/converse.py) | `POST /converse` and `POST /converse/stream`. Validates LLM tool args via Pydantic and silently drops malformed calls (logged) |
| [app/routes/insights.py](fastapi-brain/app/routes/insights.py) | `POST /insights/generate` — on-demand call-insight writer (LLM-summarized `summary`/`sentiment`/`tags`), upserts the `call_insights` row idempotently |
| [app/services/classifier.py](fastapi-brain/app/services/classifier.py) | Pinecone hybrid classifier — runs **only** as analytics from a BullMQ worker now, never in the response path |
| [app/services/objection_index.py](fastapi-brain/app/services/objection_index.py) | Pinecone search backing the classifier |

### Gateway (`node-gateway/`)

| File | Purpose |
|---|---|
| [src/routes/llm.ts](node-gateway/src/routes/llm.ts) | The per-turn hot path (Custom LLM mode, mounted at `/llm/chat/completions` + legacy `/vapi-llm/chat/completions`): `detectLlmProvider` picks the adapter → lazy session → load live customer/cart context + recent-turn signals + read `call_mode` → build `ConverseRequest` → `converseStream` → re-stream text deltas as OpenAI chunks, emit thinking fillers → dispatch any side-effect tool → persist turns → enqueue `classify-analytics` |
| [src/routes/webhook.ts](node-gateway/src/routes/webhook.ts) | Provider lifecycle events (auto-detected + signature-verified): `call.started` / `call.ended` / `recording.ready` / `speech.boundary`. Transcript events arrive here too but are intentionally ignored under Custom LLM mode. `POST /webhook/telnyx` handles Telnyx's TeXML status callbacks; `GET /debug/session/:callId` (dev) |
| [src/services/voice-provider/](node-gateway/src/services/voice-provider/) | The multi-provider abstraction — `VoiceProvider` interface ([types.ts](node-gateway/src/services/voice-provider/types.ts)) implemented by `vapi-provider.ts` and `telnyx-provider.ts`. [index.ts](node-gateway/src/services/voice-provider/index.ts) holds `getVoiceProvider` / `voiceProvider` / `detectWebhookProvider` / `detectLlmProvider`; [ed25519.ts](node-gateway/src/services/voice-provider/ed25519.ts) verifies Telnyx webhook signatures |
| [src/services/brain.service.ts](node-gateway/src/services/brain.service.ts) | `converse()` and `converseStream()` clients with Opossum circuit breakers. **Fallback returns text-only** — never synthesizes a tool call (would risk a real WhatsApp send on a brain outage) |
| [src/services/converse-dispatcher.ts](node-gateway/src/services/converse-dispatcher.ts) | Tool-name → side-effect routing. Belt-and-suspenders silent clamp on `discount_percent` |
| [src/services/whatsapp.service.ts](node-gateway/src/services/whatsapp.service.ts) | Demo `sendCheckoutLinkOnWhatsApp` and `sendProductInfoOnWhatsApp`. Logs structured events; swap `simulateSend` for a real WhatsApp Business API call when ready |
| [src/lib/tts-estimate.ts](node-gateway/src/lib/tts-estimate.ts) | `estimateSpeechMs(text)` — words ÷ 165 WPM. The response-latency-anchor fallback when no provider `speech.boundary` event is available (Telnyx emits none) |
| [src/queues/index.ts](node-gateway/src/queues/index.ts) | `classifyAnalyticsQueue` for fire-and-forget classifier tagging; `insightsQueue` (the 5th queue) for post-call insight generation |
| [src/workers.ts](node-gateway/src/workers.ts) | `classifyAnalyticsWorker` calls `/classify` then `updateCallTurnAnalytics` to populate `objection_type`/`subtype` on the row; `insightsWorker` POSTs the brain's `/insights/generate` to write the `CallInsight` |

### Schema

| Table | Notable columns |
|---|---|
| `call_turns` | `tool_called`, `tool_args` (jsonb), `objection_type`, `objection_subtype`, `sentiment` (last three populated async) |
| `calls` | unchanged |

Migration: [prisma/migrations/20260501100000_converse_tool_attribution/](prisma/migrations/20260501100000_converse_tool_attribution/migration.sql) — drops `tactic`, `tactic_reasoning`, `pipeline`; adds `tool_called`, `tool_args`.

---

## Multi-provider voice abstraction

<a id="multi-provider-voice-abstraction"></a>

The telephony layer is **provider-agnostic**: the gateway drives either Vapi or
Telnyx behind a single `VoiceProvider` interface
([voice-provider/types.ts](node-gateway/src/services/voice-provider/types.ts)) —
`createPhoneCall`, `getCall`, `verifyWebhook`, `parseWebhook`, `parseLlmEnvelope`,
`verifyLlmAuth`, `getWebClientConfig`. Each adapter normalizes its provider's
native call-create / webhook / Custom-LLM shapes into a common taxonomy, so the
converse pipeline never sees a provider-specific payload.

- **Selection** — the active provider is the `VOICE_PROVIDER` env (`vapi` |
  `telnyx`, default `vapi`, validated by a Zod enum in
  [config/env.ts](node-gateway/src/config/env.ts)); `/calls/trigger` can pass a
  per-request `provider` override.
- **Auto-detection** — `detectWebhookProvider(headers)` routes by
  `telnyx-signature-ed25519` (Telnyx) vs `Authorization: Bearer` (Vapi);
  `detectLlmProvider(headers, body)` routes by `x-telnyx-call-control-id` (Telnyx)
  vs `body.call.id` (Vapi). One deployment serves both.
- **Webhook auth** — Vapi uses a Bearer secret (`timingSafeEqual`); Telnyx uses
  **Ed25519** ([ed25519.ts](node-gateway/src/services/voice-provider/ed25519.ts)):
  `tweetnacl.sign.detached.verify` over `` `${timestamp}|${rawBody}` ``, with a
  ±300s replay window.

The `Call.voice_provider` column records which adapter ran each call. Everything
downstream of `/llm/chat/completions` — context loading, the brain's converse
loop, tool dispatch — is identical regardless of which provider is on the line.

---

## Call modes — outbound recovery vs inbound presales

The same brain serves two call modes, carried end-to-end as `call_mode`
(`CallMode` StrEnum in [requests.py](fastapi-brain/app/models/requests.py),
default `OUTBOUND_RECOVERY`):

- **`OUTBOUND_RECOVERY`** — the cart-abandon follow-up. The agent opens cold
  against the abandoned cart + the call-completion discount; the mission is to
  *convert the cart or exit gracefully*.
- **`INBOUND_PRESALES`** — the customer called *you*, warm, before buying. The
  opener drops the cold pitch and abandoned-cart reference; the mission is to
  *understand what they need, answer honestly, and guide them to the right
  purchase*.

`call_mode` flows from the trigger/talk metadata into the gateway, where
[llm.ts](node-gateway/src/routes/llm.ts) parses it (only the two known values are
forwarded; anything else → null → brain default) and passes it on the
`ConverseRequest`. In the brain, `build_converse_system_prompt(call_mode=...)`
branches both the **objective** (`_objective`) and the **opener**
(`_inbound_opening` vs `_call_opening`) in
[converse_prompt_builder.py](fastapi-brain/app/services/converse_prompt_builder.py).
It's **request-only** — there's no `call_mode` column on the `Call` row. A
separate `opening_offer_percent` (default 5, clamped 0-10) rides alongside it to
carry the opener's call-completion discount.

---

## Why this replaced the rules engine

The previous architecture (rules engine + 16-tactic library + speech prompt
builder) was an expert-systems antipattern. Every conversational edge case
required a new tactic, new rule, new tests — 10 PRs in 24 hours patching
behavior that an LLM with tools handles for free. Production voice agents
(Vapi, Intercom Fin, Sierra, Cal.com) all use this pattern; we now do too.

**Lines deleted:** ~1500 LOC across `decision.py`, `tactics.py`, `decide.py`
route, `prompt_builder.py`, `speech_prompt_builder.py`, `decide-request.builder.ts`,
`scoring.service.ts`, `stage.service.ts`, `negotiation.service.ts`, `signals.ts`,
`vapi-llm.ts`, `admin.ts`, and their test files.

**Lines added:** ~600 LOC for `converse_prompt_builder.py`, `tools.py`,
`converse_response_stream` extension, `/converse` route, `converse-dispatcher.ts`,
classify-analytics queue/worker, and tests.

---

## Human-feel pacing (latest)

On top of the converse pipeline, the `feat/human-feel-pacing` branch added a
layer that makes the agent sound like a person rather than a competent bot:

- **Live context** — the gateway loads the caller's real customer profile +
  abandoned cart (`db.service.ts:loadCallContext`, cached in Redis) and a
  recent-turn signal snapshot (`getRecentTurnSignals`: sentiment streak, filler
  density, length trend, repeated objection), and passes both to the brain.
- **Adaptive behavior** — `converse_prompt_builder._adaptive_behavior()` renders
  those signals into an in-context ADAPTIVE BEHAVIOR block (soften on a negative
  streak, slow down on hesitation, switch tactic on a repeated objection).
- **Thinking fillers** — the brain emits a `thinking` SSE event before an
  observation-tool round-trip; `thinking-filler.ts` streams a short TTS phrase
  ("one sec, checking stock —") so there's no dead air.
- **Voice tuning** — outbound calls set Vapi `assistantOverrides` (silence
  timeout, response delay, interrupt threshold, backchanneling) and a
  timezone-aware voice.
- **New prompt blocks** — `LANGUAGE_RULES` (Romanized Hindi only — TTS garbles
  Devanagari) and `DISFLUENCY_AND_HUMOR`, plus an explicitly female agent identity.

See [ARCHITECTURE_STUDY.md §4.9](ARCHITECTURE_STUDY.md) and
[docs/03-prompt-and-conversion.md](docs/03-prompt-and-conversion.md) for detail.

---

## Running locally

### Type-and-talk (recommended for testing response quality)

```bash
# Seed the demo data first (idempotent — safe to re-run)
bun run scripts/seed-demo-data.ts

# Start chatting (defaults to Sarah Chen, +15551234567)
cd fastapi-brain && uv run python ../scripts/interactive-cli.py

# Or pick a specific demo customer
uv run python ../scripts/interactive-cli.py +15552223333
```

Loads the customer profile (segment, LTV, past orders) and abandoned cart
from the seeded DB, then drops you into a chat with the agent. Each turn:
real LLM call with observation tools that hit the DB live (real reviews,
real inventory, real recent purchases).

Commands inside: `/list`, `/switch <phone>`, `/state`, `/reset`, `/exit`.

### Eval suite

22 canonical scenarios with two layers of scoring (heuristic invariants +
LLM judge). Run on prompt changes to catch regressions:

```bash
cd fastapi-brain && uv run python ../scripts/run-eval.py

# or just one scenario
uv run python ../scripts/run-eval.py --scenario trust_objection_uses_reviews

# skip the LLM judge for faster iteration
uv run python ../scripts/run-eval.py --no-judge
```

Output: per-scenario JSON in `eval-results/eval-{timestamp}.json`, summary
table to stdout. Baseline after the conversion-focus pass: **22/22 heuristics
passing**.

### Full stack (only needed for real Vapi calls)

```bash
# Terminal 1 — brain
cd fastapi-brain && uv run uvicorn app.main:app --reload --port 8000

# Terminal 2 — gateway
cd node-gateway && bun run dev

# Terminal 3 — workers (BullMQ)
cd node-gateway && bun run src/workers.ts
```

Apply Prisma migrations first time only: `bunx prisma migrate deploy`.

### Tests

```bash
# Brain
cd fastapi-brain && uv run pytest tests/unit/

# Gateway
cd node-gateway && bun test --env-file=../.env tests/unit/
```

---

## Tools the LLM can call

Eight tools, two categories. Side-effect tools end the turn; the gateway
dispatches them asynchronously. Observation tools execute server-side and feed
results back to the LLM via a multi-turn loop, so the next response is grounded
in real data. The 6 observation tools run inside the brain; only the 2 WhatsApp
side-effect tools ever reach the gateway as a `ToolName`.

**Side-effect tools** (gateway-dispatched):

| Tool | When | What it does |
|---|---|---|
| `send_whatsapp_checkout_link(discount_percent: 0-10)` | Customer agreed / asking logistics | Demo logs the checkout URL with discount applied |
| `send_whatsapp_product_info()` | Graceful exit with usable trail | Demo logs the product details URL |

**Observation tools** (server-side, fed back into the model):

| Tool | When | Returns |
|---|---|---|
| `check_inventory(product_id)` | Honest scarcity, "how many left?" | `{in_stock, low_stock, restock_eta_days}` |
| `get_recent_purchases(product_id, days)` | Honest social proof | `{count, days}` |
| `get_review_summary(product_id)` | "Is it any good?" / quality concern | `{count, avg_rating, top_positive_quote, top_critical_quote}` |
| `get_delivery_eta(zip_code, product_id)` | Shipping lever / "how soon?" | `{standard_days, expedited_days}` |
| `get_available_offers(product_id)` | Price concern — before any flat discount | `{offers: [{type, discount_percent, short_pitch, …}]}` (DB-authorized BUNDLE / QUANTITY offers) |
| `list_products(category?, max_results)` | "What else do you have?" — broad catalog ask, not the standard alt pivot | `{categories: [{name, count}], products: [{product_id, name, price, category}], total_active}` |

The brain runs observation tools inline (Prisma queries against the seeded
DB), then re-streams from OpenAI with the tool result appended to the
conversation. The model emits text grounded in real facts — no fabrication.

To make them real: swap `simulateSend` in `whatsapp.service.ts` for a fetch
to the WhatsApp Business API or a Twilio/MessageBird wrapper. The function
signatures are the contract.

---

## Streaming protocol

`POST /converse/stream` returns SSE events — five types: `text`, `thinking`,
`observation`, `tool_call`, `done`:

```
data: {"type":"text","delta":"Got it."}
data: {"type":"thinking","tool":"get_review_summary"}
data: {"type":"observation","name":"get_review_summary","args":{...},"result":{...}}
data: {"type":"text","delta":" 4.7 stars from 142 buyers — "}
data: {"type":"tool_call","name":"send_whatsapp_checkout_link","args":{"discount_percent":5}}
data: {"type":"done","finish_reason":"tool_calls"}
```

OpenAI streams tool args as JSON fragments; `converse_response_stream`
accumulates them server-side and emits one fully-parsed `tool_call` event.
The `thinking` event fires before an observation-tool round-trip (the gateway
turns it into a TTS filler), `observation` carries the tool result. The gateway
re-streams `text` deltas to the provider as OpenAI chunks and dispatches
side-effect tools only on `tool_call` events.

---

## Discount enforcement (defense in depth)

| Layer | Job |
|---|---|
| `tools.py` Pydantic schema (`Field(ge=0, le=10)`) | Tells the LLM the valid range via the JSON schema. Models almost never violate. |
| `/converse` route | Validates LLM-returned args via Pydantic. Invalid → log `tool_call_invalid` and drop the tool (text still streams). Surfaces violations. |
| `converse-dispatcher.ts` | Silent clamp `Math.min(10, Math.max(0, n))` right before the WhatsApp service. Last line of defense — ships 10% rather than crashing. |

---

## Live demo (from a real CLI run)

```
you › hey
agent → Hey there! I noticed you left a ZephyrChair Pro and an Anti-fatigue
        Floor Mat in your cart. Anything specific holding you back?

you › i like both the products but the price was out of my budget
agent → Got it. If price weren't an issue, would these be the ones you'd
        go for?

you › yes they will be
agent → I can offer a 5% discount to help with the budget. Would that work
        for you?

you › ok give me the discount on this cart
agent → Sending it to your WhatsApp now.
tool   → send_whatsapp_checkout_link(discount_percent=5)
[DEMO whatsapp → +15551234567] Checkout — ZephyrChair Pro (5% off): $331.55
                                | https://shop.example/checkout/prod-001?d=5
```
