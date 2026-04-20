import secrets

from fastapi import HTTPException, Request

from app.config.settings import settings


async def verify_internal_secret(request: Request) -> None:
    if request.url.path in ("/health", "/ready"):
        return
    secret = request.headers.get("X-Internal-Secret", "")
    if not secrets.compare_digest(secret, settings.internal_service_secret):
        raise HTTPException(status_code=403, detail="Forbidden")
