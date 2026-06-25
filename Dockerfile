# Zintus gateway — local-first BYOK quota router.
# Build:  docker build -t zintus .
# Run:    docker run -p 8788:8788 -e GATEWAY_TOKEN=secret \
#           -v "$HOME/.zintus:/home/bun/.zintus" zintus
# Keys/quota.db live in the mounted ~/.zintus volume (no SaaS, no cloud).
# The container runs as the unprivileged `bun` user, so the persisted state
# lives under /home/bun/.zintus (NOT /root/.zintus).
#
# Base pinned by digest (oven/bun:1, multi-arch OCI index) so a rebuild is
# reproducible and immune to a moved/poisoned floating tag. Re-resolve with:
#   docker buildx imagetools inspect oven/bun:1
FROM oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base
WORKDIR /app

# --------------------------------------------------------------------------
# Build stage — has devDeps (tsup, web-tree-sitter, tree-sitter-wasms grammars)
# and produces tokzen's ./dist. Kept separate so the build toolchain/cache and
# any transient layers stay out of the final image's history.
# --------------------------------------------------------------------------
FROM base AS build

# Copy the whole curated workspace. The .dockerignore strips node_modules, build
# outputs (dist/.next/.expo), tests, .git and docs, so this is just source +
# manifests. IMPORTANT: the root bun.lock is WORKSPACE-WIDE — a partial copy
# (only packages + apps/gateway) leaves the other workspace manifests (apps/web,
# apps/cli, apps/desktop, apps/mobile, workers/*) missing, so
# `bun install --frozen-lockfile` sees an inconsistent workspace, tries to
# rewrite the lockfile, and aborts ("lockfile had changes, but lockfile is
# frozen"). Copying the full workspace keeps the frozen install identical to the
# committed lockfile. devDeps are included by default (tokzen's tsup build +
# web-tree-sitter AST mode need them). policy.json is included at the repo root.
COPY . .
RUN bun install --frozen-lockfile

# tokzen's package "exports" resolve to ./dist (a tsup build). That dist is
# gitignored AND is NOT produced by `bun install` — tokzen's postinstall only
# copies tree-sitter grammars. So we must build it here, otherwise the gateway's
# `import { compress } from "tokzen"` (apps/gateway/src/handler.ts) crashes at
# runtime with a module-not-found. tsup writes to packages/tokzen/dist, which
# the apps/gateway/node_modules/tokzen workspace symlink resolves through.
RUN bun run --filter tokzen build

# Fail LOUDLY if the build artifact or the AST grammars are missing. tokzen's
# postinstall swallows grammar-fetch errors (`2>/dev/null || true`), so without
# this assertion a silent grammar failure would ship an image that quietly
# degrades AST-mode compression to text-only. Better to break the build.
RUN test -f packages/tokzen/dist/index.js \
  && test -f packages/tokzen/dist/index.cjs \
  && ls packages/tokzen/grammars/*.wasm >/dev/null 2>&1 \
  || { echo "FATAL: tokzen dist or tree-sitter grammars missing after build"; \
       ls -la packages/tokzen/dist packages/tokzen/grammars 2>&1 || true; exit 1; }

# --------------------------------------------------------------------------
# Runtime stage — unprivileged, minimal instruction surface.
# --------------------------------------------------------------------------
FROM base AS runtime

# HOME drives os.homedir() (libuv reads $HOME first on POSIX), which every
# on-disk path derives from: ~/.zintus/{quota,cache,memory}.db + policy.json
# (see packages/router/factory.ts, packages/cache, packages/memory). Setting it
# to the bun user's home is what makes the non-root switch below actually work —
# `USER bun` alone does NOT change HOME in Docker.
ENV NODE_ENV=production \
    HOME=/home/bun \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8788

# Copy the fully-built workspace (node_modules INCLUDING web-tree-sitter +
# tokzen/dist + grammars, the workspace symlinks, and the gateway source).
#
# TRADEOFF (deliberate): we do NOT run a `bun install --production` in this
# stage. tokzen's AST-mode compression needs `web-tree-sitter`, which tokzen
# declares as a *devDependency* (and an optional peer) — a production-only
# reinstall would drop it and silently fall back to text-only compression.
# Correctness > a few MB of image size. The dropped weight would be small anyway
# (tsup et al.), so we keep the full, already-resolved dependency tree.
COPY --from=build --chown=bun:bun /app /app

# State dir for keys + *.db, owned by the unprivileged runtime user. Persist it
# by mounting a volume here (compose uses the `zintus-data` named volume, which
# inherits this dir's `bun` ownership so the non-root process can write).
RUN mkdir -p /home/bun/.zintus && chown -R bun:bun /home/bun/.zintus

# Drop root: the gateway binds publicly (0.0.0.0:8788), so it must not run as
# root. oven/bun ships a `bun` user (uid 1000) for exactly this.
USER bun

EXPOSE 8788

# Let compose/Swarm/k8s detect a wedged process and auto-restart. Uses bun (no
# curl dependency) to probe the keyless /health from inside the container; a
# draining or unhealthy gateway returns non-2xx -> unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8788)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Public bind requires a token (enforced by the gateway). Pass GATEWAY_TOKEN.
CMD ["bun", "run", "apps/gateway/src/index.ts"]
