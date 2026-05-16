import json
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
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


# ─── Function-calling (converse) ───────────────────────────────────────────
# Single-call-per-turn function-calling pipeline. Two tool categories:
#
#   - Side-effect tools: gateway dispatches the side effect (e.g. WhatsApp
#     send). The LLM emits one tool_call, which we yield to the caller, and
#     the turn ends. The model isn't given the result back.
#
#   - Observation tools: executed server-side via `run_observation_tool`. The
#     result is appended back into the message list as a tool message, and
#     we re-stream from OpenAI. The LLM continues with grounded facts. This
#     loop runs until the model emits text-only or a side-effect tool.
#
# We cap the observation loop at MAX_TOOL_TURNS to prevent runaways.

_CONVERSE_PARAMS: dict = {
    # Slightly more room than the legacy 150-token cap because the model now
    # decides whether to call a tool, which uses some of the token budget.
    "max_tokens": 250,
    "temperature": 0.7,
    "stream": True,
    "tool_choice": "auto",
}

MAX_TOOL_TURNS = 4  # safety cap on observation-loop iterations per user turn

# Single source of truth for observation-vs-side-effect routing. Importing
# from tools.py here (rather than maintaining a parallel hardcoded set)
# prevents drift — e.g. an observation tool registered in tools.py but
# missing here would silently get routed down the side-effect path and
# then dropped as `observation_tool_leaked_to_gateway`.
from app.services.tools import OBSERVATION_TOOLS as _OBSERVATION_TOOL_NAMES


class ConverseTextEvent(TypedDict):
    type: str  # 'text'
    delta: str


class ConverseToolCallEvent(TypedDict):
    type: str  # 'tool_call'
    name: str
    args: dict[str, Any]


class ConverseObservationEvent(TypedDict):
    """Emitted when an observation tool runs server-side. Useful for the CLI
    and gateway logs; the LLM doesn't see this directly (it sees the tool
    result message we feed back)."""
    type: str  # 'observation'
    name: str
    args: dict[str, Any]
    result: dict[str, Any]


class ConverseThinkingEvent(TypedDict):
    """Emitted *before* an observation tool is awaited so the gateway can
    fire a thinking-aloud filler ('let me check —') into TTS during the
    Postgres roundtrip. Side-effect tools don't need this — the LLM already
    spoke a confirmation sentence before calling them."""
    type: str  # 'thinking'
    tool: str


class ConverseDoneEvent(TypedDict):
    type: str  # 'done'
    finish_reason: str | None


ConverseEvent = (
    ConverseTextEvent
    | ConverseToolCallEvent
    | ConverseObservationEvent
    | ConverseThinkingEvent
    | ConverseDoneEvent
)


# Type alias for the observation-tool callback.
ObservationToolRunner = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


async def _stream_one_pass(
    client: AsyncOpenAI,
    full_messages: list[dict],
    tools: list[dict],
    log,
) -> tuple[str, list[dict], str | None]:
    """Run one OpenAI chat completion stream pass. Yields nothing — collects
    text deltas internally — but the caller wraps this with another generator
    that yields events. Returns (text, tool_calls_list, finish_reason).

    tool_calls_list shape (mirrors OpenAI assistant message tool_calls field):
        [{"id": "call_xxx", "type": "function",
          "function": {"name": "...", "arguments": "json string"}}, ...]
    """
    raise NotImplementedError("inlined into converse_response_stream below")


async def converse_response_stream(
    system_prompt: str,
    messages: list[dict],
    tools: list[dict],
    call_id: str,
    *,
    run_observation_tool: ObservationToolRunner | None = None,
) -> AsyncGenerator[ConverseEvent, None]:
    """Yield typed events: text deltas as they arrive, optionally one or more
    `observation` events when observation tools execute, then optionally one
    `tool_call` event for a side-effect tool, then a `done` event.

    Observation tools loop server-side: the brain calls them, feeds results
    back to the model, and re-streams. The caller only sees the final-pass
    text + any side-effect tool_call.
    """
    log = get_logger(call_id)
    client = AsyncOpenAI(api_key=settings.llm_api_key)
    start = time.perf_counter()

    # Mutable working copy — observation loop appends assistant + tool messages.
    working_messages: list[dict] = list(messages)

    total_text_chunks = 0
    total_observations = 0
    final_finish_reason: str | None = None

    try:
        for tool_turn in range(MAX_TOOL_TURNS + 1):
            stream = await client.chat.completions.create(
                model=settings.openai_model,
                messages=_build_messages(system_prompt, working_messages),
                tools=tools,
                **_CONVERSE_PARAMS,
            )

            # Per-pass accumulators
            tool_buffers: dict[int, dict[str, Any]] = {}
            this_pass_finish: str | None = None
            this_pass_text_parts: list[str] = []

            async for chunk in stream:
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta

                if delta.content:
                    total_text_chunks += 1
                    this_pass_text_parts.append(delta.content)
                    yield {"type": "text", "delta": delta.content}

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index if tc.index is not None else 0
                        buf = tool_buffers.setdefault(
                            idx,
                            {"id": "", "name": "", "args_json": ""},
                        )
                        if tc.id:
                            buf["id"] = tc.id
                        if tc.function and tc.function.name:
                            buf["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            buf["args_json"] += tc.function.arguments

                if choice.finish_reason:
                    this_pass_finish = choice.finish_reason

            # Parse all tool calls from this pass.
            parsed_calls: list[dict[str, Any]] = []
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
                parsed_calls.append({
                    "id": buf["id"] or f"call_{tool_turn}_{len(parsed_calls)}",
                    "name": buf["name"],
                    "args": args_obj,
                    "args_json": buf["args_json"] or "{}",
                })

            # Decide what to do next.
            observation_calls = [
                c for c in parsed_calls if c["name"] in _OBSERVATION_TOOL_NAMES
            ]
            side_effect_calls = [
                c for c in parsed_calls if c["name"] not in _OBSERVATION_TOOL_NAMES
            ]

            # If the model called observation tools AND we have a runner,
            # execute them and loop.
            if observation_calls and run_observation_tool is not None and tool_turn < MAX_TOOL_TURNS:
                # 1) Append the assistant message with all tool_calls (must
                #    include side-effect calls too if present, per OpenAI's
                #    schema, but for our prompts we don't expect mixed turns).
                assistant_text = "".join(this_pass_text_parts)
                working_messages.append({
                    "role": "assistant",
                    "content": assistant_text or None,
                    "tool_calls": [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {
                                "name": c["name"],
                                "arguments": c["args_json"],
                            },
                        }
                        for c in parsed_calls
                    ],
                })

                # 2) Execute observation tools and append tool result messages.
                for c in observation_calls:
                    # Emit a thinking event BEFORE awaiting the DB roundtrip so
                    # the gateway can fill the dead-air gap with a filler.
                    yield {"type": "thinking", "tool": c["name"]}
                    try:
                        result = await run_observation_tool(c["name"], c["args"])
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "observation_tool_error",
                            tool=c["name"],
                            error=str(exc),
                        )
                        result = {"error": "tool_execution_failed", "message": str(exc)}
                    total_observations += 1
                    yield {
                        "type": "observation",
                        "name": c["name"],
                        "args": c["args"],
                        "result": result,
                    }
                    working_messages.append({
                        "role": "tool",
                        "tool_call_id": c["id"],
                        "content": json.dumps(result),
                    })

                # 3) For any side-effect calls in the same turn, also append a
                #    placeholder tool result so OpenAI doesn't reject the next
                #    request. We then yield those so the gateway can dispatch.
                for c in side_effect_calls:
                    working_messages.append({
                        "role": "tool",
                        "tool_call_id": c["id"],
                        "content": json.dumps({"dispatched": True}),
                    })
                    yield {"type": "tool_call", "name": c["name"], "args": c["args"]}

                # Loop back for another pass.
                continue

            # No observation calls (or no runner / hit cap) — finish.
            for c in side_effect_calls:
                yield {"type": "tool_call", "name": c["name"], "args": c["args"]}

            # If we hit the cap with leftover observation calls and no runner,
            # they get yielded as tool_calls so the caller at least sees them.
            if run_observation_tool is None:
                for c in observation_calls:
                    yield {"type": "tool_call", "name": c["name"], "args": c["args"]}

            final_finish_reason = this_pass_finish
            break

        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        log.info(
            "converse_stream_response",
            duration_ms=duration_ms,
            text_chunks=total_text_chunks,
            observations=total_observations,
            tool_turns=tool_turn + 1,
            finish_reason=final_finish_reason,
        )
        yield {"type": "done", "finish_reason": final_finish_reason}

    except Exception as exc:
        _raise_llm_error(log, exc)


async def converse_response(
    system_prompt: str,
    messages: list[dict],
    tools: list[dict],
    call_id: str,
    *,
    run_observation_tool: ObservationToolRunner | None = None,
) -> dict[str, Any]:
    """Non-streaming convenience wrapper. Returns
    {text, tool_call, observations: [{name,args,result}], finish_reason}."""
    text_parts: list[str] = []
    tool_call: dict[str, Any] | None = None
    observations: list[dict[str, Any]] = []
    finish_reason: str | None = None

    async for event in converse_response_stream(
        system_prompt,
        messages,
        tools,
        call_id,
        run_observation_tool=run_observation_tool,
    ):
        kind = event["type"]
        if kind == "text":
            text_parts.append(event["delta"])  # type: ignore[typeddict-item]
        elif kind == "tool_call":
            tool_call = {"name": event["name"], "args": event["args"]}  # type: ignore[typeddict-item]
        elif kind == "observation":
            observations.append({
                "name": event["name"],  # type: ignore[typeddict-item]
                "args": event["args"],  # type: ignore[typeddict-item]
                "result": event["result"],  # type: ignore[typeddict-item]
            })
        elif kind == "done":
            finish_reason = event.get("finish_reason")  # type: ignore[typeddict-item]

    return {
        "text": "".join(text_parts).strip(),
        "tool_call": tool_call,
        "observations": observations,
        "finish_reason": finish_reason,
    }
