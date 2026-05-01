import time
from collections.abc import AsyncGenerator

from openai import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)

from app.config.settings import settings
from app.utils.errors import LLMError
from app.utils.logger import get_logger

_OPENAI_PARAMS: dict = {
    "max_tokens": 150,
    "temperature": 0.7,
    "stream": True,
}


def _build_messages(system_prompt: str, messages: list[dict]) -> list[dict]:
    return [{"role": "system", "content": system_prompt}, *messages]


def _raise_llm_error(log, exc: Exception) -> None:
    log.error("llm_error", error_type=type(exc).__name__, message=str(exc))
    if isinstance(exc, AuthenticationError):
        raise LLMError("OpenAI authentication failed. Check OPENAI_API_KEY.") from exc
    if isinstance(exc, RateLimitError):
        raise LLMError("Rate limit reached, try again shortly") from exc
    if isinstance(exc, APITimeoutError):
        raise LLMError("LLM response timed out") from exc
    if isinstance(exc, APIConnectionError):
        raise LLMError("OpenAI connection failed. Check network/DNS access.") from exc
    if isinstance(exc, APIError):
        raise LLMError(f"LLM API error: {exc.message}") from exc
    raise exc


async def generate_response(system_prompt: str, messages: list[dict], call_id: str) -> str:
    log = get_logger(call_id)
    client = AsyncOpenAI(api_key=settings.llm_api_key)
    start = time.perf_counter()

    try:
        stream = await client.chat.completions.create(
            model=settings.openai_model,
            messages=_build_messages(system_prompt, messages),
            **_OPENAI_PARAMS,
        )
        chunks: list[str] = []
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                chunks.append(delta)

        text = "".join(chunks).strip()
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        log.info("llm_response", duration_ms=duration_ms)
        log.debug("llm_text", text=text)
        return text

    except Exception as exc:
        _raise_llm_error(log, exc)


async def stream_response(
    system_prompt: str,
    messages: list[dict],
    call_id: str,
) -> AsyncGenerator[str, None]:
    log = get_logger(call_id)
    client = AsyncOpenAI(api_key=settings.llm_api_key)
    start = time.perf_counter()
    try:
        stream = await client.chat.completions.create(
            model=settings.openai_model,
            messages=_build_messages(system_prompt, messages),
            **_OPENAI_PARAMS,
        )
        chunk_count = 0
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                chunk_count += 1
                yield delta
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        log.info("llm_stream_response", duration_ms=duration_ms, chunks=chunk_count)
    except Exception as exc:
        _raise_llm_error(log, exc)
