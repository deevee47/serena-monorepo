#!/usr/bin/env bash
# Start the full Serena stack for local dev:
#   - Redis (Docker, detached)
#   - FastAPI brain      (uvicorn --reload, port 8000)
#   - Node gateway       (Bun --watch, port 3000)
#   - BullMQ worker      (Bun --watch, post-call jobs: classify, CRM, end-of-call)
#   - Next dashboard     (next dev, port 4000)
#
# Logs from all three foreground services are interleaved with a label
# prefix. Ctrl+C tears them all down and leaves Redis running (use
# `docker compose down` if you want to stop it too).

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found on PATH" >&2
  exit 1
fi

echo "→ Starting Redis (docker compose up -d redis)…"
docker compose up -d redis

# Wait for Redis to actually accept connections — concurrently doesn't
# express "wait for service" cleanly, and a cold Redis would 500 the
# gateway on startup.
echo -n "→ Waiting for Redis…"
for _ in $(seq 1 20); do
  if docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 0.5
done

echo "→ Generating Prisma clients (TS + Python)…"
bun run db:generate

echo "→ Booting brain + gateway + worker + dashboard…"
exec bunx concurrently --kill-others-on-fail \
  --names "brain,gateway,worker,dashboard" \
  --prefix-colors "magenta,cyan,green,yellow" \
  "cd fastapi-brain && NODE_GATEWAY_URL=http://127.0.0.1:3000 uv run uvicorn app.main:app --reload --port 8000" \
  "FASTAPI_BRAIN_URL=http://127.0.0.1:8000 bun run --cwd node-gateway dev" \
  "cd node-gateway && FASTAPI_BRAIN_URL=http://127.0.0.1:8000 bun --watch src/workers.ts" \
  "bun run --cwd dashboard dev"
