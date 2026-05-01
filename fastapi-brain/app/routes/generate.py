import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.lib.limiter import limiter
from app.models.requests import GenerateResponseRequest
from app.models.responses import GenerateResponseResponse
from app.services.llm import generate_response, stream_response
from app.services.prompt_builder import build_conversation_messages, build_system_prompt
from app.utils.logger import get_logger

router = APIRouter()


@router.post("/generate", response_model=GenerateResponseResponse)
@limiter.limit("60/minute")
async def generate(body: GenerateResponseRequest, request: Request) -> GenerateResponseResponse:
    log = get_logger(body.call_id)
    system_prompt = build_system_prompt(body)
    messages = build_conversation_messages(body)
    text = await generate_response(system_prompt, messages, body.call_id)
    log.debug("generate_response", text=text)
    return GenerateResponseResponse(text=text)


@router.post("/generate/stream")
@limiter.limit("60/minute")
async def generate_stream(body: GenerateResponseRequest, request: Request) -> StreamingResponse:
    system_prompt = build_system_prompt(body)
    messages = build_conversation_messages(body)

    async def event_generator() -> AsyncGenerator[str, None]:
        async for chunk in stream_response(system_prompt, messages, body.call_id):
            yield f"data: {json.dumps({'text': chunk})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
