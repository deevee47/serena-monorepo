"""Function-calling LLM converse endpoint.

One LLM call per turn (with optional observation-tool loop). The model
decides whether to talk, call tools, or both. Replaces the rules-engine +
tactic + speech-prompt pipeline with a single focused call backed by native
OpenAI function-calling.
"""

import json
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.lib.limiter import limiter
from app.models.requests import ConverseRequest
from app.models.responses import ConverseResponse, ConverseToolCall
from app.services.converse_prompt_builder import build_converse_system_prompt
from app.services.llm import converse_response, converse_response_stream
from app.services.observations import execute_observation_tool
from app.services.prompt_sections import build_chat_messages
from app.services.tools import (
    OPENAI_TOOLS,
    ValidationError,
    is_observation_tool,
    parse_tool_call,
)
from app.utils.logger import get_logger

router = APIRouter()


def _build_inputs(body: ConverseRequest) -> tuple[str, list[dict]]:
    system_prompt = build_converse_system_prompt(
        product_context=body.product_context,
        alternative_product_context=body.alternative_product_context,
        cart_context=body.cart_context,
        customer_context=body.customer_context,
        discounts_already_offered=body.discounts_already_offered,
    )
    messages = build_chat_messages(
        utterance=body.utterance,
        conversation_history=body.conversation_history,
    )
    return system_prompt, messages


def _make_observation_runner(request: Request, call_id: str):
    """Build a closure that the LLM streamer calls when an observation tool
    fires. The DB lives on app.state.db (set up in main.py lifespan)."""
    db = getattr(request.app.state, "db", None)
    log = get_logger(call_id)

    async def runner(name: str, args: dict[str, Any]) -> dict[str, Any]:
        # Re-validate args via Pydantic before executing — this protects the
        # downstream observation impl from bad args even if the LLM violates.
        try:
            validated = parse_tool_call(name, args)
        except (ValidationError, ValueError) as exc:
            log.warning("observation_tool_invalid_args", tool=name, error=str(exc))
            return {"error": "invalid_args", "tool": name}
        if db is None:
            log.warning("observation_tool_no_db", tool=name)
            return {"error": "db_unavailable", "tool": name}
        result = await execute_observation_tool(db, validated.name, validated.args)
        log.info("observation_tool_result", tool=name, args=validated.args, result=result)
        return result

    return runner


def _validate_side_effect_tool(name: str, args: dict, call_id: str) -> ConverseToolCall | None:
    """Validate a side-effect tool call. Returns None on validation failure
    (logged) — the gateway then treats the turn as text-only."""
    log = get_logger(call_id)
    if is_observation_tool(name):
        # Shouldn't happen — observation tools should be intercepted before
        # they reach the gateway. Defensive: drop.
        log.warning("observation_tool_leaked_to_gateway", tool=name)
        return None
    try:
        validated = parse_tool_call(name, args)
    except ValidationError as exc:
        log.warning("tool_call_invalid", tool=name, args=args, errors=exc.errors())
        return None
    except ValueError as exc:
        log.warning("tool_call_unknown", tool=name, message=str(exc))
        return None
    return ConverseToolCall(name=validated.name, args=validated.args)


@router.post("/converse", response_model=ConverseResponse)
@limiter.limit("60/minute")
async def converse(body: ConverseRequest, request: Request) -> ConverseResponse:
    log = get_logger(body.call_id)
    system_prompt, messages = _build_inputs(body)
    runner = _make_observation_runner(request, body.call_id)
    result = await converse_response(
        system_prompt,
        messages,
        OPENAI_TOOLS,
        body.call_id,
        run_observation_tool=runner,
    )

    tool_call: ConverseToolCall | None = None
    if result["tool_call"]:
        tool_call = _validate_side_effect_tool(
            result["tool_call"]["name"],
            result["tool_call"]["args"],
            body.call_id,
        )

    log.info(
        "converse_response",
        text_len=len(result["text"]),
        tool=tool_call.name if tool_call else None,
        observations=len(result.get("observations", [])),
        finish_reason=result["finish_reason"],
    )
    return ConverseResponse(
        text=result["text"],
        tool_call=tool_call,
        finish_reason=result["finish_reason"],
    )


@router.post("/converse/stream")
@limiter.limit("60/minute")
async def converse_stream(body: ConverseRequest, request: Request) -> StreamingResponse:
    """SSE stream emits typed events:
        data: {"type":"text","delta":"..."}
        data: {"type":"observation","name":"...","args":{...},"result":{...}}
        data: {"type":"tool_call","name":"...","args":{...}}     (side-effect)
        data: {"type":"done","finish_reason":"..."}

    Observation tools execute server-side (LLM gets the result back); the
    gateway sees `observation` events for logging only. Side-effect tool
    calls are still gateway-dispatched."""

    system_prompt, messages = _build_inputs(body)
    runner = _make_observation_runner(request, body.call_id)

    async def event_generator() -> AsyncGenerator[str, None]:
        async for event in converse_response_stream(
            system_prompt,
            messages,
            OPENAI_TOOLS,
            body.call_id,
            run_observation_tool=runner,
        ):
            kind = event["type"]
            if kind == "tool_call":
                validated = _validate_side_effect_tool(
                    event["name"],  # type: ignore[typeddict-item]
                    event["args"],  # type: ignore[typeddict-item]
                    body.call_id,
                )
                if validated is None:
                    continue
                yield (
                    "data: "
                    + json.dumps({"type": "tool_call", "name": validated.name, "args": validated.args})
                    + "\n\n"
                )
            else:
                yield "data: " + json.dumps(event) + "\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
