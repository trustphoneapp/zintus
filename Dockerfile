# MultipleAI gateway — local-first BYOK quota router.
# Build:  docker build -t multipleai .
# Run:    docker run -p 8788:8788 -e GATEWAY_TOKEN=secret \
#           -v "$HOME/.multipleai:/root/.multipleai" multipleai
# Keys/quota.db live in the mounted ~/.multipleai volume (no SaaS, no cloud).
FROM oven/bun:1 AS base
WORKDIR /app

# Install workspace deps (cached unless manifests change).
COPY package.json bun.lock tsconfig*.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
# A sample policy.json may be mounted/overridden at runtime.
COPY policy.json ./policy.json
RUN bun install --frozen-lockfile

EXPOSE 8788
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=8788

# Public bind requires a token (enforced by the gateway). Pass GATEWAY_TOKEN.
CMD ["bun", "run", "apps/gateway/src/index.ts"]
