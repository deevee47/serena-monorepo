FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD ["bun", "--watch", "src/server.ts"]
