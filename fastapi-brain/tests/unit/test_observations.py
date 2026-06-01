"""Unit tests for observation tools that don't need a live database — a small
fake stands in for the Prisma client."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.services.observations import (
    check_inventory,
    get_available_offers,
    get_review_summary,
)


class _FakeProductTable:
    def __init__(self, product):
        self._product = product

    async def find_unique(self, where):  # noqa: ARG002 — mirrors Prisma signature
        return self._product


class _FakeDb:
    def __init__(self, product):
        self.product = _FakeProductTable(product)


@pytest.mark.asyncio
async def test_check_inventory_handles_tz_aware_restock_eta():
    # Postgres `timestamptz` deserializes to a tz-aware datetime. Subtracting a
    # naive utcnow() raises TypeError, which silently kills the restock branch.
    restock = datetime.now(UTC) + timedelta(days=3, hours=1)
    product = SimpleNamespace(id="p1", inventoryCount=0, restockEta=restock)

    result = await check_inventory(_FakeDb(product), "p1")

    assert result["in_stock"] == 0
    assert result["restock_eta_days"] == 3


@pytest.mark.asyncio
async def test_check_inventory_in_stock_reports_low_stock_without_eta():
    product = SimpleNamespace(id="p2", inventoryCount=4, restockEta=None)

    result = await check_inventory(_FakeDb(product), "p2")

    assert result["in_stock"] == 4
    assert result["low_stock"] is True
    assert result["restock_eta_days"] is None


# ─── get_review_summary: bounded queries (B4) ─────────────────────────────


class _FakeReviewTable:
    """Implements only the bounded query methods — NOT find_many — so a test
    fails loudly if the code regresses to loading every review."""

    def __init__(self, *, count, avg, positive, critical):
        self._count = count
        self._avg = avg
        self._positive = positive
        self._critical = critical
        self.calls: list[str] = []

    async def count(self, where):  # noqa: ARG002
        self.calls.append("count")
        return self._count

    async def group_by(self, by, where, avg=None, **kwargs):  # noqa: ARG002
        self.calls.append("group_by")
        if not self._count:
            return []
        return [{"productId": where["productId"], "_avg": {"rating": self._avg}}]

    async def find_first(self, where, order=None):  # noqa: ARG002
        self.calls.append("find_first")
        rating_filter = where.get("rating", {})
        if "gte" in rating_filter:
            return self._positive
        if "lte" in rating_filter:
            return self._critical
        return None


class _FakeReviewDb:
    def __init__(self, table):
        self.productreview = table


@pytest.mark.asyncio
async def test_get_review_summary_uses_bounded_queries():
    table = _FakeReviewTable(
        count=142,
        avg=4.327,
        positive=SimpleNamespace(body="Best whey I've had", rating=5, helpful=40),
        critical=SimpleNamespace(body="Mixes a bit clumpy", rating=3, helpful=8),
    )
    result = await get_review_summary(_FakeReviewDb(table), "p1")

    assert result["count"] == 142
    assert result["avg_rating"] == 4.33  # rounded to 2dp
    assert result["top_positive_quote"] == "Best whey I've had"
    assert result["top_critical_quote"] == "Mixes a bit clumpy"
    # The whole point of B4: never load the full review table.
    assert "find_many" not in table.calls


@pytest.mark.asyncio
async def test_get_review_summary_empty_short_circuits():
    table = _FakeReviewTable(count=0, avg=None, positive=None, critical=None)
    result = await get_review_summary(_FakeReviewDb(table), "p1")
    assert result["count"] == 0
    assert result["avg_rating"] is None


# ─── get_available_offers: batched bundle lookup (B4) ─────────────────────


class _FakeOfferTable:
    def __init__(self, offers):
        self._offers = offers

    async def find_many(self, where, order=None):  # noqa: ARG002
        return self._offers


class _FakeOfferProductTable:
    def __init__(self, product, bundles):
        self._product = product
        self._bundles = bundles
        self.find_unique_calls = 0
        self.find_many_calls = 0

    async def find_unique(self, where):  # noqa: ARG002
        self.find_unique_calls += 1
        return self._product

    async def find_many(self, where, order=None):  # noqa: ARG002
        self.find_many_calls += 1
        ids = where["id"]["in"]
        return [b for b in self._bundles if b.id in ids]


class _FakeOfferDb:
    def __init__(self, product, offers, bundles):
        self.offer = _FakeOfferTable(offers)
        self.product = _FakeOfferProductTable(product, bundles)


@pytest.mark.asyncio
async def test_get_available_offers_batches_bundle_lookups():
    product = SimpleNamespace(id="p1")
    offers = [
        SimpleNamespace(id="o1", type="BUNDLE", discountPercent=5, shortPitch="add creatine",
                        description="d1", bundleProductId="b1", minQuantity=None),
        SimpleNamespace(id="o2", type="BUNDLE", discountPercent=10, shortPitch="add shaker",
                        description="d2", bundleProductId="b2", minQuantity=None),
    ]
    bundles = [
        SimpleNamespace(id="b1", name="Creatine", price=20.0),
        SimpleNamespace(id="b2", name="Shaker", price=5.0),
    ]
    db = _FakeOfferDb(product, offers, bundles)

    result = await get_available_offers(db, "p1")

    assert len(result["offers"]) == 2
    assert result["offers"][0]["bundle_product"]["name"] == "Creatine"
    assert result["offers"][1]["bundle_product"]["name"] == "Shaker"
    # No N+1: the only find_unique is the product existence check; all bundle
    # products are fetched in a single batched find_many.
    assert db.product.find_unique_calls == 1
    assert db.product.find_many_calls == 1
