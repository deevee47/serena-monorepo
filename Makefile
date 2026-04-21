.PHONY: setup dev test lint prisma-generate migrate seed simulate-call

setup:
	cp .env.example .env
	@echo "Edit .env and paste your Neon DATABASE_URL and DATABASE_URL_DIRECT before continuing."
	bun install
	uv sync --directory fastapi-brain
	docker-compose up -d redis
	make prisma-generate
	make migrate
	make seed

dev:
	docker-compose up

test:
	bun test
	cd fastapi-brain && uv run pytest

lint:
	bun run lint
	cd fastapi-brain && uv run ruff check app/ tests/

prisma-generate:
	bunx prisma generate --generator client
	cd fastapi-brain && uv run prisma py generate --schema ../prisma/schema.prisma --generator python

migrate:
	bunx prisma migrate deploy

seed:
	bun run scripts/seed.ts

simulate-call:
	bun run scripts/simulate-call.ts
