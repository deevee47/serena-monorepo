FROM python:3.11-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv venv /app/.venv && uv sync --frozen --no-dev

FROM python:3.11-slim AS runner
COPY --from=builder /app/.venv /app/.venv

WORKDIR /app
COPY app/ ./app/

ENV PATH="/app/.venv/bin:$PATH"

RUN groupadd -r appuser && useradd -r -g appuser appuser
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
