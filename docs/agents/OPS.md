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
Deploy: `cd workers/relay && bun run deploy`
(`deploy` runs `wrangler deploy --message "$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)"`,
stamping the live git SHA into the Cloudflare Version `Message` — `-dirty` if deployed
from uncommitted changes — so `wrangler deployments list` shows exactly which commit
is live; drift is verifiable, not inferred)
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
- `security` = `bun audit` (non-gating, see below) + gitleaks (uses `GITHUB_TOKEN`, no license needed on an org repo).
- The exact required-to-stay-green set is whatever `ci.yml` defines — read it, don't guess.

### CI decisions (documented, not guessed) — `ci.yml` line refs

All 12 jobs above are real. Three are deliberately non-blocking or scoped; the
reasons are recorded here so nobody "fixes" them by accident:

**(a) `build-apps` is main-only.** `if: github.ref == 'refs/heads/main'`
(`ci.yml:210`). It runs the real deployable builds — `tsc -b tsconfig.build.json`
+ `next build` for `@zintus/web` (`ci.yml:225,229`) — which earlier CI skipped
(the audit's H5: PR CI only *typechecked* web, so a broken `next build` could
merge). Kept off PRs because the full Next.js build is the slow step and the
Docker image build is already covered on PRs by `docker-smoke`.
> **Recommendation:** add a lighter PR-only `next build` step (or move
> `build-apps` to also run on PRs) so a broken production web build is caught
> *before* merge, not just post-merge on `main`. Tracked as an accepted gap.

**(b) `bun audit` is non-gating.** The `Dependency audit (high+)` step is
`continue-on-error: true` (`ci.yml:42`, runs `bun audit --audit-level=high`).
**Accepted risk:** the known transitive highs are `undici` (via `wrangler`) and
`xmldom` (via `expo`) — not in a runtime-exploitable path for us, and not yet
upstream-fixed. **Path to gate:** once `bun audit --audit-level=high` is clean,
remove `continue-on-error` so the step blocks. gitleaks in the same job **is**
gating (fails on any finding).

**(c) `diff-coverage` is report-only at 80%.** The gate runs
`diff-cover --fail-under=80` against `origin/main` but is `continue-on-error:
true` (`ci.yml:335`, PR-only via `ci.yml:316`). **Waiver:** it surfaces untested
*new* lines as a signal without blocking merges while coverage on touched code
stabilizes. The merged-lcov pipeline it consumes (`scripts/coverage.ts`, job
`coverage`) is the enforcing one. Flip `continue-on-error` to gate once new-line
coverage reliably clears 80%.

## Rules
- **Never push to `main` without running tests first.** Never edit `ci.yml` without reading the whole file.
- After relay changes: `bun run deploy` (stamps the git SHA) → `curl https://relay.zintus.ai/health`
  → confirm bindings still match `wrangler.toml`.
- The `QuotaCounter` DO migration is **additive** (`[[migrations]]` in
  `wrangler.toml`) — safe to deploy; it does not touch `GatewaySession`.

## When you're done
- [ ] `bun run test` + `bun run typecheck` — green
- [ ] For relay changes: deployed + `/health` verified
- [ ] PR opened, not merged
