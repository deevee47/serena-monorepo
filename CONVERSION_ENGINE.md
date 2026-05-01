# Serena — Conversion Engine

> Voice agent that calls cart abandoners and converts them through a single
> function-calling LLM with native tools. Vapi (telephony) → node-gateway
> (orchestration) → fastapi-brain (LLM) → Postgres + Pinecone + Redis.

---

## Architecture

```
USER utterance (Vapi transcript event)
    │
    ▼
node-gateway/processTranscript
    │
    ├──► /converse/stream  (single OpenAI chat.completions call with tools)
    │       inputs: history + system prompt (voice rules + sales principles +
    │               product/cart facts + tool schemas)
    │       output: SSE events {type:'text'|'tool_call'|'done'}
    │
    ├──► first text delta → POST Vapi /say (low time-to-first-word)
    │
    ├──► tool_call event → converse-dispatcher → whatsapp.service.ts
    │       silent clamp on discount_percent ∈ [0, 10]
    │
    └──► persist USER+AGENT turns to Postgres
            ├── AGENT row gets `tool_called`, `tool_args` if any
            └── enqueue `classify-analytics` BullMQ job for the USER row
                  (background classifier writes objection_type/subtype later)
```

**Single LLM call per turn.** The model decides whether to talk, call a tool,
or both. No rules engine. No tactic library. Sales competence lives in a
~80-line system prompt + tool definitions.

---

## What's where

### Brain (`fastapi-brain/`)

| File | Purpose |
|---|---|
| [app/services/converse_prompt_builder.py](fastapi-brain/app/services/converse_prompt_builder.py) | Builds the per-call system prompt (objective + voice + principles + tool guidance + cart/product/discount facts + hard constraints) |
| [app/services/prompt_sections.py](fastapi-brain/app/services/prompt_sections.py) | Reusable helpers: `VOICE_RULES`, `HARD_CONSTRAINTS`, `format_product`, `format_cart`, `build_chat_messages` |
| [app/services/tools.py](fastapi-brain/app/services/tools.py) | Two tools, Pydantic-validated: `send_whatsapp_checkout_link(discount_percent: 0-10)` and `send_whatsapp_product_info()` |
| [app/services/llm.py](fastapi-brain/app/services/llm.py) | `converse_response_stream` yields typed events; tool args are accumulated server-side and emitted as one parsed `tool_call` event |
| [app/routes/converse.py](fastapi-brain/app/routes/converse.py) | `POST /converse` and `POST /converse/stream`. Validates LLM tool args via Pydantic and silently drops malformed calls (logged) |
| [app/services/classifier.py](fastapi-brain/app/services/classifier.py) | Pinecone hybrid classifier — runs **only** as analytics from a BullMQ worker now, never in the response path |
| [app/services/objection_index.py](fastapi-brain/app/services/objection_index.py) | Pinecone search backing the classifier |

### Gateway (`node-gateway/`)

| File | Purpose |
|---|---|
| [src/routes/webhook.ts](node-gateway/src/routes/webhook.ts) | Single `processTranscript` path: build `ConverseRequest` → `converseStream` → fire Vapi `/say` on first text delta → dispatch any tool → persist turns → enqueue analytics |
| [src/services/brain.service.ts](node-gateway/src/services/brain.service.ts) | `converse()` and `converseStream()` clients with Opossum circuit breakers. **Fallback returns text-only** — never synthesizes a tool call (would risk a real WhatsApp send on a brain outage) |
| [src/services/converse-dispatcher.ts](node-gateway/src/services/converse-dispatcher.ts) | Tool-name → side-effect routing. Belt-and-suspenders silent clamp on `discount_percent` |
| [src/services/whatsapp.service.ts](node-gateway/src/services/whatsapp.service.ts) | Demo `sendCheckoutLinkOnWhatsApp` and `sendProductInfoOnWhatsApp`. Logs structured events; swap `simulateSend` for a real WhatsApp Business API call when ready |
| [src/queues/index.ts](node-gateway/src/queues/index.ts) | `classifyAnalyticsQueue` for fire-and-forget classifier tagging |
| [src/workers.ts](node-gateway/src/workers.ts) | `classifyAnalyticsWorker` calls `/classify` then `updateCallTurnAnalytics` to populate `objection_type`/`subtype` on the row |

### Schema

| Table | Notable columns |
|---|---|
| `call_turns` | `tool_called`, `tool_args` (jsonb), `objection_type`, `objection_subtype`, `sentiment` (last three populated async) |
| `calls` | unchanged |

Migration: [prisma/migrations/20260501100000_converse_tool_attribution/](prisma/migrations/20260501100000_converse_tool_attribution/migration.sql) — drops `tactic`, `tactic_reasoning`, `pipeline`; adds `tool_called`, `tool_args`.

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

15 canonical scenarios with two layers of scoring (heuristic invariants +
LLM judge). Run on prompt changes to catch regressions:

```bash
cd fastapi-brain && uv run python ../scripts/run-eval.py

# or just one scenario
uv run python ../scripts/run-eval.py --scenario trust_objection_uses_reviews

# skip the LLM judge for faster iteration
uv run python ../scripts/run-eval.py --no-judge
```

Output: per-scenario JSON in `eval-results/eval-{timestamp}.json`, summary
table to stdout. Baseline at the time of the converse-pipeline ship:
**14/15 heuristics pass (93%), judge avg 3.67/5**.

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

Two categories. Side-effect tools end the turn; the gateway dispatches them
asynchronously. Observation tools execute server-side and feed results back
to the LLM via a multi-turn loop, so the next response is grounded in real
data.

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

The brain runs observation tools inline (Prisma queries against the seeded
DB), then re-streams from OpenAI with the tool result appended to the
conversation. The model emits text grounded in real facts — no fabrication.

To make them real: swap `simulateSend` in `whatsapp.service.ts` for a fetch
to the WhatsApp Business API or a Twilio/MessageBird wrapper. The function
signatures are the contract.

---

## Streaming protocol

`POST /converse/stream` returns SSE events:

```
data: {"type":"text","delta":"Got it."}
data: {"type":"text","delta":" If price weren't an issue..."}
data: {"type":"tool_call","name":"send_whatsapp_checkout_link","args":{"discount_percent":5}}
data: {"type":"done","finish_reason":"tool_calls"}
```

OpenAI streams tool args as JSON fragments; `converse_response_stream`
accumulates them server-side and emits one fully-parsed `tool_call` event.
Gateway fires Vapi `/say` only on `text` events, dispatches tools only on
`tool_call` events.

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
