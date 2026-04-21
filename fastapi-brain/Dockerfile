FROM python:3.11-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV PRISMA_HOME_DIR=/app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY fastapi-brain/pyproject.toml fastapi-brain/uv.lock ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN uv venv /app/.venv && uv sync --frozen --no-dev
RUN DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres" \
    DATABASE_URL_DIRECT="postgresql://postgres:postgres@localhost:5432/postgres" \
    uv run prisma py generate --schema /app/prisma/schema.prisma --generator python

FROM python:3.11-slim AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/.cache /app/.cache

WORKDIR /app
ENV PRISMA_HOME_DIR=/app
COPY fastapi-brain/app/ ./app/

ENV PATH="/app/.venv/bin:$PATH"

RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app/.cache
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
