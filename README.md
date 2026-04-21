# Serena — Voice AI Sales Agent

A production-grade voice sales agent that runs on live phone calls via Vapi.
When a customer picks up, Serena identifies their objections in real time,
generates context-aware responses through an LLM, and adapts pitch, pricing,
and product recommendations turn by turn.

---

## Architecture

```
Vapi (phone call) ──► Node Gateway (Fastify) ──► FastAPI Brain (Python)
                            │                          │
                         Redis                      OpenAI GPT-4o
                         BullMQ                     Pinecone (vector search)
                         Prisma ──► PostgreSQL (Neon)
```

| Service | Port | Role |
|---|---|---|
| `node-gateway` | 3000 | Vapi webhook handler, session state, scoring, orchestration |
| `fastapi-brain` | 8000 | Objection classifier, response generator, product search |
| `redis` | 6379 | Session store, rate-limit counters, BullMQ job queues |
| `node-worker` | — | BullMQ worker: post-call DB writes, analytics stubs |

---

## Quick Start

### 1. Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [uv](https://docs.astral.sh/uv/) ≥ 0.4 (Python package manager)
- [Docker](https://docs.docker.com/get-docker/) (for Redis)
- A [Neon](https://neon.tech) PostgreSQL database
- A [Vapi](https://vapi.ai) account with a phone number and assistant
- An [OpenAI](https://platform.openai.com) API key
- A [Pinecone](https://pinecone.io) API key + index named `voice-agent-products` (dim=1536, cosine)

### 2. First-time setup

```bash
# Clone and enter the repo
git clone <repo-url> && cd serena

# Copy env template and fill in secrets
cp .env.example .env
# Edit .env — required fields:
#   DATABASE_URL, DATABASE_URL_DIRECT (Neon pooled + direct)
#   VAPI_WEBHOOK_SECRET, VAPI_API_KEY, VAPI_ASSISTANT_ID
#   OPENAI_API_KEY
#   PINECONE_API_KEY
#   INTERNAL_SERVICE_SECRET  (random string ≥32 chars)
#   ADMIN_SECRET             (separate secret for admin API)

# Install everything, run migrations, seed the DB
make setup
```

### 3. Embed products into Pinecone (one-time, re-runnable)

```bash
cd fastapi-brain
uv run python ../scripts/embed-products.py
```

This reads products from the DB, generates OpenAI embeddings, and upserts
them into Pinecone. Re-running is safe (idempotent).

### 4. Start all services

```bash
make dev
# Starts: redis, node-gateway, fastapi-brain, node-worker via docker-compose
```

For local development without Docker (faster hot-reload):

```bash
# Terminal 1 — Redis only
docker-compose up -d redis

# Terminal 2 — Node gateway
cd node-gateway && bun --hot src/server.ts

# Terminal 3 — FastAPI brain
cd fastapi-brain && uv run uvicorn app.main:app --reload --port 8000

# Terminal 4 — BullMQ worker
cd node-gateway && bun src/workers.ts
```

---

## Running Calls

### Simulate a call locally (no Vapi required)

```bash
make simulate-call
```

This replays a scripted conversation (price objection → negotiation → close)
against the live gateway at `localhost:3000` and prints per-turn scores,
stage transitions, and agent responses.

Override the gateway URL or webhook secret:

```bash
GATEWAY_URL=http://localhost:3000 VAPI_WEBHOOK_SECRET=your-secret bun run scripts/simulate-call.ts
```

### Trigger a real outbound call via Vapi

```bash
curl -X POST http://localhost:3000/admin/calls \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+1234567890", "productId": "prod-001"}'
```

The gateway enqueues the call in Redis, dials via Vapi, and handles the
`assistant-request` webhook to spin up a session.

### Change which product a call starts with

Pass `productId` in the call trigger above. Valid IDs: `prod-001` through `prod-008`
(see [Products](#products) below). You can also pass it in the Vapi call metadata:

```json
{ "metadata": { "product_id": "prod-004" } }
```

---

## Debugging

### Inspect a live session

While a call is running (or just after), hit the debug endpoint:

```bash
curl http://localhost:3000/debug/session/<callId>
```

Returns the full `CallSession` object: stage, score, objections seen,
discounts offered, conversation history, turn count.

> Available in `NODE_ENV=development` only.

### Log output

Both services use structured JSON logs. In dev, Fastify's pino pretty-prints them.

Key fields to watch:
- `call_id` — traces a single call across all log lines
- `stage` — current conversation stage (INTRO → PITCH → OBJECTION → NEGOTIATION → CLOSE → END)
- `score` — engagement score 0–100
- `objection` — what the classifier detected (PRICE, TRUST, CONFUSION, TIMING, POSITIVE_SIGNAL, NEUTRAL)
- `discount` — discount % offered this turn (0 if none)

Filter logs for a single call:

```bash
docker-compose logs -f node-gateway | grep '"call_id":"sim-123"'
```

### Check BullMQ job status

```bash
# See failed jobs in all queues
curl http://localhost:3000/health   # shows queue counts if wired
```

The `node-worker` service logs every job and alerts to stderr if the dead-letter
queue has items (checked every 5 minutes).

### FastAPI interactive docs

```
http://localhost:8000/docs
```

Available in non-production. You can call `/classify`, `/generate`, and
`/products/alternatives` directly from the browser.

---

## Customisation Guide

### Products

**Where:** `node-gateway/src/services/product.service.ts` → `CATALOG` array

Each product has:
```typescript
{
  id: 'prod-001',          // unique, must match DB seed
  name: 'My Product',
  description: 'One-line description',
  price: 349.0,
  category: 'Office',      // used for Pinecone category filter
  tags: ['ergonomic', 'chair', 'office'],  // semantic search keywords
  isActive: true,
}
```

**After editing:**
1. Update `prisma/seed.ts` to match (the DB is the source of truth for BullMQ records)
2. Re-run `make seed`
3. Re-run `uv run python scripts/embed-products.py` to refresh Pinecone vectors
4. Restart the gateway so `CATALOG` reloads

The `CATALOG` in `product.service.ts` and the DB **must stay in sync** — the gateway
reads products from the in-memory catalog, while Pinecone and DB are updated separately.

---

### Agent Persona and System Prompt

**Where:** `fastapi-brain/app/services/prompt_builder.py`

The `build_system_prompt()` function assembles everything the LLM sees before
the conversation. Key things you can change:

| What | Where in the file |
|---|---|
| Agent name and company | Line `"You are Alex, a sales specialist for ShopEase."` |
| Personality / tone | The sentences after the name |
| Per-stage guidance | `STAGE_GUIDANCE` dict (one instruction per stage) |
| Max discount cap | `MAX_DISCOUNT = 10` (percent) |
| Discount offer rules | The `if req.discount_available > 0` block |
| Product feature framing | The `if req.product_context:` block |
| Safety guardrails | The final `prompt +=` block at the bottom |

Example — change the agent name:

```python
# Before
"You are Alex, a sales specialist for ShopEase. "

# After
"You are Jordan, a product advisor for TechMart. "
```

---

### Objection Classifier Behaviour

**Where:** `fastapi-brain/app/services/classifier.py`

The classifier calls GPT-4o-mini with a structured output prompt that maps
customer speech to one of: `PRICE | TRUST | CONFUSION | TIMING | POSITIVE_SIGNAL | NEUTRAL`.

To change classification sensitivity or add a new objection type:

1. Add the new type to `shared/contracts/brain-api.types.ts` and `node-gateway/src/types/session.types.ts`
2. Update the classifier prompt in `classifier.py`
3. Add a corresponding entry to `SCORE_DELTAS` in `scoring.service.ts`
4. Add a DB row to `scoring_config` via the admin API (or seed)

---

### Scoring Deltas (how aggressive/lenient scoring is)

**Two ways to change scoring:**

**Option A — Edit code (permanent):**  
`node-gateway/src/services/scoring.service.ts` → `SCORE_DELTAS` and `REPEAT_PENALTY`

**Option B — Admin API (live, no redeploy):**

```bash
# Change how much a price objection drops the score
curl -X POST http://localhost:3000/admin/scoring-config \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{"key": "delta_price", "value": -18}'
```

Available keys and their defaults:

| Key | Default | Meaning |
|---|---|---|
| `delta_price` | -15 | Score drop when customer objects to price |
| `delta_trust` | -20 | Score drop on trust/credibility objection |
| `delta_confusion` | -10 | Score drop on confusion |
| `delta_timing` | -12 | Score drop on timing objection |
| `delta_positive_signal` | +12 | Score boost on positive signal |
| `delta_neutral` | 0 | No change on neutral turn |
| `repeat_penalty` | -10 | Extra penalty if same objection repeats |

Changes take effect immediately (no restart). The gateway refreshes from DB
every 5 minutes automatically; the admin endpoint triggers an immediate reload.

---

### Stage Transition Logic

**Where:** `node-gateway/src/services/stage.service.ts`

Controls when the conversation advances from one stage to the next
(e.g. PITCH → OBJECTION when score drops, NEGOTIATION → CLOSE when score recovers).
Edit the thresholds and conditions here.

---

### Discount Logic

**Where:** `node-gateway/src/services/negotiation.service.ts`

Controls:
- When to offer a discount (`shouldOfferDiscount`)
- How much to offer (`getAvailableDiscount`)
- Whether the customer is asking for follow-up (`detectFollowUpRequest`)

---

### LLM Model

**Where:** `.env`

```env
OPENAI_MODEL=gpt-4o           # response generation
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini  # objection classification
```

Change the model without touching code. `gpt-4o-mini` is used for the
classifier to reduce cost; `gpt-4o` is used for generating call responses.

**Temperature and max tokens:**  
`fastapi-brain/app/services/llm.py` → `_OPENAI_PARAMS` dict at the top of the file.

```python
_OPENAI_PARAMS: dict = {
    "max_tokens": 150,   # keep responses short — this is a phone call
    "temperature": 0.7,  # raise for more creative, lower for more predictable
    "stream": True,
}
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon pooled connection string |
| `DATABASE_URL_DIRECT` | ✅ | Neon direct connection (for migrations) |
| `REDIS_URL` | ✅ | Redis connection URL |
| `VAPI_WEBHOOK_SECRET` | ✅ | Bearer token Vapi sends on every webhook |
| `VAPI_API_KEY` | ✅ | Vapi API key for outbound calls and `/say` |
| `VAPI_ASSISTANT_ID` | ✅ | The Vapi assistant to attach to each call |
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `OPENAI_MODEL` | — | Default: `gpt-4o` |
| `OPENAI_CLASSIFIER_MODEL` | — | Default: `gpt-4o-mini` |
| `PINECONE_API_KEY` | ✅ | Pinecone API key |
| `PINECONE_INDEX_NAME` | — | Default: `voice-agent-products` |
| `INTERNAL_SERVICE_SECRET` | ✅ | Shared secret between Node and FastAPI |
| `ADMIN_SECRET` | ✅ | Secret for `x-admin-secret` header on admin routes |
| `PORT` | — | Node gateway port. Default: `3000` |
| `NODE_ENV` | ✅ | `development` or `production` |
| `LOG_LEVEL` | — | `debug`, `info`, `warn`, `error`. Default: `info` |
| `FASTAPI_BRAIN_URL` | ✅ | URL node-gateway uses to reach FastAPI |

---

## Project Structure

```
serena/
├── node-gateway/          # Fastify webhook server + orchestration
│   └── src/
│       ├── routes/
│       │   ├── webhook.ts         # Vapi webhook handler (main call loop)
│       │   ├── admin.ts           # Admin API (scoring config)
│       │   ├── calls.ts           # Outbound call trigger
│       │   └── vapi-llm.ts        # Vapi LLM mode completions
│       ├── services/
│       │   ├── brain.service.ts   # HTTP client to FastAPI + circuit breakers
│       │   ├── scoring.service.ts # Score calculation + DB-backed config
│       │   ├── stage.service.ts   # Stage transition logic
│       │   ├── session.service.ts # Redis-backed call session
│       │   ├── negotiation.service.ts  # Discount and follow-up logic
│       │   └── product.service.ts      # Product catalog + Pinecone lookup
│       ├── queues/index.ts        # BullMQ queue definitions
│       └── workers.ts             # BullMQ worker process
│
├── fastapi-brain/         # Python ML/LLM service
│   └── app/
│       ├── routes/
│       │   ├── classify.py        # POST /classify — objection detection
│       │   ├── generate.py        # POST /generate + /generate/stream
│       │   └── products.py        # POST /products/alternatives
│       └── services/
│           ├── classifier.py      # GPT-4o-mini structured output classifier
│           ├── llm.py             # OpenAI streaming response generator
│           ├── prompt_builder.py  # System prompt assembly ← edit persona here
│           └── product.py         # Pinecone vector search
│
├── prisma/
│   ├── schema.prisma              # DB schema (calls, turns, products, scoring_config)
│   └── seed.ts                    # Product seed data
│
├── scripts/
│   ├── simulate-call.ts           # Local end-to-end call simulation
│   └── embed-products.py          # One-time Pinecone embedding script
│
├── docker-compose.yml             # Dev: all services
├── Makefile                       # setup / dev / test / seed / simulate-call
└── .env.example                   # Copy to .env and fill in secrets
```
