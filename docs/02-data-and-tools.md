# 02 — Data model + observation tools

This doc covers the Postgres schema, the 6 observation tools the LLM uses to read live data instead of fabricating, and the offers system that lets the agent upsell instead of just discounting.

> **Mental model**: the brain is a single function-calling LLM. Every "fact" in its mouth — *"4.7 stars from 142 reviews, only 4 in stock, ships in 3 days, add the creatine for 5% off"* — comes from a tool call against Postgres. If the tool wasn't called, the agent isn't allowed to claim the fact. This is enforced in HARD_CONSTRAINTS in the prompt.

---

## 1. The schema at a glance

Two Prisma generators run off the same [prisma/schema.prisma](../prisma/schema.prisma): `prisma-client-js` for the Node gateway, `prisma-client-py` (asyncio) for the FastAPI brain.

**Eleven Prisma models.** Ten are live — `customers`, `carts`, `cart_items`, `purchases`, `products`, `product_reviews`, `offers`, `calls`, `call_insights`, `call_turns` — most powering observation tools or promotional behavior, the rest tracking customers, calls, and the dashboard's post-call insights. The eleventh, `scoring_config`, is a vestigial leftover from the rules-engine era — written with placeholder values and unused by the converse pipeline. The rest of that era is *gone, not dormant*: the `CallTurn.stage` / `scoreBefore` / `scoreAfter` and `Call.finalScore` / `stageReached` columns were **physically dropped** in the `20260522120000` migration, so only the `scoring_config` table itself survives. Safe to drop in a future migration.

```
customers ──┬─► carts ── cart_items ──┐
            ├─► purchases ─────────────┼──► products ──┬── product_reviews
            └─► calls ──┬─ call_turns  │               ├── offers (× 2 FK roles)
                        └─ call_insight │               └── inventory_count
                           (1:1)        │
```

### Key Prisma definitions

[prisma/schema.prisma:68-88](../prisma/schema.prisma#L68-L88)

```prisma
model Customer {
  id                  String          @id @default(uuid())
  phone               String          @unique // E.164
  name                String?
  email               String?
  lifetimeValue       Decimal         @default(0) @db.Decimal(10, 2) @map("lifetime_value")
  segment             CustomerSegment @default(FIRST_TIME)
  priorCallsCount     Int             @default(0) @map("prior_calls_count")
  timezone            String?         // e.g. "America/Los_Angeles"
  preferredContact    String?         @map("preferred_contact") // 'whatsapp' | 'email' | 'phone'
  createdAt           DateTime        @default(now()) @map("created_at")
  updatedAt           DateTime        @updatedAt @map("updated_at")

  carts     Cart[]
  purchases Purchase[]
  calls     Call[]

  @@index([phone])
  @@index([segment])
  @@map("customers")
}
```

The `segment` enum is what drives the agent's tone — `FIRST_TIME` gets the trust-building variant, `VIP` gets a warmer recap, `LAPSED` gets the *"been a while"* opener. See [03-prompt-and-conversion.md](03-prompt-and-conversion.md) for how those flow into the prompt.

### `Cart` — the thing the agent is calling about

[prisma/schema.prisma:43-48, 90-104](../prisma/schema.prisma#L90-L104)

```prisma
enum CartStatus {
  ACTIVE      // user is shopping right now
  ABANDONED   // user left without checking out
  CONVERTED   // user completed checkout (possibly via this agent)
  DELETED     // user explicitly emptied
}

model Cart {
  id          String     @id @default(uuid())
  customerId  String     @map("customer_id")
  status      CartStatus @default(ACTIVE)
  abandonedAt DateTime?  @map("abandoned_at")
  // ... createdAt / updatedAt, items CartItem[]
}
```

The recovery flow targets `status = ABANDONED` carts. `abandonedAt` is the load-bearing field: `prompt_sections.format_cart` buckets it into a 5-step **freshness urgency cue** (`just now` / `~45 min ago` / `~3h ago` / `yesterday` / `4 days ago`) and renders matching tone guidance into the prompt — a cart abandoned five minutes ago gets a different opener than one cold for four days. The `@@index([status, abandonedAt])` makes the "find stale abandoned carts" scan cheap. Line items live in `cart_items` with a `priceAtAdd` snapshot so the agent quotes the price the customer actually saw.

[prisma/schema.prisma:231-259](../prisma/schema.prisma#L231-L259)

```prisma
model Product {
  id              String    @id
  name            String
  description     String?
  price           Decimal   @db.Decimal(10, 2)
  category        String?
  tags            String[]
  isActive        Boolean   @default(true) @map("is_active")
  embeddingSynced Boolean   @default(false) @map("embedding_synced")
  // Inventory snapshot, used by the check_inventory observation tool.
  // Null = unknown / unmanaged. Restock ETA is null when in stock.
  inventoryCount  Int?      @map("inventory_count")
  restockEta      DateTime? @map("restock_eta")
  stockUpdatedAt  DateTime? @map("stock_updated_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  metadata        Json?     @map("metadata")

  cartItems    CartItem[]
  purchases    Purchase[]
  reviews      ProductReview[]
  offers       Offer[] @relation("ProductOffers")
  bundleOffers Offer[] @relation("BundleProductOffers")

  // ...
}
```

Notable columns:
- **`metadata` jsonb** — rich per-product structured data (nutrition profiles for proteins, dimensions for chairs, material/care for apparel). Not currently surfaced to the prompt — open optimization.
- **`inventoryCount` + `restockEta`** — what `check_inventory` reads. `LOW_STOCK_THRESHOLD = 10` is hardcoded.
- **`embeddingSynced`** — flag that `embed-products.py` flips after upserting to Pinecone. Cosmetic; not used in any search path.
- **Two `Offer[]` relations** — one for the primary product (`ProductOffers`), one for the complementary bundle product (`BundleProductOffers`). A creatine bundle offer references whey-isolate as primary AND creatine-mono as bundle product, so creatine appears in `bundleOffers` while whey appears in `offers`.

### The `Offer` model

[prisma/schema.prisma:50-53, 261-285](../prisma/schema.prisma#L261-L285)

```prisma
enum OfferType {
  BUNDLE   // "buy this product with X for Y% off"
  QUANTITY // "buy N+ of this product for Y% off"
}

model Offer {
  id              String    @id @default(uuid())
  productId       String    @map("product_id") // primary product the offer attaches to
  type            OfferType
  description     String    // long-form: "Bundle Whey Isolate with Creatine for 5% off both items"
  shortPitch      String    @map("short_pitch") // phone-friendly: "add Creatine and I can knock 5% off the whole order"
  discountPercent Int       @map("discount_percent") // 0-25; agent can still go higher only via the flat-discount cap (10%)

  // BUNDLE: complementary product the customer must add to qualify
  bundleProductId String?   @map("bundle_product_id")
  // QUANTITY: minimum count of the primary product to qualify
  minQuantity     Int?      @map("min_quantity")

  isActive        Boolean   @default(true) @map("is_active")
  validUntil      DateTime? @map("valid_until")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  product       Product  @relation("ProductOffers", fields: [productId], references: [id])
  bundleProduct Product? @relation("BundleProductOffers", fields: [bundleProductId], references: [id])

  @@index([productId, isActive])
  @@index([type, isActive])
  @@map("offers")
}
```

The two named relations are what let an offer be both *attached* to a primary product and *reference* a bundle product. Without the named relations, Prisma can't resolve which FK is which.

### `Call`, `CallInsight`, and `CallTurn` — the audit trail

[prisma/schema.prisma:153-229](../prisma/schema.prisma#L153-L229)

```prisma
model Call {
  id              String      @id @default(uuid())
  callId          String      @unique @map("call_id")
  customerId      String?     @map("customer_id") // nullable for unknown callers
  phoneNumber     String?     @map("phone_number")
  createdAt       DateTime    @default(now()) @map("created_at")
  endedAt         DateTime?   @map("ended_at")
  durationSeconds Int?        @map("duration_seconds")
  outcome         CallOutcome?
  discountGiven   Int         @default(0) @map("discount_given")
  productId       String?     @map("product_id")
  recordingUrl        String?  @map("recording_url")
  stereoRecordingUrl  String?  @map("stereo_recording_url")
  providerRecordingId String?  @map("provider_recording_id")
  voiceProvider       String?  @map("voice_provider")

  customer Customer?    @relation(fields: [customerId], references: [id])
  turns    CallTurn[]
  insight  CallInsight?
}

model CallTurn {
  id               String     @id @default(uuid())
  callId           String     @map("call_id")
  turnNumber       Int        @map("turn_number")
  speaker          Speaker
  utterance        String
  objectionType    String?    @map("objection_type")
  objectionSubtype String?    @map("objection_subtype")
  sentiment        Sentiment?
  discountOffered  Int?       @map("discount_offered")
  // Tool attribution under the converse pipeline. Only set on AGENT turns
  // when the LLM picked a tool. Null for text-only turns and USER turns.
  toolCalled         String?  @map("tool_called")
  toolArgs           Json?    @map("tool_args")
  observationsCalled Json?    @map("observations_called")
  // Turn-quality signals (20260522120000 migration). pushAttempt on AGENT
  // turns; responseLatencyMs on USER turns; observationLatenciesMs on AGENT
  // turns that ran observation tools.
  pushAttempt            Int?  @map("push_attempt")
  responseLatencyMs      Int?  @map("response_latency_ms")
  observationLatenciesMs Json? @map("observation_latencies_ms")
  createdAt          DateTime  @default(now()) @map("created_at")
}
```

Note what's *not* here anymore: the rules-engine columns `scoreBefore` / `scoreAfter` / `stage` (on `CallTurn`) and `finalScore` / `stageReached` (on `Call`) were dropped in `20260522120000` — the converse pipeline replaced the score/stage machine with a single LLM call per turn.

**Outcome detection rule** — under the converse pipeline, a call is `CONVERTED` iff some `CallTurn` row has `toolCalled = 'send_whatsapp_checkout_link'`. Everything else is `DROPPED`. See [01-runtime-flow.md §8](01-runtime-flow.md) for the detection code.

**Async tagging** — the three columns `objectionType`, `objectionSubtype`, `sentiment` are populated by the `classify-analytics-queue` worker, NOT by the response-path code. This keeps the hot path free of the classifier roundtrip.

**Recent-turn signals** — those async `sentiment` + `objectionType` tags are read back on later turns by `db.service.ts:getRecentTurnSignals()` to build the sentiment-streak / repeated-objection signals the brain adapts to. See [01-runtime-flow.md §4.2](01-runtime-flow.md) and [ARCHITECTURE_STUDY.md §4.9](../ARCHITECTURE_STUDY.md).

**New telephony + provider columns on `Call`** — `voiceProvider` records which adapter ran the call (the multi-provider abstraction writes it; see [ARCHITECTURE_STUDY.md §4.1.1](../ARCHITECTURE_STUDY.md)), and `recordingUrl` / `stereoRecordingUrl` / `providerRecordingId` hold the post-call recording handles. The provider columns landed in `20260520000000_telnyx_provider_columns`; the recording URLs + `observationsCalled` in `20260518100000_dashboard_support`.

### `CallInsight` — the dashboard's post-call summary

[prisma/schema.prisma:177-199](../prisma/schema.prisma#L177-L199)

```prisma
enum OverallSentiment {
  POSITIVE
  NEUTRAL
  NEGATIVE
  MIXED
}

enum InsightStatus {
  PENDING
  READY
  FAILED
}

model CallInsight {
  callId              String           @id @map("call_id")
  status              InsightStatus    @default(PENDING)
  summary             String           @default("")
  overallSentiment    OverallSentiment @default(NEUTRAL) @map("overall_sentiment")
  emotions            String[]         @default([])
  sentimentTrend      String           @default("stable") @map("sentiment_trend")
  sentimentConfidence Float            @default(0) @map("sentiment_confidence")
  serviceConcerns     Json             @default("[]") @map("service_concerns")
  tags                Json             @default("[]")
  modelUsed           String?          @map("model_used")
  fallbackUsed        Boolean          @default(false) @map("fallback_used")
  promptTokens        Int?             @map("prompt_tokens")
  completionTokens    Int?             @map("completion_tokens")
  retryCount          Int              @default(0) @map("retry_count")
  errorMessage        String?          @map("error_message")
  generatedAt         DateTime         @default(now()) @updatedAt @map("generated_at")

  call Call @relation(fields: [callId], references: [callId])

  @@index([status])
  @@map("call_insights")
}
```

A 1:1 record keyed by `call_id` (no surrogate uuid — the `callId` IS the PK). It's written **on demand** by `POST /insights/generate`, which loads the `Call` + its turns, asks the LLM (`response_format: json_object`) for a structured `summary` / `overallSentiment` / `emotions` / `sentimentTrend` / `serviceConcerns` / `tags`, and upserts the row. `status` is the state machine the dashboard polls (`PENDING` → `READY` / `FAILED`); the `modelUsed` / `fallbackUsed` / `promptTokens` / `completionTokens` / `retryCount` columns are observability for the generation itself. See [ARCHITECTURE_STUDY.md §4.2](../ARCHITECTURE_STUDY.md) for the route. This table + both enums landed in `20260518100000_dashboard_support`.

---

## 2. Observation tools — the agent's senses

Six tools live in [observations.py](../fastapi-brain/app/services/observations.py). Each one hits Postgres via Prisma-py, returns a JSON-serializable dict, and gets fed back into the LLM's conversation as a `tool` message so the next response is grounded.

The dispatcher at the bottom is what `converse_response_stream` calls when the model emits an observation tool call:

[fastapi-brain/app/services/observations.py:272-288](../fastapi-brain/app/services/observations.py#L272-L288)

```python
async def execute_observation_tool(
    db: Prisma, name: str, args: dict[str, Any]
) -> dict[str, Any]:
    """Dispatch an observation tool by name. Args are pre-validated by tools.parse_tool_call."""
    if name == "check_inventory":
        return await check_inventory(db, args["product_id"])
    if name == "get_recent_purchases":
        return await get_recent_purchases(db, args["product_id"], args.get("days", 30))
    if name == "get_review_summary":
        return await get_review_summary(db, args["product_id"])
    if name == "get_delivery_eta":
        return await get_delivery_eta(db, args["zip_code"], args["product_id"])
    if name == "get_available_offers":
        return await get_available_offers(db, args["product_id"])
    if name == "list_products":
        return await list_products(db, args.get("category"), args.get("max_results", 8))
    return {"error": f"unknown_observation_tool: {name}"}
```

### 2.1 `check_inventory(product_id)` — honest scarcity

[fastapi-brain/app/services/observations.py:21-50](../fastapi-brain/app/services/observations.py#L21-L50)

```python
LOW_STOCK_THRESHOLD = 10

async def check_inventory(db: Prisma, product_id: str) -> dict[str, Any]:
    product = await db.product.find_unique(where={"id": product_id})
    if product is None:
        return {"error": "product_not_found", "product_id": product_id}

    if product.inventoryCount is None:
        return {
            "product_id": product_id,
            "in_stock": None,
            "low_stock": False,
            "restock_eta_days": None,
            "note": "inventory not tracked for this product",
        }

    in_stock = product.inventoryCount
    low_stock = in_stock <= LOW_STOCK_THRESHOLD
    restock_eta_days: int | None = None
    if product.restockEta is not None and in_stock == 0:
        # restockEta is tz-aware (timestamptz) — compare against tz-aware now.
        delta = product.restockEta - datetime.now(UTC)
        restock_eta_days = max(0, delta.days)

    return {
        "product_id": product_id,
        "in_stock": in_stock,
        "low_stock": low_stock,
        "restock_eta_days": restock_eta_days,
    }
```

Used when the customer asks *"how many are left?"* OR when the agent wants honest scarcity (e.g. *"only 4 in stock — heads up"*). The system prompt explicitly forbids inventing stock numbers, so if this tool returns `in_stock: null`, the agent says it doesn't know.

### 2.2 `get_recent_purchases(product_id, days)` — honest social proof

[fastapi-brain/app/services/observations.py:56-64](../fastapi-brain/app/services/observations.py#L56-L64)

```python
async def get_recent_purchases(db: Prisma, product_id: str, days: int) -> dict[str, Any]:
    since = datetime.now(UTC) - timedelta(days=days)
    count = await db.purchase.count(
        where={
            "productId": product_id,
            "purchasedAt": {"gte": since},
        }
    )
    return {"product_id": product_id, "count": count, "days": days}
```

Used to back claims like *"we shipped 47 of these in the last 30 days"*. The `purchases.purchased_at` index makes this a fast scan. Only valid if the count is high enough to actually persuade — the prompt instructs the agent not to surface the number when it would be unimpressive.

### 2.3 `get_review_summary(product_id)` — verbatim quotes

[fastapi-brain/app/services/observations.py:70-106](../fastapi-brain/app/services/observations.py#L70-L106)

```python
async def get_review_summary(db: Prisma, product_id: str) -> dict[str, Any]:
    # DB-side aggregation instead of loading every review into Python: a count,
    # a grouped average, and one ordered row each for the top positive/critical
    # quote. Four bounded queries vs. an unbounded full-table scan.
    count = await db.productreview.count(where={"productId": product_id})
    if not count:
        return {"product_id": product_id, "count": 0, "avg_rating": None,
                "top_positive_quote": None, "top_critical_quote": None}

    grouped = await db.productreview.group_by(
        by=["productId"],
        where={"productId": product_id},
        avg={"rating": True},
    )
    avg_raw = grouped[0]["_avg"]["rating"] if grouped else None
    avg = round(avg_raw, 2) if avg_raw is not None else None

    # Top quotes: highest-helpful 4-5 star and highest-helpful <=3 star.
    positive = await db.productreview.find_first(
        where={"productId": product_id, "rating": {"gte": 4}},
        order={"helpful": "desc"},
    )
    critical = await db.productreview.find_first(
        where={"productId": product_id, "rating": {"lte": 3}},
        order={"helpful": "desc"},
    )

    return {
        "product_id": product_id,
        "count": count,
        "avg_rating": avg,
        "top_positive_quote": positive.body if positive else None,
        "top_positive_rating": positive.rating if positive else None,
        "top_critical_quote": critical.body if critical else None,
        "top_critical_rating": critical.rating if critical else None,
    }
```

Returns one positive + one critical quote (highest `helpful` count in each tier). The selection moved **DB-side** — a count, a grouped average, and one ordered `find_first` per tier, instead of loading every review into Python and scanning. The prompt rule is **quote verbatim** — the agent reads back the actual text, doesn't paraphrase.

**Design choice** — returning a critical review on purpose is a trust move. *"Most loved it; one buyer said the cushion compressed too fast"* — acknowledging known downsides converts more reliably than only positive cherry-picks.

### 2.4 `get_delivery_eta(zip_code, product_id)` — closing lever

[fastapi-brain/app/services/observations.py:113-125, 187-212](../fastapi-brain/app/services/observations.py#L187-L212)

```python
_ZIP_PREFIX_DAYS: list[tuple[str, int, int]] = [
    # (zip prefix, standard_days, expedited_days)
    ("9", 2, 1),  # West Coast
    ("8", 3, 1),  # Mountain
    # ... 0-9
    ("0", 5, 2),  # New England + Puerto Rico
]

async def get_delivery_eta(db: Prisma, zip_code: str, product_id: str) -> dict[str, Any]:
    product = await db.product.find_unique(where={"id": product_id})
    if product is None:
        return {"error": "product_not_found", "product_id": product_id}
    # ... zip prefix lookup
    return {"zip_code": zip_code, "product_id": product_id,
            "standard_days": std, "expedited_days": exp}
```

**Demo simplification** — real implementation would call the carrier's API or look up shipping zones from the warehouse location. The hardcoded zip-prefix table is good enough to demonstrate the closing-lever pattern (*"if you order today, you'd have it Wednesday"*).

### 2.5 `get_available_offers(product_id)` — the offers ladder data source

[fastapi-brain/app/services/observations.py:131-181](../fastapi-brain/app/services/observations.py#L131-L181)

```python
async def get_available_offers(db: Prisma, product_id: str) -> dict[str, Any]:
    """Return active promotional offers for a product.

    BUNDLE: customer must add `bundle_product` to qualify.
    QUANTITY: customer must order at least `min_quantity` of this product.

    The agent uses these to make value-add offers (cross-sell, upsell)
    instead of jumping straight to a flat negotiation discount."""
    product = await db.product.find_unique(where={"id": product_id})
    if product is None:
        return {"error": "product_not_found", "product_id": product_id}

    offers = await db.offer.find_many(
        where={"productId": product_id, "isActive": True},
        order={"discountPercent": "desc"},
    )
    if not offers:
        return {"product_id": product_id, "offers": []}

    # Batch the bundle-product lookups into one query instead of a find_unique
    # per BUNDLE offer (N+1).
    bundle_ids = list(
        {o.bundleProductId for o in offers if o.type == "BUNDLE" and o.bundleProductId}
    )
    bundles_by_id: dict[str, Any] = {}
    if bundle_ids:
        bundles = await db.product.find_many(where={"id": {"in": bundle_ids}})
        bundles_by_id = {b.id: b for b in bundles}

    rendered: list[dict[str, Any]] = []
    for o in offers:
        item: dict[str, Any] = {
            "id": o.id,
            "type": o.type,  # 'BUNDLE' | 'QUANTITY'
            "discount_percent": o.discountPercent,
            "short_pitch": o.shortPitch,
            "description": o.description,
        }
        if o.type == "BUNDLE" and o.bundleProductId:
            bundle = bundles_by_id.get(o.bundleProductId)
            if bundle:
                item["bundle_product"] = {
                    "product_id": bundle.id,
                    "name": bundle.name,
                    "price": float(bundle.price),
                }
        elif o.type == "QUANTITY" and o.minQuantity is not None:
            item["min_quantity"] = o.minQuantity
        rendered.append(item)

    return {"product_id": product_id, "offers": rendered}
```

This is what powers the agent's *"add the creatine and I can knock 5% off the whole order"* line. The `short_pitch` field is **phone-friendly verbatim copy** that the agent reads aloud. Marketing controls these strings; the agent never invents them.

**Why ordered by discount desc** — if multiple offers apply, the most generous one floats first. The agent picks the strongest pitch.

**Why we re-fetch the bundle product** — the `Offer` row only stores the bundle product's ID; the agent needs the name + price to actually pitch it ("add the creatine for $24.99"). The bundle lookups are **batched into one `find_many`** keyed by the distinct `bundleProductId` set, so the whole tool is two queries (offers + bundles) regardless of how many BUNDLE offers come back — no per-offer N+1.

### 2.6 `list_products(category?, max_results)` — catalog browse

[fastapi-brain/app/services/observations.py:218-266](../fastapi-brain/app/services/observations.py#L218-L266)

```python
async def list_products(
    db: Prisma, category: str | None = None, max_results: int = 8
) -> dict[str, Any]:
    """Catalog-browse helper for "what else do you have?" questions."""
    rows = await db.product.find_many(where={"isActive": True})

    # Category counts across the full active catalog.
    counts: dict[str, int] = {}
    for r in rows:
        key = r.category or "(uncategorized)"
        counts[key] = counts.get(key, 0) + 1
    # ... sort categories by count desc, filter to `category` (case-insensitive),
    #     order filtered rows by (category asc, price asc), slice to max_results
    return {
        "categories": categories,    # [{name, count}]
        "products": products,        # [{product_id, name, price, category}]
        "total_active": len(rows),
        "filtered_total": len(filtered),
        "category_filter": category,
    }
```

The newest observation tool. It answers the broad *"what else do you have?"* / *"do you carry any protein?"* questions — returns a category summary plus a small (`max_results`, default 8, capped at 20) product list. One `find_many` over the small active-products table; counts and ordering happen in Python. `category` is a soft, **case-insensitive** filter so the LLM can pass `"office"` / `"Office"` / `"OFFICE"` and still match.

**Why it's NOT the pivot tool** — the tool description is emphatic that `list_products` is for browsing, not for the price-objection pivot. The prompt already hands the agent the `ALTERNATIVE PRODUCT` / `PREMIUM ALTERNATIVE` for the current category (the Pinecone lookups in §6), so the agent never burns a tool round-trip just to find a cheaper alt. And the description tells it to **summarize, not read the list verbatim** — *"yeah, we've got chairs, proteins, and a few apparel pieces — anything in particular?"*

---

## 3. How an observation result re-enters the conversation

The observation-tool loop in [llm.py](../fastapi-brain/app/services/llm.py) is the magic that lets the LLM ground its responses in real data. Walkthrough below.

[fastapi-brain/app/services/llm.py:176-305](../fastapi-brain/app/services/llm.py#L176-L305)

When the LLM emits a tool call:

```python
async for chunk in stream:
    if not chunk.choices: continue
    choice = chunk.choices[0]
    delta = choice.delta

    if delta.content:
        total_text_chunks += 1
        this_pass_text_parts.append(delta.content)
        yield {"type": "text", "delta": delta.content}

    if delta.tool_calls:
        for tc in delta.tool_calls:
            idx = tc.index if tc.index is not None else 0
            buf = tool_buffers.setdefault(idx, {"id": "", "name": "", "args_json": ""})
            if tc.id: buf["id"] = tc.id
            if tc.function and tc.function.name: buf["name"] = tc.function.name
            if tc.function and tc.function.arguments: buf["args_json"] += tc.function.arguments
```

After the SSE stream ends, the brain decides what to do with each parsed tool call:

```python
observation_calls = [c for c in parsed_calls if c["name"] in _OBSERVATION_TOOL_NAMES]
side_effect_calls = [c for c in parsed_calls if c["name"] not in _OBSERVATION_TOOL_NAMES]

# If the model called observation tools AND we have a runner, execute them and loop.
if observation_calls and run_observation_tool is not None and tool_turn < MAX_TOOL_TURNS:
    # 1) Append the assistant message with all tool_calls
    working_messages.append({
        "role": "assistant",
        "content": assistant_text or None,
        "tool_calls": [
            {"id": c["id"], "type": "function",
             "function": {"name": c["name"], "arguments": c["args_json"]}}
            for c in parsed_calls
        ],
    })

    # 2) Emit a thinking event per tool (so the gateway can fill dead air),
    #    then run the DB roundtrips CONCURRENTLY — each await is audible
    #    latency on a live call and the reads are independent.
    for c in observation_calls:
        yield {"type": "thinking", "tool": c["name"]}

    results = await asyncio.gather(*(_run_observation(c) for c in observation_calls))

    for c, result in zip(observation_calls, results):
        yield {"type": "observation", "name": c["name"], "args": c["args"], "result": result}
        working_messages.append({
            "role": "tool",
            "tool_call_id": c["id"],
            "content": json.dumps(result),
        })

    # 3) Loop back for another pass
    continue
```

The LLM sees the result, then re-streams its response with the data baked in. The observation tools run **concurrently** via `asyncio.gather` — each await is audible latency on a live call, and the reads are independent, so a multi-tool turn (e.g. inventory + reviews together) pays one round-trip, not two. `_run_observation` wraps each call in a try/except so one failed tool returns `{"error": "tool_execution_failed"}` instead of taking the whole turn down. The loop is bounded by `MAX_TOOL_TURNS = 4` ([llm.py:63](../fastapi-brain/app/services/llm.py#L63)) so a misbehaving model can't spin forever.

**Side-effect tools** (`send_whatsapp_*`) skip the loop — they emit a `tool_call` SSE event that bubbles up to the gateway, which dispatches them out-of-band. The agent's last text utterance ("Sending it to your WhatsApp now") was streamed BEFORE the tool call, so by the time the customer hears that line, the WhatsApp request is already in flight.

---

## 4. Tool registration — Pydantic schemas → OpenAI tool definitions

The LLM only knows about tools that are in `OPENAI_TOOLS` ([tools.py](../fastapi-brain/app/services/tools.py)) — **8 in total**, split into two sets: `SIDE_EFFECT_TOOLS` (2: `send_whatsapp_checkout_link`, `send_whatsapp_product_info`) and `OBSERVATION_TOOLS` (6: the five above plus `list_products`). `TOOL_ARG_MODELS` maps each tool name to its Pydantic args model; the `ToolName` `Literal` and these two sets are the single source of truth `llm.py` imports so routing never drifts. Each tool is described by a Pydantic model whose `.model_json_schema()` becomes the JSON schema OpenAI sees.

[fastapi-brain/app/services/tools.py:33-44](../fastapi-brain/app/services/tools.py#L33-L44)

```python
class SendCheckoutLinkArgs(BaseModel):
    discount_percent: int = Field(
        default=0,
        ge=0,
        le=MAX_DISCOUNT_PERCENT,
        description=(
            f"Discount percent to apply on the checkout link, 0-{MAX_DISCOUNT_PERCENT}. "
            "Use 0 by default. Only use 5-10 when the customer has pushed back "
            "on price and the concession ladder is appropriate (5 first, 10 max)."
        ),
    )
```

`Field(ge=0, le=10)` (with `MAX_DISCOUNT_PERCENT = 10`) is **layer 1 of the discount defense-in-depth**. The `description` is what the LLM reads to decide WHEN to use which discount. The enforcement happens in `parse_tool_call(name, raw_args)`, which re-validates the LLM's returned args against the registered Pydantic model — a `discount_percent=15` raises `ValidationError` rather than reaching the gateway, so a jailbroken model can't talk its way past the cap.

Tool definitions get assembled into the OpenAI payload:

[fastapi-brain/app/services/tools.py:139-155](../fastapi-brain/app/services/tools.py#L139-L155)

```python
OPENAI_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "send_whatsapp_checkout_link",
            "description": (
                "Send a checkout link to the customer's WhatsApp. Call this when "
                "the customer is ready to buy — explicit yes, agreeing to a "
                "discount, asking logistics like shipping or payment methods, or "
                "after they've made a clear commitment. ALWAYS speak ONE short "
                "confirmation sentence first ('sending it to your WhatsApp now'), "
                "then call this. Never call this on a turn where they raised a "
                "fresh objection."
            ),
            "parameters": SendCheckoutLinkArgs.model_json_schema(),
        },
    },
    # ... 7 more tools (8 total: 2 side-effect + 6 observation)
]
```

Each tool's `description` doubles as **prompt engineering** — it tells the LLM precisely when to use the tool. The `get_available_offers` description is particularly explicit:

[fastapi-brain/app/services/tools.py:226-244](../fastapi-brain/app/services/tools.py#L226-L244)

```python
{
    "type": "function",
    "function": {
        "name": "get_available_offers",
        "description": (
            "Get the active promotional offers attached to a product — "
            "BUNDLE offers (buy this with another product for N% off) and "
            "QUANTITY offers (buy ≥N for N% off). Returns "
            "{ offers: [{type, discount_percent, short_pitch, "
            "bundle_product?, min_quantity?}] }. CALL THIS BEFORE giving a "
            "flat negotiation discount on a price objection — pre-authorized "
            "offers are stronger than ad-hoc concessions because they "
            "increase order value, not just margin. If no offers exist or "
            "none fit the customer's situation, then fall back to the "
            "discount ladder. Do NOT invent an offer the tool didn't return."
        ),
        "parameters": GetAvailableOffersArgs.model_json_schema(),
    },
},
```

The "CALL THIS BEFORE..." line is doing real work — it's what shifts the agent's behavior from "throw discounts at every objection" to "find a value-add offer first."

---

## 5. The seed pipeline

[scripts/seed-demo-data.ts](../scripts/seed-demo-data.ts) is a single ~1400-line script that's idempotent (re-runnable). It seeds:

| What | Count | Notes |
|---|---|---|
| Products | 43 active | 8 chairs/accessories, 14 nutrition products (proteins + creatine + shaker), 20 apparel size-variants (5 base × 4 sizes), 1 lumbar pillow, 1 mat |
| Reviews | 72 | Mix of positive + critical, varying `helpful` counts so quotes are realistic |
| Customers | 10 | Spans all 4 segments (FIRST_TIME, RETURNING, VIP, LAPSED) |
| Carts (abandoned) | 10 | One per customer, varying staleness via `abandonedAt` |
| Past purchases | 20 | Drives the `Customer.lifetimeValue` calculation + cross-sell signals |
| Offers | 17 | 13 BUNDLE (protein × creatine, chair × mat, hoodie × joggers per matching size) + 4 QUANTITY (2× protein, 2× tee per size). Offers whose referenced products aren't in the seed are skipped, not errored |

**The most architecturally interesting bit** is the protein generator. Real-world per-100g amino-acid profiles for each protein type drive a generator that scales to actual scoop sizes.

[scripts/seed-demo-data.ts:283-318](../scripts/seed-demo-data.ts#L283-L318)

```typescript
const PROTEIN_PROFILES: Record<ProteinType, ProteinProfile> = {
  'whey-isolate': {
    display_name: 'Whey Protein Isolate',
    source: "Cow's milk (cross-flow microfiltered)",
    is_vegan: false,
    filtration_method: 'Cross-flow microfiltration',
    digest_speed: 'fast',
    protein_g_per_100g_powder: 90,
    fat_g_per_100g_powder: 1.5,
    saturated_fat_g_per_100g_powder: 0.8,
    carbs_g_per_100g_powder: 3,
    sugar_g_per_100g_powder: 1.5,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 18,
    sodium_mg_per_100g_powder: 200,
    aa_per_100g_protein: {
      leucine: 10.6, isoleucine: 6.0, valine: 5.8,
      lysine: 9.6, methionine: 2.4, phenylalanine: 3.0,
      threonine: 5.6, tryptophan: 2.0, histidine: 1.8,
      arginine: 2.4, alanine: 5.0, aspartic_acid: 11.0,
      cysteine: 2.0, glutamic_acid: 16.4, glycine: 1.7,
      proline: 5.5, serine: 4.8, tyrosine: 2.7,
    },
    glutamine_pct_of_protein: 16,
    base_allergens: ['Milk'],
    base_certifications: ['Grass-Fed', 'rBGH-Free', 'Non-GMO'],
  },
  // ... whey-concentrate, whey-hydrolysate, whey-native, casein, pea-isolate,
  //     rice-isolate, plant-blend, egg-white
};
```

The `proteinProduct(spec)` builder takes a `ProteinSpec` (id, type, flavor, size_lb, scoop_size_g, price, ...) and computes per-scoop nutrition + amino acid breakdown by scaling the per-100g profile to the actual scoop size. That's why a 30g whey-isolate scoop has 27g protein and 6.1g BCAAs while a 30g pea-isolate scoop has 24g protein and 4.3g BCAAs — internally consistent across the dataset, derived from real-world numbers.

The full nutrition + amino acid breakdown gets stored in `Product.metadata` jsonb, ready for future surfacing to the prompt.

---

## 6. The Pinecone integration (vector layer)

Two indexes:

- **`voice-agent-products`** (dim=1536, cosine) — embeds product `name + description + tags` via OpenAI's `text-embedding-3-small`. Powers `/products/alternatives` (the cheaper-alt and premium-alt lookups below in this section).
- **`voice-agent-objections`** — labeled utterance examples for the hybrid classifier. Used only by the analytics-only classifier path.

[scripts/embed-products.py](../scripts/embed-products.py) is the seed script. It **wipes the product index before re-upserting** to avoid stale entries from prior demo state polluting the search:

```python
try:
    index.delete(delete_all=True)
    print("Wiped existing vectors from Pinecone index (clean slate).")
except Exception as exc:
    if "not found" in str(exc).lower() or "404" in str(exc):
        print("Pinecone index was already empty.")
    else:
        print(f"Pinecone delete_all warning (continuing anyway): {exc}")
```

The cheaper-alternative search filters by `category` to prevent the *"chair → hoodie"* failure mode that surfaced earlier:

[fastapi-brain/app/services/product.py:67-94](../fastapi-brain/app/services/product.py#L67-L94)

```python
async def find_cheaper_alternative(
    current_price: float,
    query: str,
    exclude_id: str,
    category: str | None = None,
) -> ProductContext | None:
    """Find a cheaper product to pivot to.

    `category` is a soft constraint: when provided, we filter Pinecone to
    matching-category products. This stops the agent from suggesting a $39
    hoodie as a 'cheaper alternative' to a $349 ergonomic chair.
    """
    log = get_logger()
    vector = await embed_text(query)

    pinecone_filter: dict = {
        "price": {"$lt": current_price},
        "product_id": {"$ne": exclude_id},
    }
    if category:
        pinecone_filter["category"] = {"$eq": category}

    results = _index.query(
        vector=vector,
        top_k=3,
        filter=pinecone_filter,
        include_metadata=True,
    )
    # ... extract and return the top match as ProductContext
```

The `find_alternatives` variant (used for premium anchoring) takes a `min_price` instead — same shape, opposite direction. Both are wired to the same Pinecone index; only the filter changes.

---

## Connecting the dots

Reading order if you're studying this:

1. Schema first: open [prisma/schema.prisma](../prisma/schema.prisma) and skim every model
2. Then [observations.py](../fastapi-brain/app/services/observations.py) end-to-end (it's only ~290 lines)
3. Then [tools.py](../fastapi-brain/app/services/tools.py) to see how each of the 8 tools gets exposed to the LLM
4. Then `converse_response_stream` in [llm.py](../fastapi-brain/app/services/llm.py) to see how the observation loop works
5. Finally [seed-demo-data.ts](../scripts/seed-demo-data.ts) to see how realistic test data gets generated

Continue to **[03-prompt-and-conversion.md](03-prompt-and-conversion.md)** for the system prompt + sales principles that drive when each tool gets called.
