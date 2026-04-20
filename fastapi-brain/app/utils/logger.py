from typing import Any

import structlog

from app.config.settings import settings


def configure_logging() -> None:
    renderer: Any = (
        structlog.dev.ConsoleRenderer(colors=True)
        if settings.environment == "development"
        else structlog.processors.JSONRenderer()
    )
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.stdlib.add_log_level,
            structlog.contextvars.merge_contextvars,
            renderer,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
    )


def get_logger(call_id: str | None = None) -> structlog.stdlib.BoundLogger:
    bound = structlog.get_logger().bind(service="fastapi-brain")
    if call_id:
        bound = bound.bind(call_id=call_id)
    return bound  # type: ignore[return-value]
