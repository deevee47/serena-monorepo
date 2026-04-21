import time

from openai import AsyncOpenAI
from pinecone import Pinecone

from app.config.settings import settings
from app.models.requests import ProductContext
from app.utils.logger import get_logger

_pc = Pinecone(api_key=settings.pinecone_api_key)
_index = _pc.Index(settings.pinecone_index_name)

_cache: dict[str, tuple[list[float], float]] = {}
CACHE_TTL = 300  # 5 minutes — TODO Step 4.2: replace with Redis-backed cache


async def _embed_query(text: str) -> list[float]:
    cached = _cache.get(text)
    if cached and (time.time() - cached[1]) < CACHE_TTL:
        return cached[0]

    client = AsyncOpenAI(api_key=settings.llm_api_key)
    response = await client.embeddings.create(model="text-embedding-3-small", input=text)
    vector = response.data[0].embedding
    _cache[text] = (vector, time.time())
    return vector


def _metadata_to_product_context(metadata: dict) -> ProductContext:
    tags = metadata.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    return ProductContext(
        product_id=metadata["product_id"],
        name=metadata["name"],
        price=float(metadata["price"]),
        description=metadata.get("description", ""),
        key_features=tags,
    )


async def find_alternatives(
    query: str,
    exclude_id: str,
    top_k: int = 3,
) -> list[ProductContext]:
    log = get_logger()
    vector = await _embed_query(query)

    results = _index.query(
        vector=vector,
        top_k=top_k,
        filter={"product_id": {"$ne": exclude_id}},
        include_metadata=True,
    )  # type: ignore[union-attr]

    matches = results.get("matches", [])
    log.debug("pinecone_alternatives", query=query[:80], exclude_id=exclude_id, count=len(matches))

    contexts: list[ProductContext] = []
    for match in matches:
        if match.get("metadata"):
            contexts.append(_metadata_to_product_context(match["metadata"]))
    return contexts


async def find_cheaper_alternative(
    current_price: float,
    query: str,
    exclude_id: str,
) -> ProductContext | None:
    log = get_logger()
    vector = await _embed_query(query)

    results = _index.query(
        vector=vector,
        top_k=3,
        filter={
            "price": {"$lt": current_price},
            "product_id": {"$ne": exclude_id},
        },
        include_metadata=True,
    )

    matches = results.get("matches", [])
    log.debug(
        "pinecone_cheaper",
        query=query[:80],
        exclude_id=exclude_id,
        current_price=current_price,
        count=len(matches),
    )

    if not matches or not matches[0].get("metadata"):
        return None
    return _metadata_to_product_context(matches[0]["metadata"])
