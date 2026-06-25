# Changelog

All notable changes to Zintus are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project is pre-1.0 so
minor versions may include breaking changes.

## [Unreleased] — production-readiness follow-through

Closes remaining audit gaps on top of 0.2.0.

### Removed
- **Unwired managed-key scaffold deleted** (`crypto.ts`, `managed-keys.ts`). It
  was operator-decryptable, wired into zero routes, and contradicted the
  BYOK-first zero-knowledge model. Recoverable from git history when a real
  client-wrapped design is built. (Supersedes the 0.2.0 managed-key HKDF entry.)

### Security / billing
- **Managed-key paid tiers gated "Coming soon"**, Stripe checkout disabled for
  them (`503 managed_keys_unavailable`) so no one pays for an unbuilt feature.
  Single `MANAGED_KEYS_AVAILABLE` toggle (relay `tiers.ts` + pricing page).

### Reliability
- **Mid-stream SSE idle watchdog** (`GATEWAY_STREAM_IDLE_TIMEOUT_MS`, default
  60s, `0` disables): aborts a stalled upstream that stops sending chunks
  mid-stream, instead of relying only on the connect/first-token timeout.

### Deployment
- **Docker image is now self-contained and hardened**: builds tokzen's `dist`
  in-image (fixes a runtime crash in the published image), multi-stage,
  non-root `USER bun` + `HOME`, `HEALTHCHECK`, digest-pinned base, `.dockerignore`.
  CI runs a `docker run` + `/health` smoke on PRs and main; the release workflow
  smokes before pushing to GHCR.

### Web / legal
- **DRAFT privacy, terms, and security pages** grounded in the real architecture
  (GDPR + CCPA + ToS sections), plus `/.well-known/security.txt` (RFC 9116).
  Banner-marked DRAFT pending legal review.

### Docs
- README savings endpoint corrected to the auth-gated `/v1/status`.
- Added a network-exposed deployment checklist (`docs/DEPLOY.md`).

## [0.2.0] — 2026-06-24 — production hardening

Hardening pass from the production-readiness audit
(see `docs/PRODUCTION-ARCHITECTURE.md`).

### Security
- **`/health` no longer leaks provider topology.** It now returns only
  `{ ok, auth }`. The full provider inventory, key presence, live quota, and
  savings moved to the auth-gated **`GET /v1/status`**. The web, desktop, and
  mobile clients and the cloud relay `getStatus` were migrated to `/v1/status`
  (with bearer auth) so their usage/provider UIs keep working; `/health` remains
  the unauthenticated liveness probe.
- **Per-client rate limiting** on `/v1/chat/completions` and `/v1/research`
  via `GATEWAY_RATELIMIT_RPM` (keyed by client IP then bearer token; returns 429
  + `Retry-After`). Off by default.
- **Schema-validated request bodies** (zod) at the gateway (chat **and**
  research) and the relay's public magic-link endpoint, via the new
  `@zintus/schemas` package. Malformed bodies get a `400` with field-level
  issues instead of partial handling.
- **Rate-limit keying hardened**: defaults to the unspoofable bearer token;
  `X-Forwarded-For` is trusted only behind a configured reverse proxy
  (`GATEWAY_TRUST_PROXY`).
- **Relay managed-key encryption upgraded** from raw `slice(0,32).padEnd` key
  bytes to **HKDF-SHA256** key derivation (AES-256-GCM). Existing ciphertext
  still decrypts via a legacy fallback. `SECURITY.md` now documents that managed
  (Pro) keys are operator-decryptable, while BYOK remains zero-knowledge.
- **CI security job**: `bun audit --audit-level=high` (non-gating during
  triage) + gitleaks secret scanning over full history.

### Reliability
- **Provider fetches are cancellable.** An `AbortSignal` now threads
  `RouteRequest → router → provider fetch`. A client disconnect or the request
  timeout aborts the upstream socket and releases the in-flight quota
  reservation instead of leaking it.
- **Graceful shutdown.** `SIGTERM`/`SIGINT` drains in-flight streams, flips
  `/health` to `503 draining`, closes the cloud relay connection (previously its
  `.close()` was unreachable), and clears background timers — bounded by
  `GATEWAY_DRAIN_TIMEOUT_MS`.
- **Circuit-breaker half-open gate.** A recovering provider (recent errors but
  below the streak threshold) admits a single probe at a time, so a concurrent
  burst can't all rush a provider that may still be down.

### Observability
- **Opt-in error sink**: wire `onError → Sentry` via `SENTRY_DSN` (dynamically
  loaded; zero dependency when unset). New `zintus_gateway_rate_limited_total`
  Prometheus counter.

### Performance
- **memory-store indexes** on `thread_id` (+ a `thread_id,key` composite),
  removing full-table scans on every memory read path.

### CI / tests
- tokzen (77) and relay (50, incl. new crypto tests) suites now run in CI.
- tokzen on-disk state (CCR/eval-cache) is isolated via `TOKZEN_HOME` so the
  suite is hermetic and doesn't depend on a writable `$HOME`. CI sets it
  explicitly; the root `test` script also defaults it to a workspace-local
  `.tokzen-test/`, so local `bun run test` matches CI on any machine. Covered by
  a new `ccr-home.test.ts`.
- `workers/relay` added to the typecheck matrix **and** the composite build
  (`tsconfig.build.json` references).
- New tests: gateway rate limiter, `/v1/status`, draining `/health`, 429 path,
  zod rejection, relay HKDF crypto round-trip + legacy fallback.

### Docs
- Added `docs/PRODUCTION-ARCHITECTURE.md`, root `.env.example`, this changelog,
  and expanded `SECURITY.md` (relay trust model, `/health`, rate limiting,
  shutdown).
