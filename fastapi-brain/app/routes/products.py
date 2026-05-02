from fastapi import APIRouter

from app.models.requests import AlternativesRequest
from app.models.responses import AlternativesResponse
from app.services import product as product_service
from app.utils.logger import get_logger

router = APIRouter(prefix="/products", tags=["products"])


@router.post("/alternatives", response_model=AlternativesResponse)
async def alternatives(req: AlternativesRequest) -> AlternativesResponse:
    log = get_logger()
    log.info(
        "alternatives_request",
        exclude_id=req.exclude_id,
        direction=req.direction,
        has_price_filter=req.current_price is not None,
    )

    if req.current_price is not None and req.direction == "premium":
        # Anchor up: find ONE same-category product priced above current.
        results = await product_service.find_alternatives(
            query=req.query,
            exclude_id=req.exclude_id,
            top_k=1,
            category=req.category,
            min_price=req.current_price,
        )
        alternatives_list = results[:1]
    elif req.current_price is not None:
        result = await product_service.find_cheaper_alternative(
            current_price=req.current_price,
            query=req.query,
            exclude_id=req.exclude_id,
            category=req.category,
        )
        alternatives_list = [result] if result else []
    else:
        alternatives_list = await product_service.find_alternatives(
            query=req.query,
            exclude_id=req.exclude_id,
            top_k=req.top_k,
            category=req.category,
        )

    return AlternativesResponse(alternatives=alternatives_list)
