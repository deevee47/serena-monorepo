# 02 — Data model + observation tools

This doc covers the Postgres schema, the 5 observation tools the LLM uses to read live data instead of fabricating, and the offers system that lets the agent upsell instead of just discounting.

> **Mental model**: the brain is a single function-calling LLM. Every "fact" in its mouth — *"4.7 stars from 142 reviews, only 4 in stock, ships in 3 days, add the creatine for 5% off"* — comes from a tool call against Postgres. If the tool wasn't called, the agent isn't allowed to claim the fact. This is enforced in HARD_CONSTRAINTS in the prompt.

---

## 1. The schema at a glance

Two Prisma generators run off the same [prisma/schema.prisma](../prisma/schema.prisma): `prisma-client-js` for the Node gateway, `prisma-client-py` (asyncio) for the FastAPI brain.

Eight tables, three of them powering observation tools, one of them powering promotional behavior, four of them tracking customers and calls.

```
customers ──┬─► carts ── cart_items ──┐
            ├─► purchases ─────────────┼──► products ──┬── product_reviews
            └─► calls ── call_turns    │               ├── offers (× 2 FK roles)
                                        │               └── inventory_count
```

### Key Prisma definitions

[prisma/schema.prisma:50-70](../prisma/schema.prisma#L50-L70)

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

[prisma/schema.prisma:182-217](../prisma/schema.prisma#L182-L217)

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

[prisma/schema.prisma:221-249](../prisma/schema.prisma#L221-L249)

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

### `Call` and `CallTurn` — the audit trail

[prisma/schema.prisma:135-180](../prisma/schema.prisma#L135-L180)

```prisma
model Call {
  id              String      @id @default(uuid())
  callId          String      @unique @map("call_id")
  customerId      String?     @map("customer_id")
  phoneNumber     String?     @map("phone_number")
  createdAt       DateTime    @default(now()) @map("created_at")
  endedAt         DateTime?   @map("ended_at")
  durationSeconds Int?        @map("duration_seconds")
  outcome         CallOutcome?
  finalScore      Int?        @map("final_score")
  discountGiven   Int         @default(0) @map("discount_given")
  stageReached    String?     @map("stage_reached")
  productId       String?     @map("product_id")

  customer Customer?  @relation(fields: [customerId], references: [id])
  turns    CallTurn[]
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
  scoreBefore      Int        @map("score_before")
  scoreAfter       Int        @map("score_after")
  stage            String
  discountOffered  Int?       @map("discount_offered")
  // Tool attribution under the converse pipeline. Only set on AGENT turns
  // when the LLM picked a tool. Null for text-only turns and USER turns.
  toolCalled       String?    @map("tool_called")
  toolArgs         Json?      @map("tool_args")
  createdAt        DateTime   @default(now()) @map("created_at")
}
```

**Outcome detection rule** — under the converse pipeline, a call is `CONVERTED` iff some `CallTurn` row has `toolCalled = 'send_whatsapp_checkout_link'`. Everything else is `DROPPED`. See [01-runtime-flow.md §8](01-runtime-flow.md) for the detection code.

**Async tagging** — the three columns `objectionType`, `objectionSubtype`, `sentiment` are populated by the `classify-analytics-queue` worker, NOT by the response-path code. This keeps the hot path free of the classifier roundtrip.

---

## 2. Observation tools — the agent's senses

Five tools live in [observations.py](../fastapi-brain/app/services/observations.py). Each one hits Postgres via Prisma-py, returns a JSON-serializable dict, and gets fed back into the LLM's conversation as a `tool` message so the next response is grounded.

The dispatcher at the bottom is what `converse_response_stream` calls when the model emits an observation tool call:

[fastapi-brain/app/services/observations.py:194-208](../fastapi-brain/app/services/observations.py#L194-L208)

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
    return {"error": f"unknown_observation_tool: {name}"}
```

### 2.1 `check_inventory(product_id)` — honest scarcity

[fastapi-brain/app/services/observations.py:17-48](../fastapi-brain/app/services/observations.py#L17-L48)

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
        delta = product.restockEta - datetime.utcnow()
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

[fastapi-brain/app/services/observations.py:54-62](../fastapi-brain/app/services/observations.py#L54-L62)

```python
async def get_recent_purchases(db: Prisma, product_id: str, days: int) -> dict[str, Any]:
    since = datetime.utcnow() - timedelta(days=days)
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

[fastapi-brain/app/services/observations.py:68-92](../fastapi-brain/app/services/observations.py#L68-L92)

```python
async def get_review_summary(db: Prisma, product_id: str) -> dict[str, Any]:
    reviews = await db.productreview.find_many(
        where={"productId": product_id},
        order={"helpful": "desc"},
    )
    if not reviews:
        return {"product_id": product_id, "count": 0, "avg_rating": None,
                "top_positive_quote": None, "top_critical_quote": None}

    count = len(reviews)
    avg = round(sum(r.rating for r in reviews) / count, 2)

    # Top quotes: highest-helpful 4-5 star and highest-helpful <=3 star.
    positive = next((r for r in reviews if r.rating >= 4), None)
    critical = next((r for r in reviews if r.rating <= 3), None)

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

Returns one positive + one critical quote (highest `helpful` count in each tier). The prompt rule is **quote verbatim** — the agent reads back the actual text, doesn't paraphrase.

**Design choice** — returning a critical review on purpose is a trust move. *"Most loved it; one buyer said the cushion compressed too fast"* — acknowledging known downsides converts more reliably than only positive cherry-picks.

### 2.4 `get_delivery_eta(zip_code, product_id)` — closing lever

[fastapi-brain/app/services/observations.py:99-188](../fastapi-brain/app/services/observations.py#L99-L188)

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

[fastapi-brain/app/services/observations.py:117-157](../fastapi-brain/app/services/observations.py#L117-L157)

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
            bundle = await db.product.find_unique(where={"id": o.bundleProductId})
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

**Why we re-fetch the bundle product** — the `Offer` row only stores the bundle product's ID; the agent needs the name + price to actually pitch it ("add the creatine for $24.99"). Two queries per call, but offers per product are small (3-5), so it's cheap.

---

## 3. How an observation result re-enters the conversation

The observation-tool loop in [llm.py](../fastapi-brain/app/services/llm.py) is the magic that lets the LLM ground its responses in real data. Walkthrough below.

[fastapi-brain/app/services/llm.py:160-289](../fastapi-brain/app/services/llm.py#L160-L289)

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

    # 2) Execute observation tools and append tool result messages.
    for c in observation_calls:
        result = await run_observation_tool(c["name"], c["args"])
        yield {"type": "observation", "name": c["name"], "args": c["args"], "result": result}
        working_messages.append({
            "role": "tool",
            "tool_call_id": c["id"],
            "content": json.dumps(result),
        })

    # 3) Loop back for another pass
    continue
```

The LLM sees the result, then re-streams its response with the data baked in. This loop is bounded by `MAX_TOOL_TURNS = 4` ([llm.py:62](../fastapi-brain/app/services/llm.py#L62)) so a misbehaving model can't spin forever.

**Side-effect tools** (`send_whatsapp_*`) skip the loop — they emit a `tool_call` SSE event that bubbles up to the gateway, which dispatches them out-of-band. The agent's last text utterance ("Sending it to your WhatsApp now") was streamed BEFORE the tool call, so by the time the customer hears that line, the WhatsApp request is already in flight.

---

## 4. Tool registration — Pydantic schemas → OpenAI tool definitions

The LLM only knows about tools that are in `OPENAI_TOOLS` ([tools.py](../fastapi-brain/app/services/tools.py)). Each tool is described by a Pydantic model whose `.model_json_schema()` becomes the JSON schema OpenAI sees.

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

`Field(ge=0, le=10)` is **layer 1 of the discount defense-in-depth**. The `description` is what the LLM reads to decide WHEN to use which discount.

Tool definitions get assembled into the OpenAI payload:

[fastapi-brain/app/services/tools.py:106-125](../fastapi-brain/app/services/tools.py#L106-L125)

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
    # ... 6 more tools
]
```

Each tool's `description` doubles as **prompt engineering** — it tells the LLM precisely when to use the tool. The `get_available_offers` description is particularly explicit:

[fastapi-brain/app/services/tools.py:180-198](../fastapi-brain/app/services/tools.py#L180-L198)

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

[scripts/seed-demo-data.ts](../scripts/seed-demo-data.ts) is a single ~1300-line script that's idempotent (re-runnable). It seeds:

| What | Count | Notes |
|---|---|---|
| Products | 43 active | 8 chairs/accessories, 14 nutrition products (proteins + creatine + shaker), 20 apparel size-variants (5 base × 4 sizes), 1 lumbar pillow, 1 mat |
| Reviews | 72 | Mix of positive + critical, varying `helpful` counts so quotes are realistic |
| Customers | 10 | Spans all 4 segments (FIRST_TIME, RETURNING, VIP, LAPSED) |
| Carts (abandoned) | 10 | One per customer, varying staleness via `abandonedAt` |
| Past purchases | 20 | Drives the `Customer.lifetimeValue` calculation + cross-sell signals |
| Offers | 26 | BUNDLE (protein × creatine, chair × mat, hoodie × joggers per matching size) and QUANTITY (2× protein, 2× tee per size) |

**The most architecturally interesting bit** is the protein generator. Real-world per-100g amino-acid profiles for each protein type drive a generator that scales to actual scoop sizes.

[scripts/seed-demo-data.ts:251-285](../scripts/seed-demo-data.ts#L251-L285)

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

- **`voice-agent-products`** (dim=1536, cosine) — embeds product `name + description + tags` via OpenAI's `text-embedding-3-small`. Powers `/products/alternatives` (the cheaper-alt and premium-alt lookups in §1).
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

[fastapi-brain/app/services/product.py:50-90](../fastapi-brain/app/services/product.py#L50-L90)

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
2. Then [observations.py](../fastapi-brain/app/services/observations.py) end-to-end (it's only 208 lines)
3. Then [tools.py](../fastapi-brain/app/services/tools.py) to see how each observation gets exposed to the LLM
4. Then `_stream_one_pass` in [llm.py](../fastapi-brain/app/services/llm.py) to see how the loop works
5. Finally [seed-demo-data.ts](../scripts/seed-demo-data.ts) to see how realistic test data gets generated

Continue to **[03-prompt-and-conversion.md](03-prompt-and-conversion.md)** for the system prompt + sales principles that drive when each tool gets called.
