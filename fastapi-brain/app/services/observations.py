"""Observation tool implementations.

These execute server-side (called from converse_response_stream) and return
JSON-serializable results to feed back to the LLM. Each function gets a
shared `db` Prisma client via FastAPI's app.state.

All functions are defensive — when data is missing or the product_id is
unknown they return a structured 'unknown' / empty result rather than
raising, so the model can decide what to do."""

from datetime import UTC, datetime, timedelta
from typing import Any

from prisma import Prisma

# ─── check_inventory ────────────────────────────────────────────────────────

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
        # restockEta is tz-aware (Postgres timestamptz) — compare against a
        # tz-aware now, not naive utcnow() (which raises TypeError and is
        # deprecated).
        delta = product.restockEta - datetime.now(UTC)
        restock_eta_days = max(0, delta.days)

    return {
        "product_id": product_id,
        "in_stock": in_stock,
        "low_stock": low_stock,
        "restock_eta_days": restock_eta_days,
    }


# ─── get_recent_purchases ───────────────────────────────────────────────────


async def get_recent_purchases(db: Prisma, product_id: str, days: int) -> dict[str, Any]:
    since = datetime.now(UTC) - timedelta(days=days)
    count = await db.purchase.count(
        where={
            "productId": product_id,
            "purchasedAt": {"gte": since},
        }
    )
    return {"product_id": product_id, "count": count, "days": days}


# ─── get_review_summary ─────────────────────────────────────────────────────


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

    # Top quotes: highest-helpful 4-5 star and highest-helpful <=3 star — the
    # same selection the old in-Python scan made, now pushed to the DB.
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


# ─── get_delivery_eta ───────────────────────────────────────────────────────
# Demo: hardcoded zip-prefix → days table. A real implementation would call
# the carrier's API or look up shipping zones from the warehouse location.

_ZIP_PREFIX_DAYS: list[tuple[str, int, int]] = [
    # (zip prefix, standard_days, expedited_days)
    ("9", 2, 1),  # West Coast
    ("8", 3, 1),  # Mountain
    ("7", 3, 2),  # South Central
    ("6", 3, 2),  # North Central
    ("5", 3, 2),  # Upper Midwest
    ("4", 4, 2),  # Great Lakes
    ("3", 4, 2),  # Southeast
    ("2", 4, 2),  # Mid Atlantic
    ("1", 4, 2),  # Northeast
    ("0", 5, 2),  # New England + Puerto Rico
]


# ─── get_available_offers ──────────────────────────────────────────────────


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


# ─── get_delivery_eta ───────────────────────────────────────────────────────


async def get_delivery_eta(db: Prisma, zip_code: str, product_id: str) -> dict[str, Any]:
    # Verify product exists; if not, return defaults but flag.
    product = await db.product.find_unique(where={"id": product_id})
    if product is None:
        return {"error": "product_not_found", "product_id": product_id}

    if not zip_code or not zip_code[0].isdigit():
        return {
            "zip_code": zip_code,
            "product_id": product_id,
            "standard_days": None,
            "expedited_days": None,
            "note": "invalid zip code",
        }

    prefix = zip_code[0]
    for p, std, exp in _ZIP_PREFIX_DAYS:
        if p == prefix:
            return {
                "zip_code": zip_code,
                "product_id": product_id,
                "standard_days": std,
                "expedited_days": exp,
            }
    # Fallback (shouldn't hit since we cover 0-9)
    return {"zip_code": zip_code, "product_id": product_id, "standard_days": 5, "expedited_days": 2}


# ─── list_products ─────────────────────────────────────────────────────────


async def list_products(
    db: Prisma, category: str | None = None, max_results: int = 8
) -> dict[str, Any]:
    """Catalog-browse helper for "what else do you have?" questions.

    Returns a category summary plus a small list of products. Cheap — one
    findMany over the (small) active-products table; counts are aggregated
    in Python."""
    rows = await db.product.find_many(where={"isActive": True})

    # Category counts across the full active catalog.
    counts: dict[str, int] = {}
    for r in rows:
        key = r.category or "(uncategorized)"
        counts[key] = counts.get(key, 0) + 1
    categories = [
        {"name": name, "count": n}
        for name, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    # Filter to a category if requested. Case-insensitive so the agent can
    # pass "office" / "Office" / "OFFICE" and still match.
    if category:
        wanted = category.strip().lower()
        filtered = [r for r in rows if (r.category or "").lower() == wanted]
    else:
        filtered = list(rows)

    # Stable ordering: category asc, then price asc (so the list reads as a
    # natural cheap-first walk through whichever category we're in).
    filtered.sort(key=lambda r: ((r.category or ""), float(r.price)))

    products = [
        {
            "product_id": r.id,
            "name": r.name,
            "price": float(r.price),
            "category": r.category,
        }
        for r in filtered[:max_results]
    ]

    return {
        "categories": categories,
        "products": products,
        "total_active": len(rows),
        "filtered_total": len(filtered),
        "category_filter": category,
    }


# ─── Dispatch ──────────────────────────────────────────────────────────────


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
