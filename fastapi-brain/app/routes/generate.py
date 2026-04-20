from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.post("/generate")
async def generate() -> JSONResponse:
    # Phase 3 implementation — stub for Phase 1 auth verification
    return JSONResponse({"error": "Not yet implemented"}, status_code=501)
