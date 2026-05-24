# syntax=docker/dockerfile:1.7
# ai-scalper: multi-stage Dockerfile.
#   Stage 1 (builder): install all deps, run typecheck.
#   Stage 2 (runtime): slim image, prod-ready.

FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/ apps/
COPY packages/ packages/
COPY tsconfig.base.json tsconfig.json ./
RUN bun install --frozen-lockfile
RUN bun run typecheck

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app /app
ENV NODE_ENV=production
# Bull Board UI
EXPOSE 3010
# Default entry: `bun run all` runs worker stack + bull-board concurrently.
# Override with `docker run ... bun run worker` etc. as needed.
CMD ["bun", "run", "all"]
