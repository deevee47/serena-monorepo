import asyncio
import time
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from prisma import Prisma
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config.settings import settings
from app.lib.limiter import limiter
from app.middleware.auth import verify_internal_secret
from app.routes.classify import router as classify_router
from app.routes.decide import router as decide_router
from app.routes.generate import router as generate_router
from app.routes.health import router as health_router
from app.routes.products import router as products_router
from app.utils.errors import BrainError
from app.utils.logger import configure_logging, get_logger


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    configure_logging()
    log = get_logger()
    db = Prisma(datasource={"url": settings.database_url})
    try:
        await asyncio.wait_for(db.connect(), timeout=5.0)
        log.info("Database connected")
    except Exception as exc:
        log.warning("Database connection failed at startup", error=str(exc))
    app.state.db = db
    log.info("FastAPI Brain started")
    yield
    if db.is_connected():
        await db.disconnect()
    log.info("FastAPI Brain shutting down")


app = FastAPI(
    title="Voice Agent Brain",
    version="1.0.0",
    docs_url=None if settings.environment == "production" else "/docs",
    lifespan=lifespan,
    dependencies=[Depends(verify_internal_secret)],
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    start = time.perf_counter()
    call_id = request.headers.get("X-Call-ID")
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start) * 1000
    get_logger(call_id).info(
        "request",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        duration_ms=round(duration_ms, 2),
    )
    return response


@app.exception_handler(BrainError)
async def brain_error_handler(request: Request, exc: BrainError) -> JSONResponse:
    call_id = request.headers.get("X-Call-ID")
    get_logger(call_id).error(
        "BrainError", error_type=type(exc).__name__, message=exc.message
    )
    return JSONResponse(
        status_code=500,
        content={"error": {"type": type(exc).__name__, "message": exc.message}},
    )


app.include_router(health_router)
app.include_router(classify_router)
app.include_router(decide_router)
app.include_router(generate_router)
app.include_router(products_router)
