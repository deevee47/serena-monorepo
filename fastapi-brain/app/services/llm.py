import time
from collections.abc import AsyncGenerator

from openai import AsyncOpenAI, APIError, APITimeoutError, RateLimitError

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

    except RateLimitError as e:
        raise LLMError("Rate limit reached, try again shortly") from e
    except APITimeoutError as e:
        raise LLMError("LLM response timed out") from e
    except APIError as e:
        raise LLMError(f"LLM API error: {e.message}") from e


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
    except RateLimitError as e:
        raise LLMError("Rate limit reached, try again shortly") from e
    except APITimeoutError as e:
        raise LLMError("LLM response timed out") from e
    except APIError as e:
        raise LLMError(f"LLM API error: {e.message}") from e
