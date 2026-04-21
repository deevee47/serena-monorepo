from fastapi import APIRouter, Request

from app.models.requests import ClassifyObjectionRequest
from app.models.responses import ClassifyObjectionResponse
from app.services.classifier import classify_objection
from app.utils.logger import get_logger

router = APIRouter()


@router.post("/classify", response_model=ClassifyObjectionResponse)
async def classify(body: ClassifyObjectionRequest, request: Request) -> ClassifyObjectionResponse:
    log = get_logger(body.call_id)
    objection_type, sentiment, confidence = await classify_objection(
        body.utterance, body.stage, body.score, body.call_id
    )
    log.info(
        "classified",
        utterance=body.utterance[:100],
        objection_type=objection_type,
        sentiment=sentiment,
        confidence=confidence,
    )
    return ClassifyObjectionResponse(
        objection_type=objection_type,
        sentiment=sentiment,
        confidence=confidence,
    )
