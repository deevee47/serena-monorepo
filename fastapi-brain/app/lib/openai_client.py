"""Process-wide pooled AsyncOpenAI client.

Constructing an AsyncOpenAI per request discards its HTTP/TLS connection pool,
forcing a fresh handshake to OpenAI on the hot path of every live call turn.
Memoizing one client lets the pool be reused across turns. Mirrors the pattern
already used in `app.utils.embeddings`.
"""

from openai import AsyncOpenAI

from app.config.settings import settings

_client: AsyncOpenAI | None = None


def get_openai_client() -> AsyncOpenAI:
    """Return the shared AsyncOpenAI client, constructing it once on first use."""
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.llm_api_key)
    return _client


def reset_openai_client() -> None:
    """Drop the memoized client. Test seam only — not used in production."""
    global _client
    _client = None
