from fastapi import APIRouter, Request

from app.lib.limiter import limiter
from app.models.requests import ClassifyObjectionRequest
from app.models.responses import ClassifyObjectionResponse
from app.services.classifier import classify_objection
from app.utils.logger import get_logger

router = APIRouter()


@router.post("/classify", response_model=ClassifyObjectionResponse)
@limiter.limit("60/minute")
async def classify(body: ClassifyObjectionRequest, request: Request) -> ClassifyObjectionResponse:
    log = get_logger(body.call_id)
    result = await classify_objection(body.utterance, body.stage, body.score, body.call_id)
    log.info(
        "classified",
        utterance=body.utterance[:100],
        objection_type=result.objection_type,
        sentiment=result.sentiment,
        confidence=result.confidence,
        subtype=result.subtype,
    )
    return ClassifyObjectionResponse(
        objection_type=result.objection_type,
        sentiment=result.sentiment,
        confidence=result.confidence,
        subtype=result.subtype,
    )
