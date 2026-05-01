"""Function-calling LLM converse endpoint.

One LLM call per turn. The model decides whether to talk, call a tool, or
both. Replaces the rules-engine + tactic + speech-prompt pipeline with a
single focused call backed by native OpenAI function-calling.
"""

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.lib.limiter import limiter
from app.models.requests import ConverseRequest
from app.models.responses import ConverseResponse, ConverseToolCall
from app.services.converse_prompt_builder import build_converse_system_prompt
from app.services.llm import converse_response, converse_response_stream
from app.services.prompt_sections import build_chat_messages
from app.services.tools import OPENAI_TOOLS, ValidationError, parse_tool_call
from app.utils.logger import get_logger

router = APIRouter()


def _build_inputs(body: ConverseRequest) -> tuple[str, list[dict]]:
    system_prompt = build_converse_system_prompt(
        product_context=body.product_context,
        alternative_product_context=body.alternative_product_context,
        cart_context=body.cart_context,
        discounts_already_offered=body.discounts_already_offered,
    )
    messages = build_chat_messages(
        utterance=body.utterance,
        conversation_history=body.conversation_history,
    )
    return system_prompt, messages


def _validate_tool_call(name: str, args: dict, call_id: str) -> ConverseToolCall | None:
    """Validate tool args via Pydantic. On failure, log and return None — the
    gateway should treat that as a text-only turn rather than a malformed
    tool dispatch. The dispatcher does a final clamp regardless."""
    log = get_logger(call_id)
    try:
        validated = parse_tool_call(name, args)
    except ValidationError as exc:
        log.warning(
            "tool_call_invalid",
            tool=name,
            args=args,
            errors=exc.errors(),
        )
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
    result = await converse_response(system_prompt, messages, OPENAI_TOOLS, body.call_id)

    tool_call: ConverseToolCall | None = None
    if result["tool_call"]:
        tool_call = _validate_tool_call(
            result["tool_call"]["name"],
            result["tool_call"]["args"],
            body.call_id,
        )

    log.info(
        "converse_response",
        text_len=len(result["text"]),
        tool=tool_call.name if tool_call else None,
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
        data: {"type":"tool_call","name":"...","args":{...}}
        data: {"type":"done","finish_reason":"..."}

    The gateway should fire Vapi /say only on text events and dispatch tools
    only on tool_call events. Tool args are pre-validated; invalid calls are
    silently dropped (logged) so a malformed tool can't propagate."""

    system_prompt, messages = _build_inputs(body)

    async def event_generator() -> AsyncGenerator[str, None]:
        async for event in converse_response_stream(
            system_prompt, messages, OPENAI_TOOLS, body.call_id
        ):
            kind = event["type"]
            if kind == "tool_call":
                validated = _validate_tool_call(
                    event["name"],  # type: ignore[typeddict-item]
                    event["args"],  # type: ignore[typeddict-item]
                    body.call_id,
                )
                if validated is None:
                    # Drop the tool call but let the rest of the stream finish.
                    continue
                yield (
                    "data: "
                    + json.dumps({"type": "tool_call", "name": validated.name, "args": validated.args})
                    + "\n\n"
                )
            else:
                yield "data: " + json.dumps(event) + "\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
