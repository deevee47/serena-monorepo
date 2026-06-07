# Production image for the Next.js admin dashboard.
#
# Built from the REPO ROOT (context: .) so it can generate the shared Prisma
# client (dashboard/src/lib/prisma.ts reads Postgres directly). Used by
# docker-compose.coolify.yml.
#
# Every dashboard page is `export const dynamic = 'force-dynamic'`, so `next build`
# does NOT hit Postgres/Redis at build time — no DB/Redis env is needed to build.
FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 1) Install workspace deps (cached on the manifests).
COPY package.json bun.lock ./
COPY node-gateway/package.json ./node-gateway/
COPY dashboard/package.json ./dashboard/
RUN bun install --frozen-lockfile

# 2) Source.
COPY . .

# 3) Prisma client for the dashboard's direct DB reads.
RUN bunx prisma generate --generator client

# 4) Build. DASHBOARD_DOMAIN is baked into next.config's Server-Action origin
#    allow-list at build time (see dashboard/next.config.ts). Pass it as a build
#    arg from Coolify (mark it available at build time).
ARG DASHBOARD_DOMAIN
ENV DASHBOARD_DOMAIN=$DASHBOARD_DOMAIN
WORKDIR /app/dashboard
RUN bun run build

EXPOSE 4000
# `next start -p 4000` (binds 0.0.0.0 by default).
CMD ["bun", "run", "start"]
