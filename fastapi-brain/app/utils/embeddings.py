"""Shared OpenAI embedding helper with in-process TTL cache.

Both product alternatives and objection classification share this so we don't
re-embed identical strings within a short window. TODO Step 4.2: replace the
in-process dict with a Redis-backed cache shared across workers.
"""

import time

from openai import AsyncOpenAI

from app.config.settings import settings

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536
CACHE_TTL_SECONDS = 300

_cache: dict[str, tuple[list[float], float]] = {}
_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.llm_api_key)
    return _client


async def embed_text(text: str) -> list[float]:
    """Return the embedding vector for `text`, caching identical inputs."""
    cached = _cache.get(text)
    if cached and (time.time() - cached[1]) < CACHE_TTL_SECONDS:
        return cached[0]

    response = await _get_client().embeddings.create(model=EMBEDDING_MODEL, input=text)
    vector = response.data[0].embedding
    _cache[text] = (vector, time.time())
    return vector
