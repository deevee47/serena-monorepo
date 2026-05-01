# Serena — Conversion Engine: Architecture Index & Roadmap

> Voice agent that calls cart abandoners and converts them through context-aware
> nudging, objection handling, and negotiation. Vapi (telephony) → node-gateway
> (orchestration) → fastapi-brain (LLM logic) → Postgres + Pinecone + Redis.

---

## Tactic attribution on every CallTurn (shipped)

`CallTurn` schema gains 4 columns so every agent reply is attributable to a
specific tactic for the eventual learning loop:

| Column | Purpose |
|---|---|
| `tactic` | The Tactic enum value chosen for this AGENT turn (null on legacy path / USER turns) |
| `tactic_reasoning` | One-sentence justification logged from `/decide` |
| `objection_subtype` | The fine-grained subtype from B-2 (PRICE→`too_expensive` etc.) |
| `pipeline` | `'tactic'` or `'legacy'` — which generation path produced this turn |

Migration: [prisma/migrations/20260501000000_call_turn_tactic_attribution/](prisma/migrations/20260501000000_call_turn_tactic_attribution/migration.sql).
Run `bunx prisma migrate deploy` (or your equivalent for Neon) to apply.

`buildDecideRequest()` extracted to its own module ([services/decide-request.builder.ts](node-gateway/src/services/decide-request.builder.ts)) so it imports cleanly in unit tests without dragging the env validator through `brain.service.ts → config/env.ts`.

---

## Phase B-Integration (shipped) — node-gateway uses the tactic pipeline (flag-gated)

`processTranscript` in [node-gateway/src/routes/webhook.ts](node-gateway/src/routes/webhook.ts) now branches on `USE_TACTIC_PIPELINE`:

- **`false` (default):** legacy path — classify → `/generate` (4000-token persona prompt). Zero behavior change from before this PR.
- **`true`:** new path — classify → `/decide` → `/generate-tactic` (~500-token tactic-driven prompt).

Both paths still stream the response and fire Vapi `/say` on the first chunk for low TTFW.

**New brain.service.ts client functions:**
- `decide(req)` with Opossum circuit breaker (5s timeout); fallback returns `ASK_OPEN` with safe micro-guidance so the call doesn't drop on a brain outage.
- `generateTactic(req)` and `generateTacticStream(req, onChunk)` (12s/15s timeouts); fallback returns "Give me just a moment."

**`buildDecideRequest()`** in webhook.ts is exported and unit-tested. Maps live `CallSession` state (prior objections, discounts ladder, alternative-product availability, score, stage, turn count) plus the latest classification into the `DecideRequest` wire shape.

**Rollout:**
1. Deploy with `USE_TACTIC_PIPELINE=false` (default) — code lands but nothing changes.
2. Flip to `true` in staging or a single tenant — watch `pipeline=tactic` logs and conversion outcomes.
3. Flip globally once confident. Rollback = single env change.

185 tests pass total (93 brain + 92 gateway). TypeScript clean.

---

## Phase B-4 (shipped) — Tactic-driven Speech layer

Replaces the 4000-token monolithic persona prompt with a small focused prompt
(~440-500 tokens) built from voice rules + the chosen tactic's micro-guidance
+ product facts + hard constraints. Conversation history is sent as proper
OpenAI chat messages, not stuffed into the system prompt.

**End-to-end measured output (5 live scenarios, real LLM):**

| Customer | Tactic | Agent reply |
|---|---|---|
| "that's way too expensive for me" | `ISOLATE` | "If the price were within your budget, would this be the one for you?" |
| "still too pricey" (2nd PRICE) | `REFRAME` | "Think of it as a daily investment in your comfort and productivity. Over five years, that's just a few cents a day for a better work experience." |
| "I don't really trust new brands" | `ASK_OPEN` | "What do you usually look for in a brand to build that trust?" |

No "Absolutely!", no "Great question!", no "Alex" persona leak. 1-2 sentences each, voice-natural.

**New files:**
- [services/speech_prompt_builder.py](fastapi-brain/app/services/speech_prompt_builder.py) — `build_speech_system_prompt()` + `build_speech_messages()`
- [tests/unit/test_speech_prompt_builder.py](fastapi-brain/tests/unit/test_speech_prompt_builder.py) — 19 tests asserting size cap, no persona scaffolding, no psychology / score-mode / playbook leftovers, voice rules + hard constraints present
- [scripts/smoke-test-generate-tactic.py](scripts/smoke-test-generate-tactic.py) — end-to-end CLI: classify → decide → generate

**Modified:**
- [routes/generate.py](fastapi-brain/app/routes/generate.py) — adds `POST /generate-tactic` and `POST /generate-tactic/stream` (legacy `/generate` and `/generate/stream` untouched)
- [models/requests.py](fastapi-brain/app/models/requests.py) — `GenerateTacticRequest`
- [shared/contracts/brain-api.types.ts](shared/contracts/brain-api.types.ts) — `GenerateTacticRequest` for node-gateway

**Backwards compatible:** new endpoints, no existing route changed. Node-gateway can call `/decide` then `/generate-tactic` to opt into the new pipeline; or keep using `/generate` for the legacy persona prompt.

**Speech prompt size:** ~1700-2000 chars (~430-500 tokens) — vs ~16000 chars / ~4000 tokens for the legacy persona prompt. ~8× reduction.

---

## Phase B-3 (shipped) — Decision layer (tactic library + rules engine)

A pure rules engine that takes a `Perception` (objection type + subtype +
sentiment + stage + score + history) and returns a `Decision` (tactic +
one-sentence reasoning + micro-guidance for the Speech layer). No LLM, no
I/O — fully deterministic, fully testable, A/B-able.

This ships purely additive: new endpoint `POST /decide`, new modules. The
existing `/generate` flow is untouched. The next phase replaces the
4000-token monolithic prompt with a small voice-rules prompt + the chosen
tactic's micro-guidance.

**New files:**
- [services/tactics.py](fastapi-brain/app/services/tactics.py) — `Tactic` enum (13 tactics) + per-tactic micro-guidance strings
- [services/decision.py](fastapi-brain/app/services/decision.py) — `Perception` dataclass + `decide()` rules engine
- [routes/decide.py](fastapi-brain/app/routes/decide.py) — `POST /decide` endpoint
- [tests/unit/test_decision.py](fastapi-brain/tests/unit/test_decision.py) — 31 rule + priority + payload tests

**Rule priority (first match wins):**
1. Hard exits (END stage, very low score after multiple turns) → `GRACEFUL_EXIT`
2. Buying signals (ready_to_buy / asking_logistics / score ≥ 80) → `ASSUMPTIVE_CLOSE` / `TRIAL_CLOSE`
3. Discovery openers (INTRO turn 0; low score early with no clear objection) → `ASK_OPEN` / `ASK_DISQUALIFY`
4. Objection-specific paths — see table below
5. Fallback (no decisive signal) → `ASK_OPEN`

**Objection-specific paths:**

| Objection | First mention | Repeated | Subtype-specific overrides |
|---|---|---|---|
| `PRICE` | `ISOLATE` | `REFRAME` then `CONCESSION_REAL` (5%→10% ladder) | `budget` / `found_cheaper` + alternative available → `ALTERNATIVE_PIVOT`; max discount reached → `PERMISSION_PUSH` |
| `TRUST` | `ASK_OPEN` | `CONCESSION_NON_MONETARY` (warranty / refund / proof) | — |
| `TIMING` | `TIME_CAPTURE` | `PERMISSION_PUSH` | `wait_for_sale` + no concession yet → `CONCESSION_REAL` |
| `CONFUSION` | `MIRROR` | same | `how_works` / `comparison_unclear` / `fit_size` → `ASK_OPEN` |
| `POSITIVE_SIGNAL` | per buying-signal rules | per buying-signal rules | `interested` at neutral score → `ASK_OPEN` to deepen |

**Backwards compatible:** new endpoint, no existing route changed. Decision is exposed but not yet consumed by `/generate` — the next phase wires it into the Speech layer.

---

## Phase B-2 (shipped) — Sub-typed objections

Surfaces the fine-grained sub-type that the seed file already tags (e.g. PRICE
→ `too_expensive | found_cheaper | budget | bad_value | wants_discount |
sticker_shock | high_intent | pleasant_surprise`). This is what lets the
Decision layer in B-3 select tactic by sub-type instead of just by top-level
objection.

**Voting rules for subtype:**
- **Strict win:** use the top-1 match's subtype directly
- **Consensus win:** use the most-common subtype if ≥2 of top-3 agree, else fall back to top-1's subtype
- **No subtype on matches:** subtype stays `null`
- **LLM fallback path:** subtype always `null` (the LLM doesn't predict sub-types in v1)

**Changes:**
- `Classification` NamedTuple replaces the bare tuple in [classifier.py](fastapi-brain/app/services/classifier.py); 4th field is optional `subtype`
- `VoteResult` gets a 5th field `subtype` in [objection_index.py](fastapi-brain/app/services/objection_index.py); new `_consensus_subtype()` helper
- `ClassifyObjectionResponse` gets `subtype: str | None` ([responses.py](fastapi-brain/app/models/responses.py), [shared/contracts](shared/contracts/brain-api.types.ts))
- `/classify` route threads it through ([routes/classify.py](fastapi-brain/app/routes/classify.py))
- 4 new unit tests for subtype voting (strict, consensus majority, all-disagree fallback, missing data)

**Backwards compatible:** `subtype` is optional everywhere — existing callers that ignore the field keep working unchanged.

---

## Phase B-1 (shipped) — Pinecone hybrid objection classifier

Replaces the per-turn LLM classifier with embedding nearest-neighbor search,
keeping the LLM as a confidence-gated fallback. Cuts classification latency
from 300–700ms to ~120ms on confident hits.

**New files:**
- [fastapi-brain/data/objection_seed.jsonl](fastapi-brain/data/objection_seed.jsonl) — 225 voice-realistic labeled utterances; sub-types reserved in metadata for B-2
- [fastapi-brain/app/services/objection_index.py](fastapi-brain/app/services/objection_index.py) — Pinecone query + `vote()` (strict win at 0.85 / consensus win at 0.78)
- [fastapi-brain/app/utils/embeddings.py](fastapi-brain/app/utils/embeddings.py) — shared `embed_text()` with TTL cache, used by both products and objections
- [scripts/embed-objections.py](scripts/embed-objections.py) — idempotent index creation + seed upsert
- [fastapi-brain/tests/unit/test_objection_index.py](fastapi-brain/tests/unit/test_objection_index.py) — vote rules
- [fastapi-brain/tests/unit/test_classifier_modes.py](fastapi-brain/tests/unit/test_classifier_modes.py) — mode dispatch + error handling

**Modified:**
- [fastapi-brain/app/services/classifier.py](fastapi-brain/app/services/classifier.py) — refactored into hybrid; original LLM impl preserved as `_classify_with_llm` fallback
- [fastapi-brain/app/config/settings.py](fastapi-brain/app/config/settings.py) — `classifier_mode`, two thresholds, new index name
- [fastapi-brain/app/services/product.py](fastapi-brain/app/services/product.py) — uses shared `embed_text()`
- [.env.example](.env.example) — new vars documented

**Run order to deploy B-1:**
1. `uv run python scripts/embed-objections.py` — creates the Pinecone index and uploads seed
2. Default `CLASSIFIER_MODE=shadow` runs both classifiers, returns LLM result, logs Pinecone result. Watch logs for ≥95% agreement before flipping
3. Set `CLASSIFIER_MODE=pinecone` to flip to live hybrid (Pinecone first, LLM fallback)
4. `CLASSIFIER_MODE=llm` is the kill switch — instant rollback, no deploy

**API contract unchanged:** `POST /classify` returns the same `(objection_type, sentiment, confidence)` shape. Node-gateway and shared contracts untouched.

---

## Natural-manipulator architecture (the agent design)

The current "Alex" prompt is 60+ lines of persona theater — that's the
dominant cause of synthetic-sounding output. Top human salespeople don't have
a character; they have **operational habits**. The reframe: strip the persona,
keep the operations. Personality emerges for free from a good LLM when you
stop forcing a character on it.

### Three-layer split: Perception → Decision → Speech

| Layer | What it does | Today | Target |
|---|---|---|---|
| **Perception** | Read the customer accurately every turn | LLM classifier (300–700ms), POS/NEG/NEU sentiment | Pinecone classifier (120ms) + sub-types + sentiment trajectory + engagement velocity + voice-channel signals (interruption count, pre-response latency) + already-tried memory |
| **Decision** | Pick the conversational tactic | Implicit, baked into the 4000-token prompt | Explicit named tactic library; rule-based for clear cases (80%), small focused LLM for ambiguous (20%); logged per turn for the learning loop |
| **Speech** | Express the tactic naturally | Persona LARP ("you are Alex...") | ~600-token prompt: 15 lines of voice rules + per-tactic micro-guidance + last 2 turns + product/customer facts |

### Tactic library (the "manipulation" in named, testable form)

| Tactic | When | Example output |
|---|---|---|
| `ASK_OPEN` | Pre-discovery, low-info turns | "What would you actually use it for?" |
| `ASK_DISQUALIFY` | When intent unclear; counterintuitive trust-builder | "If you're just browsing, no pressure — want me to email info instead?" |
| `MIRROR` | Customer signaling but vague | "Outside what you wanted to pay?" |
| `ISOLATE` | First objection, before any reframe | "If price worked, is this the one you'd actually want?" |
| `REFRAME` | Persistent objection after isolation | Cost → daily investment, feature → outcome |
| `CONCESSION_REAL` | Stuck on PRICE, isolated, second mention | "I can do 5% off — that's it. Does that work?" |
| `CONCESSION_NON_MONETARY` | TIMING or TRUST objection | Free shipping / extended warranty / white-glove |
| `ALTERNATIVE_PIVOT` | Budget genuinely below SKU | "Honestly, here's a cheaper one that might fit better" |
| `PERMISSION_PUSH` | Want to challenge but preserve dynamic | "Can I push back on one thing?" |
| `TIME_CAPTURE` | TIMING objection, not closing today | "When would you naturally decide on something like this?" |
| `TRIAL_CLOSE` | Buying signals appearing | "Sounds like the medium — sound right?" |
| `ASSUMPTIVE_CLOSE` | Strong buying signals + no objections | "I'll get it on its way — what's the address?" |
| `GRACEFUL_EXIT` | Genuine no, score < 20, repeated objections | "All good. I'll send a link — use it whenever." |

### The five "feels natural" principles (baked into Decision rules)

1. **Earn the right to push** — no persuasion tactic before genuine discovery; `ASK_OPEN` / `MIRROR` precede everything
2. **Asymmetric give-first** — real concessions before any ask; `PERMISSION_PUSH` works because it inverts power
3. **Honest disqualification** — `ASK_DISQUALIFY` raises conversion because trust scales harder than pressure; the agent that doesn't *need* the sale gets it
4. **No theater concessions** — if you offer 5%, mean it; never invent a constraint
5. **Real exits are real** — `GRACEFUL_EXIT` actually exits; failed pursuit kills the relationship and the next call

### Voice-channel signals (currently unused, plumb in B-5)

Vapi gives metadata text agents don't have:
- Interruption count → high = engaged but frustrated → drop to `ASK_OPEN`
- Pre-response latency → long pause = considering, lean in quietly; fast pushback = strong objection, validate first
- User utterance length trend → shrinking >40% over 3 turns = disengaging
- Filler word density → uncertainty, opening for `ISOLATE`

### Phasing

| Phase | Ships | Active dev |
|---|---|---|
| **B-1** ✅ | Pinecone classifier — Perception foundation | shipped |
| **B-2** ✅ | Sub-typed objections — vote() surfaces consensus subtype, threaded through API | shipped |
| **B-3** ✅ | Decision layer — tactic library + rules engine + /decide endpoint | shipped |
| **B-4** ✅ | Speech layer — small voice-rules + tactic micro-guidance prompt + /generate-tactic | shipped |
| **B-5** | Voice-channel signals — interruption / latency / length-trend into Perception | ~1 day |
| **B-6** | Tactic logging — `tactic_used` on every CallTurn for the learning loop | ~0.5 day |

**~10 days active to flip from persona-driven to tactic-driven.**

---

## Part 1 — Current Architecture (what exists today)

### Service map

| Service | Stack | Port | Responsibility |
|---|---|---|---|
| `node-gateway` | Bun + Fastify + Prisma + BullMQ | 3000 | Vapi webhook handler, session state (Redis), scoring, stage FSM, discount ladder, DB writes |
| `fastapi-brain` | FastAPI + OpenAI + Pinecone | 8000 | Objection classifier, prompt builder, response generator (SSE streaming), product alternative search |
| `prisma` | Postgres (Neon) | — | `Call`, `CallTurn`, `Product`, `ScoringConfig` |
| `redis` | Redis | 6379 | Per-call session (2h TTL), pending-call metadata, daily-call-limit counter |
| Workers | BullMQ | — | `call-end`, `analytics`, `crm` (analytics + CRM are stubs) |

### End-to-end call flow

```
1. POST /calls/trigger ──► Vapi outbound call ──► Redis pending_call:{id}
2. Vapi → /webhook (assistant-request) ──► Redis session created
3. Per user utterance:
   Vapi → /webhook (transcript)
       ├── classify objection (FastAPI /classify, gpt-4o-mini, few-shot)
       ├── update score (delta + repeat penalty + sentiment modulation)
       ├── advance stage (INTRO→PITCH→OBJECTION/NEGOTIATION→CLOSE→END)
       ├── check discount eligibility (5% → 10% ladder)
       ├── if PRICE objection → Pinecone search for cheaper alternative
       ├── build system prompt (~4000 tokens, conditional sections)
       ├── /generate/stream (gpt-4o, SSE word chunks)
       │      └── on first chunk → POST Vapi /say  ← TTFW optimization
       └── persist turns to Postgres (non-blocking)
4. Vapi → /webhook (end-of-call-report) ──► outcome computed (CONVERTED if
   score≥60 + stage=CLOSE), enqueue jobs, delete Redis session
```

### What the prompt builder already encodes (see [fastapi-brain/app/services/prompt_builder.py](fastapi-brain/app/services/prompt_builder.py))

- **Persona** — "Alex", calm/confident, voice-optimized (no corporate filler, 1–2 sentences, silence after close)
- **Psychology principles** — loss aversion, anchoring, commitment ladder, isolation, feel-felt-found, future pacing, specificity
- **Score-driven behavioral modes** — VERY_LOW → VERY_HIGH (5 tiers, each with explicit instructions)
- **Stage playbooks** — 6 stages × tactical scripts (LAER, trial close, assumptive close, etc.)
- **Objection playbooks** — 6 types × numbered tactic sequences
- **Conversation intelligence** — stuck-loop detection, repeat objection escalation, positive-momentum nudge
- **Anti-patterns + hard constraints** — no fake urgency, no invented features, max 10% discount, prompt-injection guard

### What the runtime already supports

- ✅ Streaming for low time-to-first-word (Vapi /say on first chunk)
- ✅ Objection classification with sentiment + confidence
- ✅ 0–100 engagement score with repeat penalty
- ✅ Deterministic stage FSM with backstop (CLOSE → NEGOTIATION on new objection)
- ✅ Two-tier discount ladder, gated by stage + last objection
- ✅ Pinecone semantic search for cheaper alternatives on PRICE
- ✅ Circuit breakers (Opossum) on FastAPI calls with stage-keyed fallbacks
- ✅ Daily call limit per phone (3/day)
- ✅ Audit trail in Postgres (every turn with score-before/after, objection, discount)

---

## Part 2 — Gaps blocking real conversion

### Tier 1 — Without these, the agent can't actually close

| Gap | Why it matters | Where to fix |
|---|---|---|
| **No order/cart tools** | Agent "closes" but no order is placed. End of call → nothing happens. | New `tools/` module on FastAPI; tool-call schema in prompt |
| **No payment link / SMS hand-off** | Even if customer says yes, no way to capture payment | Twilio/Stripe integration in node-gateway |
| **Static product catalog** | `CATALOG` is in-memory; no real inventory, price, stock | Move to Postgres `Product` table (already exists, unused at runtime) |
| **No real customer profile** | Every call is cold-start; no past purchase, abandonment context, or LTV | New `Customer` Prisma model + lookup in `assistant-request` |

### Tier 2 — Without these, the agent can't manipulate effectively

| Gap | Why it matters | Where to fix |
|---|---|---|
| **No fine-grained objection taxonomy** | "PRICE" lumps together "too expensive", "found it cheaper", "bad ROI", "budget constrained" — each needs a different tactic | Extend `ObjectionType` enum with sub-types, retrain few-shot examples |
| **Coarse sentiment** | POS/NEG/NEU misses frustration ramp, hesitation, excitement velocity | Track sentiment trajectory across last N turns |
| **No persona variants** | One Alex for everyone; can't match high-pressure vs. friend-advisor to segment | Add `persona_id` to session; multiple persona blocks in prompt builder |
| **No real scarcity/urgency tools** | Prompt bans fake urgency, but agent has no real urgency to invoke | `check_inventory`, `time_bound_offer` tools with real backing data |
| **No social proof tool** | "847 people bought this" requires real data; today it'd be invented (banned by hard constraint) | `get_recent_purchase_stats(product_id)` tool |
| **No commitment-capture mid-call** | Can't get email, address, callback time recorded mid-conversation | Function-calling layer with structured extraction |

### Tier 3 — Without these, you can't improve the agent over time

| Gap | Why it matters | Where to fix |
|---|---|---|
| **No A/B framework** | All tactic changes are manual; no data on what actually converts | `variant_id` on session, persona/script branching, outcome tagging |
| **No outcome attribution per tactic** | DB stores objections + discounts but not which response approach was used or whether it worked | Tag agent turns with tactic taxonomy; correlate with downstream sentiment shift |
| **No analytics/CRM workers** | Workers are stubs; no funnel analytics, no CRM sync | Implement `analyticsWorker` + `crmWorker` |
| **No prompt versioning** | Edit prompt → can't compare before/after performance | Hash + version system prompts; record `prompt_version` per turn |
| **No human escalation** | If agent fails, call dies; no warm hand-off | Vapi transfer-call action + queue |

### Tier 4 — Production hygiene (already partly noted in code TODOs)

- Session updates aren't atomic (GET-merge-SET) — needs Lua script or `WATCH/MULTI/EXEC`
- Scoring config cache is 5min stale on update — needs pub/sub
- No TCPA/DNC compliance, no recording-consent disclosure
- No call recording / full transcript storage (only turn-by-turn rows)

---

## Part 3 — Proposed roadmap (phased, ship-something-each-phase)

### Phase A — "Make the close real" (1–2 weeks)
**Goal:** When the agent gets a yes, money moves.

1. Move `Product` from in-memory `CATALOG` to Postgres lookups
2. Add `Customer` Prisma model: phone, email, abandoned_cart_items, past_orders, lifetime_value
3. Lookup Customer in `assistant-request`; pass to brain as `customer_context`
4. New tool: `send_checkout_link(call_id)` → SMS via Twilio with discount-applied stripe link
5. New tool: `record_commitment(call_id, type, value)` → captures email, callback time, etc.
6. Add `tool_call` round-trip: brain returns `{text, tool_calls[]}`; node-gateway executes; brain gets tool result; brain finalizes reply

> Why first: Without this, every other improvement is theater — score going up doesn't earn revenue.

### Phase B — "Make the manipulation real, not invented" (1–2 weeks)
**Goal:** Agent has true levers to pull, not just persuasive language.

1. `check_inventory(product_id)` → only call if low-stock; agent says "I see we're down to 3 in this color"
2. `get_recent_purchase_stats(product_id, days)` → factual social proof
3. `create_time_bound_offer(call_id, percent, expires_at)` → discount that genuinely expires (Redis key with TTL); when it expires, agent loses the lever
4. `check_competitor_price(product_id)` *(if you have a price-monitoring source)* → respond to "I found it cheaper" with real data
5. `propose_bundle(product_id)` → upsell complementary items
6. Sub-typed objections — extend classifier:
   - PRICE → `too_expensive | found_cheaper | bad_value | budget`
   - TRUST → `brand | quality | reviews | warranty | refund`
   - TIMING → `not_ready | comparison | spouse_decision | waiting_for_sale`
   - Match each sub-type to a specific playbook block

> Why second: This is what separates "scripted bot" from "agent that actually converts" — but only useful once Phase A lets you book the result.

### Phase C — "Personalization & multiple personas" (1–2 weeks)
**Goal:** Stop one-size-fits-all.

1. Customer segmentation at call start: `price_sensitive | brand_loyal | researcher | impulse` based on cart value, browsing history, past behavior
2. Persona variants in prompt builder: Alex (calm-expert), Jamie (warm-enthusiastic), Morgan (no-nonsense-direct)
3. Persona × segment routing rules
4. Cross-call memory: "Last time we spoke about the ergonomic chair — did you end up trying one?"
5. Adaptive tone: mirror customer's vocabulary/formality level

### Phase D — "Learning loop" (2–3 weeks)
**Goal:** The agent gets better automatically.

1. `variant_id` + `prompt_version` on every call
2. Tactic tagging: each agent turn labeled with primary tactic used (LAER step, social proof, anchor reset, etc.) — done by a small post-call labeler model
3. Outcome attribution: which (objection_subtype × tactic) pairs led to score increase, conversion, or drop
4. Implement `analyticsWorker` properly: ship turn-level events to ClickHouse / BigQuery
5. Weekly statistical-significance report: "tactic X for objection Y outperforms baseline by Z%"
6. Implement `crmWorker`: sync outcomes to HubSpot/Salesforce so Sales has context

### Phase E — "Real-time conversation intelligence" (1–2 weeks)
**Goal:** Detect and react to subtle signals.

1. Sentiment trajectory tracking (slope of last N turns, not just current)
2. Engagement velocity (response length trend, latency, hesitation markers)
3. "Frustration spike" detector → soften tone immediately, drop a tactic if it's failing
4. "Buying signal" detector → cut pitch, move to close
5. Auto-escalate to human if confidence drops below threshold or frustration crosses limit

### Phase F — "Compliance, safety, hardening" (parallel, ongoing)

1. DNC list integration in `/calls/trigger` (block before placing call)
2. Recording consent at call start, captured in audio
3. Disclosure: "this call may be recorded" / "this is a sales call"
4. TCPA opt-out detection in classifier ("don't call me again") → hard end + DNC add
5. Atomic session updates (Lua / WATCH-MULTI-EXEC)
6. Scoring config pub/sub (kill 5min cache stale window)
7. Server-side discount cap validation in `/generate` (don't trust the model)

---

## Part 4 — Concrete next-up: "tool-calling" architecture

The single biggest unlock is **tools**. Right now the agent only generates text.
Adding tool-calls turns it from a conversationalist into an operator.

**Proposed contract** (extends [shared/contracts/brain-api.types.ts](shared/contracts/brain-api.types.ts)):

```ts
interface GenerateResponseResponse {
  text: string;
  tool_calls?: ToolCall[];   // executed by node-gateway between chunks
}

interface ToolCall {
  name: 'send_checkout_link' | 'check_inventory' | 'create_time_bound_offer'
      | 'record_commitment' | 'get_purchase_stats' | 'transfer_to_human'
      | 'schedule_callback' | 'check_competitor_price' | 'propose_bundle';
  args: Record<string, unknown>;
}
```

**Execution model:**
- Brain emits text + tool_calls
- Node-gateway streams text to Vapi (TTFW preserved)
- In parallel, executes tools (most are <100ms internal calls)
- Tool results land in next turn's context as `tool_results: [...]` so the brain can reference them
- Some tools (`send_checkout_link`, `transfer_to_human`) have side effects the customer experiences immediately

**Minimum viable toolset for Phase A:**
1. `send_checkout_link({discount_percent})` — fire SMS
2. `record_commitment({type: 'email'|'callback_time'|'address', value})`
3. `check_inventory({product_id})` — returns `{stock, low_stock_threshold_crossed}`
4. `transfer_to_human({reason})` — Vapi call transfer
