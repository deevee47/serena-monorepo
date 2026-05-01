import json
import time
from collections.abc import AsyncGenerator
from typing import Any, TypedDict

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


# ─── Function-calling (converse) ───────────────────────────────────────────
# These functions exercise the OpenAI tools/function-calling API. The streaming
# variant interleaves text deltas with one fully-parsed tool_call event at the
# end (when finish_reason=='tool_calls'). OpenAI streams tool args as JSON
# fragments per chunk; we accumulate them and emit a single event so callers
# don't have to re-parse partial JSON.

_CONVERSE_PARAMS: dict = {
    # Slightly more room than the legacy 150-token cap because the model now
    # decides whether to call a tool, which uses some of the token budget.
    "max_tokens": 250,
    "temperature": 0.7,
    "stream": True,
    "tool_choice": "auto",
}


class ConverseTextEvent(TypedDict):
    type: str  # 'text'
    delta: str


class ConverseToolCallEvent(TypedDict):
    type: str  # 'tool_call'
    name: str
    args: dict[str, Any]


class ConverseDoneEvent(TypedDict):
    type: str  # 'done'
    finish_reason: str | None


ConverseEvent = ConverseTextEvent | ConverseToolCallEvent | ConverseDoneEvent


async def converse_response_stream(
    system_prompt: str,
    messages: list[dict],
    tools: list[dict],
    call_id: str,
) -> AsyncGenerator[ConverseEvent, None]:
    """Yield typed events: text deltas as they arrive, then optionally one
    tool_call event after the model finalizes args, then a done event."""
    log = get_logger(call_id)
    client = AsyncOpenAI(api_key=settings.llm_api_key)
    start = time.perf_counter()

    text_chunks = 0
    # Tool args stream as JSON fragments under tool_calls[i].function.arguments.
    # Track per-index since OpenAI may emit multiple tool calls in one turn,
    # though for our v1 prompt it should always be at most one.
    tool_buffers: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None

    try:
        stream = await client.chat.completions.create(
            model=settings.openai_model,
            messages=_build_messages(system_prompt, messages),
            tools=tools,
            **_CONVERSE_PARAMS,
        )

        async for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            # Text content
            if delta.content:
                text_chunks += 1
                yield {"type": "text", "delta": delta.content}

            # Tool call deltas (function name + accumulating args fragments)
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index if tc.index is not None else 0
                    buf = tool_buffers.setdefault(idx, {"name": "", "args_json": ""})
                    if tc.function and tc.function.name:
                        buf["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        buf["args_json"] += tc.function.arguments

            if choice.finish_reason:
                finish_reason = choice.finish_reason

        # Emit one tool_call event per accumulated tool call (typically one)
        for buf in tool_buffers.values():
            if not buf["name"]:
                continue
            try:
                args_obj = json.loads(buf["args_json"]) if buf["args_json"] else {}
            except json.JSONDecodeError:
                log.warning(
                    "tool_call_args_invalid_json",
                    tool=buf["name"],
                    raw=buf["args_json"][:200],
                )
                args_obj = {}
            yield {"type": "tool_call", "name": buf["name"], "args": args_obj}

        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        log.info(
            "converse_stream_response",
            duration_ms=duration_ms,
            text_chunks=text_chunks,
            tool_calls=len(tool_buffers),
            finish_reason=finish_reason,
        )
        yield {"type": "done", "finish_reason": finish_reason}

    except Exception as exc:
        _raise_llm_error(log, exc)


async def converse_response(
    system_prompt: str,
    messages: list[dict],
    tools: list[dict],
    call_id: str,
) -> dict[str, Any]:
    """Non-streaming convenience wrapper. Returns
    {text: str, tool_call: {name, args} | None, finish_reason: str | None}."""
    text_parts: list[str] = []
    tool_call: dict[str, Any] | None = None
    finish_reason: str | None = None

    async for event in converse_response_stream(system_prompt, messages, tools, call_id):
        kind = event["type"]
        if kind == "text":
            text_parts.append(event["delta"])  # type: ignore[typeddict-item]
        elif kind == "tool_call":
            tool_call = {"name": event["name"], "args": event["args"]}  # type: ignore[typeddict-item]
        elif kind == "done":
            finish_reason = event.get("finish_reason")  # type: ignore[typeddict-item]

    return {
        "text": "".join(text_parts).strip(),
        "tool_call": tool_call,
        "finish_reason": finish_reason,
    }
