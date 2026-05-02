#!/usr/bin/env python3
"""Mark every product not part of the Serena demo as inactive.

Idempotent. Run any time you want to scrub a polluted DB. Doesn't delete —
inactive products keep their cart/purchase/review FKs intact.

Serena's demo products:
  prod-001..prod-008   (original product seed)
  acc-mat-01           (demo seed, anti-fatigue mat)

Anything else (cloth-*, hoodie, jeans, etc.) gets isActive=False.

Usage:
  cd fastapi-brain && uv run python ../scripts/cleanup-non-serena-products.py
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from prisma import Prisma

# Office: chairs + mat
_OFFICE = {
    "prod-001",  # ZephyrChair Pro
    "prod-002",  # ZephyrChair Lite
    "chair-gamethrone",  # GameThrone Pro Gaming Chair
    "acc-mat-01",  # Anti-fatigue Floor Mat
    # Legacy IDs from older seed.ts — keep in case they still exist
    "prod-003", "prod-004", "prod-005", "prod-006", "prod-007", "prod-008",
}

# Nutrition: proteins
_NUTRITION = {
    "whey-iso-vanilla",
    "whey-perf-choc",
    "pea-iso-unflavored",
    "plant-perf-berry",
}

# Apparel: clothing × sizes
_APPAREL = {
    f"{base}-{size}"
    for base in ("cotton-tee", "hoodie", "joggers")
    for size in ("s", "m", "l", "xl")
}

SERENA_PRODUCT_IDS = _OFFICE | _NUTRITION | _APPAREL


async def main() -> None:
    db = Prisma(datasource={"url": os.environ["DATABASE_URL"]})
    await db.connect()

    all_products = await db.product.find_many()
    serena = [p for p in all_products if p.id in SERENA_PRODUCT_IDS]
    foreign = [p for p in all_products if p.id not in SERENA_PRODUCT_IDS]

    print(f"DB total active products: {sum(1 for p in all_products if p.isActive)}")
    print(f"  Serena (keeping): {sum(1 for p in serena if p.isActive)}")
    print(f"  Foreign (deactivating): {sum(1 for p in foreign if p.isActive)}")

    deactivated = 0
    for p in foreign:
        if p.isActive:
            await db.product.update(where={"id": p.id}, data={"isActive": False})
            deactivated += 1
    print(f"\nDeactivated {deactivated} foreign products.")

    remaining = await db.product.find_many(where={"isActive": True}, order={"price": "asc"})
    print(f"\nActive products after cleanup ({len(remaining)}):")
    for p in remaining:
        print(f"  {p.id:<14} {p.name:<35} ${float(p.price):<8.2f} cat={p.category}")

    await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
