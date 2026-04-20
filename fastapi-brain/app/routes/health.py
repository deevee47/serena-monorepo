from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "fastapi-brain"}


@router.get("/ready")
async def ready(request: Request) -> JSONResponse:
    try:
        db = request.app.state.db
        await db.query_raw("SELECT 1")
        return JSONResponse({"status": "ok"})
    except Exception:
        return JSONResponse({"status": "unavailable", "reason": "database"}, status_code=503)
