from fastapi import APIRouter

from app.models.requests import AlternativesRequest
from app.models.responses import AlternativesResponse
from app.services import product as product_service
from app.utils.logger import get_logger

router = APIRouter(prefix="/products", tags=["products"])


@router.post("/alternatives", response_model=AlternativesResponse)
async def alternatives(req: AlternativesRequest) -> AlternativesResponse:
    log = get_logger()
    log.info("alternatives_request", exclude_id=req.exclude_id, has_price_filter=req.current_price is not None)

    if req.current_price is not None:
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
        )

    return AlternativesResponse(alternatives=alternatives_list)
