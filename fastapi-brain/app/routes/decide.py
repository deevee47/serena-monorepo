from fastapi import APIRouter, Request

from app.lib.limiter import limiter
from app.models.requests import DecideRequest
from app.models.responses import DecideResponse
from app.services.decision import Perception, decide
from app.utils.logger import get_logger

router = APIRouter()


@router.post("/decide", response_model=DecideResponse)
@limiter.limit("120/minute")
async def decide_endpoint(body: DecideRequest, request: Request) -> DecideResponse:
    log = get_logger(body.call_id)
    perception = Perception(
        objection_type=body.objection_type,
        objection_subtype=body.objection_subtype,
        sentiment=body.sentiment,
        stage=body.stage,
        score=body.score,
        turn_count=body.turn_count,
        prior_objection_types=body.prior_objection_types,
        discounts_offered=body.discounts_offered,
        has_alternative_product=body.has_alternative_product,
    )
    decision = decide(perception)
    log.info(
        "decided",
        tactic=decision.tactic.value,
        reasoning=decision.reasoning,
        objection_type=body.objection_type,
        subtype=body.objection_subtype,
        score=body.score,
        stage=body.stage,
    )
    return DecideResponse(
        tactic=decision.tactic.value,
        reasoning=decision.reasoning,
        micro_guidance=decision.micro_guidance,
    )
