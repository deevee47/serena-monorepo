# Serena — Voice AI Sales Agent

Serena is a production-grade voice sales agent that runs on live phone calls via
Vapi **or** Telnyx. When a cart-abandonment customer picks up, a single
function-calling LLM drives the whole conversation — it opens with their name, cart,
and a call-completion offer, looks up real facts (reviews, inventory, delivery ETA,
recent purchases, promotional offers), adapts tone to their sentiment turn by turn,
and can fire a WhatsApp checkout link when they're ready to buy. The same agent also
handles **inbound presales** calls — the opener and objective branch on a `call_mode`
of `INBOUND_PRESALES` vs `OUTBOUND_RECOVERY`.

There is **no rules engine** — sales competence lives in a system prompt + 8 tool
schemas. The agent is **Serena**, a sales operator for **Muscleblaze**.

> **New to the codebase?** Read [`ARCHITECTURE_STUDY.md`](ARCHITECTURE_STUDY.md) for the
> system map, then [`docs/`](docs/README.md) for line-referenced code walkthroughs.

---

## Architecture

```
Vapi / Telnyx (phone call) ──► node-gateway (Bun/Fastify) ──► fastapi-brain (Python)
   Custom LLM mode                  │                              │
                                  Redis                       OpenAI GPT-4o
                                  BullMQ ──► node-worker       Pinecone (vector search)
                                  Prisma ──► PostgreSQL (Neon)
                                    │
                                  dashboard (Next.js, port 4000)
```

The telephony layer is **provider-agnostic**: a `VoiceProvider` interface
([`voice-provider/`](node-gateway/src/services/voice-provider/)) is implemented by
both a `VapiProvider` and a `TelnyxProvider`, selected by the `VOICE_PROVIDER` env
(default `vapi`) and auto-detected per request (`detectWebhookProvider` /
`detectLlmProvider`). Vapi authenticates webhooks with a Bearer secret; Telnyx uses
Ed25519 signature verification ([`ed25519.ts`](node-gateway/src/services/voice-provider/ed25519.ts),
tweetnacl, ±300s replay window).

The provider runs in **Custom LLM mode**: it calls the gateway's OpenAI-compatible
adapter once per turn — mounted at both `/llm/chat/completions` (canonical) and the
legacy `/vapi-llm/chat/completions` — the gateway routes through to the brain's
`/converse/stream`, and the agent's text streams back as OpenAI-format SSE chunks.

| Service | Port | Role |
|---|---|---|
| `node-gateway` | 3000 | Custom-LLM adapter (Vapi + Telnyx), session state, live context loading, tool dispatch, Postgres writes, outbound calls |
| `fastapi-brain` | 8000 | Function-calling LLM orchestration, observation tools, objection classifier, on-demand call insights, Pinecone search |
| `node-worker` | — | BullMQ worker process: post-call DB writes, call-insight generation, async objection tagging, analytics/CRM stubs |
| `dashboard` | 4000 | Next.js operator cockpit: calls list/detail, live-tail SSE, trigger/talk pages, content CRUD, insight cards |
| `redis` | 6379 | Session store, BullMQ queues, rate-limit + daily call-cap counters |

Postgres (Neon) is the durable source of truth; Pinecone holds two vector indexes
(`voice-agent-products`, `voice-agent-objections`).

---

## Quick Start

### 1. Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [uv](https://docs.astral.sh/uv/) ≥ 0.4 (Python package manager)
- [Docker](https://docs.docker.com/get-docker/) (for Redis + Compose)
- A [Neon](https://neon.tech) PostgreSQL database
- A [Vapi](https://vapi.ai) account **or** a [Telnyx](https://telnyx.com) account — whichever
  `VOICE_PROVIDER` points at — with a phone number and an assistant in Custom LLM mode
- An [OpenAI](https://platform.openai.com) API key
- A [Pinecone](https://pinecone.io) API key + an index named `voice-agent-products` (dim=1536, cosine)

### 2. First-time setup

```bash
git clone <repo-url> && cd serena

# Copy the env template and fill in secrets (see Environment Variables below)
cp .env.example .env

# Install deps, start Redis, generate Prisma clients, run migrations, seed products
make setup
```

`make setup` runs: `bun install` → `uv sync` → `docker-compose up -d redis` →
`prisma generate` (JS + Python clients) → `prisma migrate deploy` → `make seed`
(seeds 80 clothing variants via `scripts/seed.ts`).

### 3. Seed the full demo dataset (recommended for the CLI + eval)

`make seed` only loads the clothing variants. The interactive CLI and eval suite
expect the full demo dataset — chairs, proteins, nutrition accessories, and clothes,
with reviews, 10 customers across all segments with abandoned carts, and BUNDLE /
QUANTITY promotional offers:

```bash
bun run scripts/seed-demo-data.ts   # idempotent — safe to re-run
```

### 4. Embed products into Pinecone (one-time, re-runnable)

```bash
cd fastapi-brain && uv run python ../scripts/embed-products.py
```

Wipes the product index, reads active products from the DB, generates OpenAI
embeddings, and upserts them into Pinecone. Idempotent.

### 5. Start all services

```bash
make dev   # docker-compose up: redis + node-gateway + fastapi-brain + node-worker
```

For local development with faster hot-reload (no Docker for the app services), the
one-command path boots Redis (Docker) plus the full Bun/uv stack —
gateway + brain + worker + dashboard — via `concurrently`:

```bash
bun run dev:all   # redis + gateway (:3000) + brain (:8000) + worker + dashboard (:4000)
```

Or run each process by hand:

```bash
# Terminal 1 — Redis only
docker-compose up -d redis

# Terminal 2 — Node gateway
cd node-gateway && FASTAPI_BRAIN_URL=http://127.0.0.1:8000 bun run dev

# Terminal 3 — FastAPI brain
cd fastapi-brain && NODE_GATEWAY_URL=http://127.0.0.1:3000 uv run uvicorn app.main:app --reload --port 8000

# Terminal 4 — BullMQ worker
cd node-gateway && bun --watch src/workers.ts

# Terminal 5 — Next.js dashboard (optional)
cd dashboard && bun run dev
```

The shared `.env` defaults to Docker service hostnames (`fastapi-brain`,
`node-gateway`). When running both services directly on your host, override those
URLs to `127.0.0.1` as shown. The lighter root `bun run dev` script wraps terminals
2–3 (gateway + brain only) via `concurrently` if you prefer one command.

---

## Running Calls

### Type-and-talk locally (recommended for testing response quality)

```bash
cd fastapi-brain && uv run python ../scripts/interactive-cli.py
# or pick a specific seeded customer
uv run python ../scripts/interactive-cli.py +15552223333
```

Loads a seeded customer + their abandoned cart and drops you into a chat with the
real brain — real LLM call per turn, real observation tools hitting the DB.
Commands: `/list`, `/switch <phone>`, `/state`, `/reset`, `/exit`.

### Simulate a full call against the gateway (no Vapi required)

```bash
make simulate-call
```

Replays a scripted conversation through the full converse pipeline (cold open →
quality concern → inventory question → price pushback → bundle accept → checkout)
against the gateway at `localhost:3000`, polling `/debug/session/:callId` to print
the agent's responses and session state per turn.

### Trigger a real outbound call

```bash
curl -X POST http://localhost:3000/calls/trigger \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{
        "phone_number": "+15551234567",
        "product_id": "prod-001",
        "trigger_reason": "cart_abandon"
      }'
```

`POST /calls/trigger` is gated by the `x-admin-secret` header. The body is Zod-validated:
`phone_number` (E.164), `product_id`, and `trigger_reason` ∈
`{cart_abandon, page_view, wishlist, manual}`; an optional `metadata` object is
forwarded to the provider, and an optional `provider` ∈ `{vapi, telnyx}` overrides the
`VOICE_PROVIDER` default for this one call. The gateway enforces a
3-calls-per-number-per-day cap, calls the active provider's create-call API
(`createPhoneCall` — Vapi `/call/phone` or Telnyx `/v2/calls`) with timezone-aware
voice + pacing overrides, stashes `pending_call:<callId>` in Redis, and returns
`202 { "call_id": "..." }`.

If the call is triggered without an explicit `product_id` (or with `prod-001`), the
gateway prefers the customer's actually-abandoned cart product once it loads their
live context.

---

## Eval Suite

22 canonical scenarios with two layers of scoring — heuristic invariants (right tool
fired, opener mentions name/business/cart, forbidden phrases absent, persistent-probe
pattern correct) and a `gpt-4o-mini` judge (1–5 with reasoning).

```bash
cd fastapi-brain && uv run python ../scripts/run-eval.py
uv run python ../scripts/run-eval.py --scenario just_browsing_three_pushes_then_exit
uv run python ../scripts/run-eval.py --no-judge   # skip the judge for faster iteration
```

Output: per-scenario JSON in `eval-results/`, summary table to stdout. Run it on
every prompt change to catch regressions.

---

## Debugging

### Inspect a live session

```bash
curl http://localhost:3000/debug/session/<callId>
```

Returns the full `CallSession` (product, discounts offered, conversation history,
turn count, `isActive`). Available in `NODE_ENV=development` only.

### Log output

Both services emit structured JSON logs (pino on the gateway, structlog on the
brain); the gateway pretty-prints in dev. Key fields:

- `call_id` — traces a single call across every log line and both services
- `objection` / `sentiment` — written **asynchronously** by the `classify-analytics`
  worker after each turn, not on the hot path
- `tool` / `discount` — the side-effect tool dispatched this turn and the discount applied

Filter for one call:

```bash
docker-compose logs -f node-gateway | grep '"call_id":"<callId>"'
```

### BullMQ jobs

The `node-worker` process runs five queues — `call-end-queue`, `insights-queue`,
`analytics-queue`, `crm-queue`, `classify-analytics-queue` (all `attempts: 3`,
exponential backoff). The call-end worker finalizes the `Call` row and enqueues an
`insights-queue` job; `insightsWorker` POSTs the brain's `/insights/generate` to write
the `CallInsight`. A dead-letter monitor logs to stderr every 5 minutes if any queue
has failed jobs.

### FastAPI interactive docs

`http://localhost:8000/docs` — available when `ENVIRONMENT` is not `production`. You
can exercise `/converse`, `/classify`, `/insights/generate`, and
`/products/alternatives` from the browser (all require the `X-Internal-Secret`
header).

---

## How the agent works

### The 8 tools

The LLM is given 8 tools, in two categories:

**Side-effect tools** (end the turn; the gateway dispatches them out-of-band, to a
demo WhatsApp sender in [`whatsapp.service.ts`](node-gateway/src/services/whatsapp.service.ts)):
- `send_whatsapp_checkout_link(discount_percent: 0-10)` — fires when the customer is ready to buy
- `send_whatsapp_product_info()` — graceful exit; sends product details, no checkout link

**Observation tools** (executed server-side; the result is fed back to the LLM, which
then re-streams a response grounded in the data):
- `check_inventory(product_id)`
- `get_recent_purchases(product_id, days)`
- `get_review_summary(product_id)`
- `get_delivery_eta(zip_code, product_id)`
- `get_available_offers(product_id)` — DB-authorized BUNDLE / QUANTITY offers
- `list_products(category?, max_results)` — catalog overview / category browse

The tool schemas are the single source of truth in
[`tools.py`](fastapi-brain/app/services/tools.py) (`OPENAI_TOOLS`); the gateway only
ever surfaces the 2 side-effect tools (`ToolName`), since the 6 observation tools run
inside the brain. Discounts are clamped to 10% in **three independent layers**: the
Pydantic tool schema, the brain's route validation, and the gateway dispatcher.

### Human-feel pacing

The agent is tuned to sound like a person on a real call:

- **Live customer/cart context** — `loadCallContext()` hydrates the real customer
  profile + abandoned cart from Postgres (cached per call in Redis), so the opener
  references the actual cart, not a placeholder.
- **Sentiment-adaptive behavior** — `getRecentTurnSignals()` derives sentiment streaks,
  filler density, length trend, and repeated objections from recent turns; the brain
  renders an in-context ADAPTIVE BEHAVIOR block (soften on a negative streak, slow down
  on hesitation, switch tactic on a repeated objection, open the humor budget on a
  positive streak).
- **Thinking fillers** — while an observation tool runs, the gateway streams a short
  TTS-friendly phrase ("one sec, checking stock —") so there's no dead air.
- **Call-mode branching** — `call_mode` (`OUTBOUND_RECOVERY` default vs
  `INBOUND_PRESALES`) reshapes the brain's objective and opener: outbound opens on the
  abandoned cart with a call-completion offer, inbound opens as a cold presales greeting
  with no cart. It flows from the trigger/talk metadata through the gateway into
  `ConverseRequest.call_mode` and branches `_objective()` / `_call_opening()` vs
  `_inbound_opening()` in the prompt builder.
- **Response-latency telemetry** — pre-response latency is anchored on provider
  `speech.boundary` webhook events (Vapi `speech-update`), falling back to a word-count
  TTS estimate ([`tts-estimate.ts`](node-gateway/src/lib/tts-estimate.ts), 165 WPM); it
  is persisted as `CallTurn.responseLatencyMs` and fed back to the brain as a signal.
- **Voice tuning** — outbound Vapi calls set `assistantOverrides` (12s silence timeout,
  0.4s response delay, 2-word interrupt threshold, backchanneling) and pick a
  timezone-aware voice (Hindi for Indian timezones, English otherwise).

See [`docs/03-prompt-and-conversion.md`](docs/03-prompt-and-conversion.md) for the
full prompt architecture.

---

## Customisation Guide

### Products

The catalog lives in **Postgres**, not in code. `node-gateway` loads it into an
in-memory map at boot via `loadCatalog()` ([`product.service.ts`](node-gateway/src/services/product.service.ts)).

To change products:
1. Edit [`scripts/seed.ts`](scripts/seed.ts) (the clothing variants) or
   [`scripts/seed-demo-data.ts`](scripts/seed-demo-data.ts) (the full demo set).
2. Re-run the seed script.
3. Re-run `uv run python scripts/embed-products.py` to refresh Pinecone vectors.
4. Restart the gateway so the in-memory catalog reloads.

### Agent persona & system prompt

**Where:** [`fastapi-brain/app/services/converse_prompt_builder.py`](fastapi-brain/app/services/converse_prompt_builder.py)
(`build_converse_system_prompt`) and
[`fastapi-brain/app/services/prompt_sections.py`](fastapi-brain/app/services/prompt_sections.py).

| What | Where |
|---|---|
| Agent name & business | `build_converse_system_prompt(... agent_name="Serena", business_name="Muscleblaze")` |
| Identity / persona | `_objective()` (branches on `call_mode`) |
| Sales playbook | `_principles()` |
| Opening pattern | `_call_opening()` outbound (with LAPSED / VIP variants); `_inbound_opening()` inbound |
| Voice, language, disfluencies | `VOICE_RULES`, `LANGUAGE_RULES`, `DISFLUENCY_AND_HUMOR` in `prompt_sections.py` |
| Sentiment-adaptive overrides | `_adaptive_behavior()` |
| Hard guardrails | `HARD_CONSTRAINTS` in `prompt_sections.py` |

### Promotional offers

Offers are rows in the `offers` table (`BUNDLE` / `QUANTITY`), surfaced to the agent
via the `get_available_offers` tool. Add/edit them in `scripts/seed-demo-data.ts` or
directly in the DB — the agent only ever pitches offers the tool returns.

### LLM model & parameters

Model IDs are env-driven (no code change needed):

```env
OPENAI_MODEL=gpt-4o                  # converse / response generation
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini  # analytics-only objection classifier
```

Temperature, max tokens, and `tool_choice` live in `_CONVERSE_PARAMS` at the top of
[`fastapi-brain/app/services/llm.py`](fastapi-brain/app/services/llm.py)
(`max_tokens: 250`, `temperature: 0.7`).

---

## Environment Variables

Both services share the repo-root `.env` (docker-compose passes it to all
containers). Authoritative schemas: [`node-gateway/src/config/env.ts`](node-gateway/src/config/env.ts)
and [`fastapi-brain/app/config/settings.py`](fastapi-brain/app/config/settings.py).

### Shared / database

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon pooled connection string (runtime) |
| `DATABASE_URL_DIRECT` | ✅ | Neon direct connection — Prisma `directUrl`, used for migrations |
| `REDIS_URL` | — | Redis URL. Default `redis://localhost:6379` |
| `INTERNAL_SERVICE_SECRET` | ✅ | Shared secret for gateway ↔ brain calls (`X-Internal-Secret`) |

### Node gateway

| Variable | Required | Description |
|---|---|---|
| `PORT` | — | Gateway port. Default `3000` |
| `NODE_ENV` | ✅ | `development` \| `production` \| `test` |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error`. Default `info` |
| `FASTAPI_BRAIN_URL` | ✅ | URL the gateway uses to reach the brain |
| `ADMIN_SECRET` | ✅ | Secret for the `x-admin-secret` header on `/calls/trigger` |
| `VOICE_PROVIDER` | — | Active telephony provider: `vapi` \| `telnyx`. Default `vapi` |

The Vapi vs Telnyx vars below are **conditionally required** — `config/env.ts`'s
`superRefine` only enforces the block matching `VOICE_PROVIDER`.

**Vapi** (required when `VOICE_PROVIDER=vapi`):

| Variable | Required | Description |
|---|---|---|
| `VAPI_WEBHOOK_SECRET` | ✅* | Bearer secret Vapi sends on webhooks + Custom-LLM requests |
| `VAPI_API_KEY` | ✅* | Vapi API key for outbound calls |
| `VAPI_ASSISTANT_ID` | ✅* | The Vapi assistant attached to each call |
| `VAPI_PHONE_NUMBER_ID` | — | Which registered Vapi number to dial from |
| `VAPI_PUBLIC_KEY` | — | Public key for the dashboard's Vapi web-call (Talk page) |
| `VAPI_VOICE_EN` | — | Voice ID for English-timezone callers (assistant override) |
| `VAPI_VOICE_HI` | — | Voice ID for Indian-timezone callers (assistant override) |
| `VAPI_CUSTOM_LLM_URL` | — | Public gateway URL Vapi calls in Custom-LLM mode (ngrok / staging / prod) |

**Telnyx** (required when `VOICE_PROVIDER=telnyx`):

| Variable | Required | Description |
|---|---|---|
| `TELNYX_API_KEY` | ✅* | Telnyx API key for outbound calls |
| `TELNYX_PUBLIC_KEY` | ✅* | Base64 Ed25519 public key for webhook signature verification |
| `TELNYX_ASSISTANT_ID` | ✅* | Default Telnyx assistant attached to each call |
| `TELNYX_ASSISTANT_EN` | — | Per-locale assistant override for English callers |
| `TELNYX_ASSISTANT_HI` | — | Per-locale assistant override for Hindi callers |
| `TELNYX_PHONE_NUMBER` | — | Telnyx DID to dial from |
| `TELNYX_PHONE_NUMBER_ID` | — | Telnyx phone-number id |
| `TELNYX_TELEPHONY_CREDENTIAL_ID` | — | Mints short-lived JWTs for the dashboard's Telnyx web-call |
| `TELNYX_LLM_SHARED_SECRET` | — | Bearer secret Telnyx attaches to Custom-LLM POSTs |
| `LLM_URL` | — | Public gateway URL the Telnyx assistant POSTs to (Custom-LLM endpoint) |
| `TELNYX_INSECURE_DEV` | — | `0` \| `1`. When `1`, skip Ed25519 verification + log raw webhook/LLM payloads. Default `0`. Dev only |

### FastAPI brain

| Variable | Required | Description |
|---|---|---|
| `ENVIRONMENT` | — | `development` \| `production` \| `test`. Default `development` |
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `OPENAI_MODEL` | — | Converse model. Default `gpt-4o` |
| `OPENAI_CLASSIFIER_MODEL` | — | Analytics classifier model. Default `gpt-4o-mini` |
| `NODE_GATEWAY_URL` | — | URL the brain uses to reach the gateway. Default `http://127.0.0.1:3000` |
| `PINECONE_API_KEY` | ✅ | Pinecone API key |
| `PINECONE_INDEX_NAME` | — | Product index. Default `voice-agent-products` |
| `PINECONE_OBJECTIONS_INDEX_NAME` | — | Objection-classifier index. Default `voice-agent-objections` |
| `CLASSIFIER_MODE` | — | `shadow` (run both, return LLM) \| `pinecone` (NN + LLM fallback) \| `llm`. Default `shadow` |
| `CLASSIFIER_CONFIDENCE_THRESHOLD` | — | Default `0.78` |
| `CLASSIFIER_TOP1_STRICT_THRESHOLD` | — | Default `0.85` |

---

## Project Structure

```
serena/
├── node-gateway/                # Bun + Fastify gateway (port 3000)
│   └── src/
│       ├── server.ts            # boot + listen
│       ├── app.ts               # Fastify app: plugins, routes, catalog load
│       ├── workers.ts           # BullMQ worker process (runs as node-worker) — 5 queues
│       ├── routes/
│       │   ├── llm.ts           # POST /llm/* + /vapi-llm/* chat/completions — per-turn hot path
│       │   ├── webhook.ts       # POST /webhook (auto-detect provider) + /webhook/telnyx (TeXML); GET /debug/session/:callId
│       │   ├── calls.ts         # POST /calls/trigger, /calls/opener; GET /calls/web-config, /calls/:id/recording
│       │   └── health.ts        # GET /health, /ready
│       ├── services/
│       │   ├── brain.service.ts          # HTTP client to the brain + circuit breakers
│       │   ├── converse-dispatcher.ts    # tool_call → side-effect routing + discount clamp
│       │   ├── thinking-filler.ts        # TTS fillers for observation-tool latency
│       │   ├── opener.service.ts         # authoritative opener generator (branches on call_mode)
│       │   ├── session.service.ts        # Redis-backed CallSession
│       │   ├── db.service.ts             # Prisma writes, loadCallContext, getRecentTurnSignals
│       │   ├── product.service.ts        # DB-loaded catalog + Pinecone alternative lookup
│       │   ├── whatsapp.service.ts       # WhatsApp send (demo stub — swap simulateSend to go live)
│       │   └── voice-provider/           # VoiceProvider interface + Vapi/Telnyx adapters + ed25519 verify
│       ├── queues/index.ts      # BullMQ queue definitions
│       ├── config/env.ts        # Zod-validated environment (VOICE_PROVIDER switch)
│       └── lib/                 # redis, prisma, rate-limit store, tts-estimate, key-mutex
│
├── fastapi-brain/               # Python + FastAPI brain (port 8000)
│   └── app/
│       ├── main.py              # FastAPI app: lifespan, middleware, routers
│       ├── routes/
│       │   ├── converse.py      # POST /converse + POST /converse/stream
│       │   ├── classify.py      # POST /classify — analytics-only objection classifier
│       │   ├── insights.py      # POST /insights/generate — on-demand call insights
│       │   ├── products.py      # POST /products/alternatives
│       │   └── health.py        # GET /health, /ready
│       ├── services/
│       │   ├── llm.py                     # OpenAI streaming + observation-tool loop
│       │   ├── converse_prompt_builder.py # per-call system prompt assembly (call_mode branch)
│       │   ├── prompt_sections.py         # reusable prompt blocks + formatters
│       │   ├── tools.py                   # 8 tool schemas (Pydantic → OpenAI JSON schema)
│       │   ├── observations.py            # 6 observation-tool implementations
│       │   ├── classifier.py              # hybrid objection classifier
│       │   ├── objection_index.py         # Pinecone NN classifier
│       │   └── product.py                 # Pinecone product search
│       ├── config/settings.py   # pydantic-settings environment
│       └── eval/scenarios.jsonl # 22 canonical eval scenarios
│
├── dashboard/                   # Next.js operator cockpit (port 4000)
│   └── src/                     # calls list/detail, live-tail SSE, trigger/talk, content CRUD, insights
│
├── prisma/
│   ├── schema.prisma            # 11 models — customers, carts, products, offers, calls, call_turns, call_insights, …
│   └── migrations/              # 10 migrations
│
├── shared/contracts/
│   └── brain-api.types.ts       # TypeScript mirror of the brain's request/response models (gen:types)
│
├── scripts/
│   ├── seed.ts                  # seeds 80 clothing variants
│   ├── seed-demo-data.ts        # full demo dataset — chairs/proteins/clothes, customers, carts, offers
│   ├── embed-products.py        # (re-)embed products into Pinecone
│   ├── embed-objections.py      # embed objection examples into Pinecone
│   ├── interactive-cli.py       # type-and-talk demo against the real brain
│   ├── run-eval.py              # eval-suite runner (22 scenarios)
│   ├── simulate-call.ts         # end-to-end gateway simulation (no Vapi)
│   └── dev-all.sh               # full local stack launcher (bun run dev:all)
│
├── docs/                        # code-walkthrough deep-dives (+ docs/history/ for archived specs)
├── ARCHITECTURE_STUDY.md        # the system map
├── CONVERSION_ENGINE.md         # the rules-engine → function-calling-LLM pivot
├── docker-compose.yml           # redis + node-gateway + fastapi-brain + node-worker
├── Makefile                     # setup / dev / test / lint / migrate / seed / simulate-call
└── .env.example                 # copy to .env and fill in secrets
```
