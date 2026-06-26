# OPS Agent

**Owns:** `workers/relay`, `.github/workflows`, `Dockerfile`, `docker-compose.yml`, `scripts/`
**Risk:** HIGH — this is what deploys and runs in production. Mistakes hit all users immediately.

## Source of truth
| Fact | Where |
|---|---|
| Relay bindings | `workers/relay/wrangler.toml` |
| CI jobs | `.github/workflows/ci.yml` |
| Relay release / Docker publish | `.github/workflows/release-gateway.yml`, `release-cli.yml` |
| Current deployed relay version | `cd workers/relay && bunx wrangler deployments list` |

## Production infrastructure

### Relay — `relay.zintus.ai` (Cloudflare Workers)
Deploy: `cd workers/relay && bunx wrangler deploy`
Verify: `curl https://relay.zintus.ai/health` → `{"ok":true}`
Config: `workers/relay/wrangler.toml`

Bindings that must exist (from `wrangler.toml`):
- `GATEWAY_SESSION` — Durable Object, class `GatewaySession` (WebSocket sessions)
- `QUOTA_COUNTER` — Durable Object, class `QuotaCounter` (atomic per-user/period quota)
- `DB` — D1 database `zintus-relay`
- `KV` — KV namespace
- `[vars]`: `RELAY_BASE_URL = "https://relay.zintus.ai"`, `COOKIE_DOMAIN = ".zintus.ai"`
- Secrets (via `wrangler secret put`): `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`, `STRIPE_*`, optional `SENTRY_DSN`

> Do **not** hardcode a deployment version id in docs — it's stale the next deploy.
> Run `bunx wrangler deployments list` to see the live version.

### Web — `zintus.ai` (Vercel)
Auto-deploys on push to `main`. No manual deploy.

### Gateway
Runs on **user machines** (`zintus serve --cloud`). We don't deploy it.

### Docker — `ghcr.io/trustphoneapp/zintus-gateway`
Multi-stage build; **tokzen's `dist` is built INSIDE the image** (it's gitignored
and not produced by `bun install`). Copy the **whole curated workspace** in the
build stage — a partial copy breaks `bun install --frozen-lockfile` because
`bun.lock` is workspace-wide. Non-root `USER bun` + `ENV HOME=/home/bun`.
`HEALTHCHECK` on `/health`. Digest-pinned base. Never bake host `dist/` into the
image (`.dockerignore` strips it). Published by `release-gateway.yml` on a `v*` tag.

## CI pipeline (`.github/workflows/ci.yml`) — REAL job names
`typecheck · security · test · coverage · apps · packages · cli-smoke ·
gateway-smoke · build-apps · docker-smoke · load-test · diff-coverage`

- `build-apps` runs **only on `main`** (`if: github.ref == 'refs/heads/main'`).
- `docker-smoke` (build + `docker run` + `curl /health` + asserts non-root) and
  `load-test` (k6 against `/health` + `/v1/chat/completions`) run on **PRs**.
- `security` = gitleaks (uses `GITHUB_TOKEN`, no license needed on an org repo).
- The exact required-to-stay-green set is whatever `ci.yml` defines — read it, don't guess.

## Rules
- **Never push to `main`.** Never edit `ci.yml` without reading the whole file.
- After relay changes: `bunx wrangler deploy` → `curl https://relay.zintus.ai/health`
  → confirm bindings still match `wrangler.toml`.
- The `QuotaCounter` DO migration is **additive** (`[[migrations]]` in
  `wrangler.toml`) — safe to deploy; it does not touch `GatewaySession`.

## When you're done
- [ ] `bun run test` + `bun run typecheck` — green
- [ ] For relay changes: deployed + `/health` verified
- [ ] PR opened, not merged
