"""Observation tool implementations.

These execute server-side (called from converse_response_stream) and return
JSON-serializable results to feed back to the LLM. Each function gets a
shared `db` Prisma client via FastAPI's app.state.

All functions are defensive — when data is missing or the product_id is
unknown they return a structured 'unknown' / empty result rather than
raising, so the model can decide what to do."""

from datetime import datetime, timedelta
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
        delta = product.restockEta - datetime.utcnow()
        restock_eta_days = max(0, delta.days)

    return {
        "product_id": product_id,
        "in_stock": in_stock,
        "low_stock": low_stock,
        "restock_eta_days": restock_eta_days,
    }


# ─── get_recent_purchases ───────────────────────────────────────────────────


async def get_recent_purchases(db: Prisma, product_id: str, days: int) -> dict[str, Any]:
    since = datetime.utcnow() - timedelta(days=days)
    count = await db.purchase.count(
        where={
            "productId": product_id,
            "purchasedAt": {"gte": since},
        }
    )
    return {"product_id": product_id, "count": count, "days": days}


# ─── get_review_summary ─────────────────────────────────────────────────────


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
    return {"error": f"unknown_observation_tool: {name}"}
