#!/usr/bin/env python3
"""
One-time product embedding script. Re-runnable (idempotent via Pinecone upsert).
Creates the Pinecone index if it does not exist.
Usage: uv run python scripts/embed-products.py
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))

from openai import AsyncOpenAI
from pinecone import Pinecone, ServerlessSpec
from prisma import Prisma

EMBEDDING_DIM = 1536
EMBEDDING_MODEL = "text-embedding-3-small"


async def main() -> None:
    database_url = os.environ["DATABASE_URL"]
    openai_api_key = os.environ["OPENAI_API_KEY"]
    pinecone_api_key = os.environ["PINECONE_API_KEY"]
    pinecone_index_name = os.environ.get("PINECONE_INDEX_NAME", "voice-agent-products")
    pinecone_cloud = os.environ.get("PINECONE_CLOUD", "aws")
    pinecone_region = os.environ.get("PINECONE_REGION", "us-east-1")

    pc = Pinecone(api_key=pinecone_api_key)

    existing = [idx.name for idx in pc.list_indexes()]
    if pinecone_index_name not in existing:
        print(f"Index '{pinecone_index_name}' not found — creating (dim={EMBEDDING_DIM}, cosine, {pinecone_cloud}/{pinecone_region})...")
        pc.create_index(
            name=pinecone_index_name,
            dimension=EMBEDDING_DIM,
            metric="cosine",
            spec=ServerlessSpec(cloud=pinecone_cloud, region=pinecone_region),
        )
        # Wait for index to become ready
        while not pc.describe_index(pinecone_index_name).status.ready:
            print("  Waiting for index to be ready...")
            time.sleep(2)
        print("  Index ready.")
    else:
        print(f"Index '{pinecone_index_name}' already exists.")

    index = pc.Index(pinecone_index_name)

    db = Prisma(datasource={"url": database_url})
    await db.connect()

    openai_client = AsyncOpenAI(api_key=openai_api_key)

    products = await db.product.find_many(where={"isActive": True})
    print(f"Found {len(products)} active products to embed.")

    vectors = []
    for product in products:
        tags = product.tags or []
        text = f"{product.name}: {product.description or ''}. Features: {', '.join(tags)}"
        response = await openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=text,
        )
        embedding = response.data[0].embedding
        vectors.append({
            "id": product.id,
            "values": embedding,
            "metadata": {
                "product_id": product.id,
                "name": product.name,
                "price": float(product.price),
                "category": product.category or "",
                "tags": tags,
                "description": product.description or "",
            },
        })
        print(f"  Embedded: {product.id} — {product.name}")

    if vectors:
        index.upsert(vectors=vectors)
        print(f"\nUpserted {len(vectors)} vectors to Pinecone index '{pinecone_index_name}'.")

    for v in vectors:
        await db.product.update(
            where={"id": v["id"]},
            data={"embeddingSynced": True},
        )

    print(f"Marked {len(vectors)} products as embedding_synced=True in Postgres.")
    await db.disconnect()
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
