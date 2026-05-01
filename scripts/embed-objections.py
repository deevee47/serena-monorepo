#!/usr/bin/env python3
"""
One-time objection seed embedding script. Re-runnable (idempotent via Pinecone upsert).
Creates the objections index if it does not exist, then embeds every row in
fastapi-brain/data/objection_seed.jsonl and upserts to Pinecone.

Usage: uv run python scripts/embed-objections.py

The vector ID is a deterministic hash of the utterance, so re-running with the
same seed file results in zero duplicates and only re-embeds new/changed rows
(when the underlying utterance text has changed).
"""
import asyncio
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))

from openai import AsyncOpenAI
from pinecone import Pinecone, ServerlessSpec

EMBEDDING_DIM = 1536
EMBEDDING_MODEL = "text-embedding-3-small"
SEED_FILE = os.path.join(os.path.dirname(__file__), "../fastapi-brain/data/objection_seed.jsonl")
LABELED_BY = "v1-seed"
BATCH_SIZE = 100


def utterance_id(utterance: str) -> str:
    h = hashlib.sha1(utterance.encode("utf-8")).hexdigest()[:12]
    return f"seed_{h}"


async def main() -> None:
    openai_api_key = os.environ["OPENAI_API_KEY"]
    pinecone_api_key = os.environ["PINECONE_API_KEY"]
    index_name = os.environ.get("PINECONE_OBJECTIONS_INDEX_NAME", "voice-agent-objections")
    pinecone_cloud = os.environ.get("PINECONE_CLOUD", "aws")
    pinecone_region = os.environ.get("PINECONE_REGION", "us-east-1")

    pc = Pinecone(api_key=pinecone_api_key)

    existing = [idx.name for idx in pc.list_indexes()]
    if index_name not in existing:
        print(f"Index '{index_name}' not found — creating (dim={EMBEDDING_DIM}, cosine, {pinecone_cloud}/{pinecone_region})...")
        pc.create_index(
            name=index_name,
            dimension=EMBEDDING_DIM,
            metric="cosine",
            spec=ServerlessSpec(cloud=pinecone_cloud, region=pinecone_region),
        )
        while not pc.describe_index(index_name).status.ready:
            print("  Waiting for index to be ready...")
            time.sleep(2)
        print("  Index ready.")
    else:
        print(f"Index '{index_name}' already exists.")

    index = pc.Index(index_name)

    if not os.path.exists(SEED_FILE):
        print(f"ERROR: seed file not found at {SEED_FILE}")
        sys.exit(1)

    rows: list[dict] = []
    with open(SEED_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    print(f"Loaded {len(rows)} seed rows from {SEED_FILE}")

    client = AsyncOpenAI(api_key=openai_api_key)

    vectors: list[dict] = []
    for i, row in enumerate(rows, 1):
        utterance = row["utterance"]
        response = await client.embeddings.create(model=EMBEDDING_MODEL, input=utterance)
        embedding = response.data[0].embedding
        added_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        vectors.append({
            "id": utterance_id(utterance),
            "values": embedding,
            "metadata": {
                "utterance": utterance,
                "objection_type": row["objection_type"],
                "sentiment": row["sentiment"],
                "subtype": row.get("subtype", ""),
                "source": "seed",
                "added_at": added_at,
                "labeled_by": LABELED_BY,
            },
        })
        if i % 25 == 0:
            print(f"  Embedded {i}/{len(rows)}...")

    print(f"Embedded all {len(vectors)} utterances. Upserting to Pinecone...")
    for batch_start in range(0, len(vectors), BATCH_SIZE):
        batch = vectors[batch_start:batch_start + BATCH_SIZE]
        index.upsert(vectors=batch)
        print(f"  Upserted batch {batch_start}..{batch_start + len(batch)}")

    stats = index.describe_index_stats()
    total = stats.get("total_vector_count", "?")
    print(f"\nDone. Index '{index_name}' total vectors: {total}")


if __name__ == "__main__":
    asyncio.run(main())
