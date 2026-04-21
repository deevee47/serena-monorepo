from fastapi import Request
from slowapi import Limiter


def _get_call_id(request: Request) -> str:
    return request.headers.get("x-call-id") or (
        request.client.host if request.client else "unknown"
    )


limiter = Limiter(key_func=_get_call_id)
