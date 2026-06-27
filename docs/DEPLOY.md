# Deploying a network-exposed Zintus gateway

Zintus is local-first: by default the gateway binds `127.0.0.1` and needs no
auth. The moment you expose it beyond loopback (a VPS, a LAN, a container with a
published port, behind a reverse proxy), treat it as a service that can spend
real provider quota/credits for anyone who can reach it. This checklist covers
the settings that matter for that case.

> **One-line threat model:** anyone who can reach the gateway *and* present
> `GATEWAY_TOKEN` can use every provider key in the host keychain. Scope the
> token and the network accordingly.

## Required for any non-loopback bind

| Setting | Why |
|---|---|
| **`GATEWAY_TOKEN`** | Required. The gateway refuses to serve a public bind without a token. Generate a strong one: `openssl rand -hex 24`. All endpoints except `/health` require `Authorization: Bearer $GATEWAY_TOKEN`. Auth uses a constant-time compare. |
| **`GATEWAY_HOST` / `GATEWAY_PORT`** | Set `GATEWAY_HOST=0.0.0.0` only when you intend to expose it. Prefer binding loopback and fronting it with a reverse proxy that terminates TLS. |

## Strongly recommended

| Setting | Why |
|---|---|
| **`GATEWAY_RATELIMIT_RPM`** | **Off by default.** Set it on any exposed deployment to cap requests per client on `/v1/chat/completions` and `/v1/research` (429 + `Retry-After`). Keyed by bearer token first, then client IP. |
| **`GATEWAY_TRUST_PROXY`** | Leave **unset** unless the gateway sits behind a trusted reverse proxy. Only when set is `X-Forwarded-For` trusted for rate-limit/IP keying — otherwise a client can spoof it. |
| **`GATEWAY_CORS_ORIGIN`** | Set to your web origin(s) if browsers call the gateway directly. Do not use a wildcard with credentials. |
| **TLS** | Terminate HTTPS at a reverse proxy (Caddy/nginx/Cloudflare). The gateway speaks plain HTTP; never expose it unencrypted over the public internet. |

## Reliability / operability

| Setting | Default | Why |
|---|---|---|
| `GATEWAY_REQUEST_TIMEOUT_MS` | 60000 | Connect / first-token timeout; aborts the upstream and releases the quota reservation. |
| `GATEWAY_STREAM_IDLE_TIMEOUT_MS` | 60000 | Mid-stream idle watchdog — aborts a stalled provider that stops sending chunks. `0` disables. |
| `GATEWAY_DRAIN_TIMEOUT_MS` | — | Graceful-shutdown bound: on `SIGTERM`/`SIGINT` the gateway flips `/health` to `503 draining`, finishes in-flight streams, then exits. Give your orchestrator at least this long before `SIGKILL`. |
| `GATEWAY_MAX_BODY_BYTES` / `GATEWAY_MAX_MESSAGES` | — | Bound request size / message count to limit abuse. |
| `SENTRY_DSN` | unset | Opt-in error sink (`onError → Sentry`). Zero dependency when unset. |

## Health & observability endpoints

- `GET /health` — **unauthenticated, minimal** liveness probe (`{ ok, ... }`,
  returns `503` while draining). Use this for load-balancer / container health
  checks. It deliberately exposes **no** provider topology or savings.
- `GET /v1/status` — **auth-gated**; full provider inventory, key presence, live
  quota, and savings. (`GET /v1/savings` is a focused savings view.)
- `GET /metrics` — Prometheus; auth-gated when a token is set.

## Docker

The published image runs as the non-root `bun` user; persisted state (keys,
`quota.db`) lives at `/home/bun/.zintus`. `docker-compose.yml` uses the
`zintus-data` **named volume** (writable by uid 1000). If you bind-mount a host
directory instead, pre-create it and `chown 1000:1000` it, or the non-root
process can't write. Always pass `GATEWAY_TOKEN` for a published port:

```bash
GATEWAY_TOKEN=$(openssl rand -hex 24) docker compose up -d
curl -s localhost:8788/health | jq        # minimal liveness
```

## Pre-flight checklist

- [ ] `GATEWAY_TOKEN` set to a strong random value, distributed only to clients that should spend your keys.
- [ ] `GATEWAY_RATELIMIT_RPM` set.
- [ ] `GATEWAY_TRUST_PROXY` set **only** if behind a trusted proxy; `X-Forwarded-For` not otherwise trusted.
- [ ] TLS terminated in front of the gateway; no plaintext public exposure.
- [ ] `/health` (not `/v1/status`) used for unauthenticated health checks.
- [ ] Orchestrator grace period ≥ `GATEWAY_DRAIN_TIMEOUT_MS`.
- [ ] Bind-mounted state dir `chown`ed to uid 1000 (or use the named volume).

## Post-deploy verification (copy-paste)

Run these after every deploy/publish. Each is real and matches the running code
and workflows.

```bash
# 1. Cloud relay liveness (Cloudflare Worker, relay.zintus.ai). Public, keyless.
curl -s https://relay.zintus.ai/health
# -> {"ok":true}

# 2. Gateway operational snapshot — auth-gated (provider topology, key presence,
#    live quota, savings). Replace <gateway> with the host:port you exposed.
#    /health is keyless; everything else needs the bearer token.
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" http://<gateway>:8788/v1/status | jq
#    (focused savings-only view:)
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" http://<gateway>:8788/v1/savings | jq

# 3. CLI publish landed on npm (after a cli-v* tag — see release preflight below).
npm view zintus version

# 4. GHCR image pull smoke (after a v* tag — see release preflight below).
#    GATEWAY_TOKEN is required because the image binds 0.0.0.0:8788; /health is keyless.
docker pull ghcr.io/trustphoneapp/zintus-gateway:latest
docker run -d --name zintus-gw-smoke -p 8788:8788 \
  -e GATEWAY_TOKEN=$(openssl rand -hex 24) \
  ghcr.io/trustphoneapp/zintus-gateway:latest
sleep 5 && curl -s localhost:8788/health   # -> {"ok":true,"auth":"required"}
docker rm -f zintus-gw-smoke
```

> `/v1/status` returns `401 {"error":{"message":"Unauthorized"}}` without the
> bearer token (`handler.ts`). `/health` deliberately exposes no topology.

## Status & synthetics

Stand up external uptime monitoring so an outage pages you, not a user. Either
provider below works on its free tier; the minimal real config:

**Endpoints to monitor**

| Name | URL | Check | Notes |
|---|---|---|---|
| Relay health | `https://relay.zintus.ai/health` | HTTP 200 **and** body contains `"ok":true` | Cloudflare Worker; keyless. Primary alert. |
| Web home | `https://zintus.ai` | HTTP 200 | Vercel; auto-deploys on `main`. |
| Gateway health (optional) | `http://<your-gateway-host>:8788/health` | HTTP 200, body `"ok":true` | Only if you run a network-exposed gateway. `/health` is keyless; do **not** point a public monitor at `/v1/status` (auth-gated, would always 401). |

**Better Stack (Uptime)** — Monitors → *Create monitor* → paste the URL. For the
relay, set monitor type to *keyword* / "Check that the page contains" and enter
`"ok":true` so a 200 with a wrong body still alerts. Disable caching on the
check; default check interval 3 min (free) is fine for `/health`. (See
[Better Stack: Uptime monitor](https://betterstack.com/docs/uptime/uptime-monitor/)
and [Get started with monitoring](https://betterstack.com/docs/uptime/monitoring-start/).)

**UptimeRobot** — *Add New Monitor* → type **Keyword**, GET, URL =
`https://relay.zintus.ai/health`, keyword = `"ok":true`, "alert when keyword
**not** exists". Interval 5 min (free). (See
[UptimeRobot API/keyword monitoring](https://help.uptimerobot.com/en/articles/13628553-uptimerobot-api-monitoring).)

**Owner action list**
- [ ] **[HUMAN]** Create the provider account; add the 2–3 monitors above.
- [ ] **[HUMAN]** Add an alert contact (email/SMS/Slack) and an on-call escalation.
- [ ] **[HUMAN]** Publish a status page (both providers offer a hosted one) if you want a public uptime URL.
- [ ] Keep monitors pointed at `/health` only — never the auth-gated endpoints.

## Backups & disaster recovery

The relay's D1 + KV are backed up **daily** (04:17 UTC) by
[`.github/workflows/backup-relay.yml`](../.github/workflows/backup-relay.yml),
which also **restore-drills** each fresh dump and uploads a 90-day artifact.
Full restore (dump or D1 Time Travel), KV bulk-restore, and relay rollback
procedures live in [`DR-RUNBOOK.md`](./DR-RUNBOOK.md).

- [ ] **[HUMAN]** Add repo secrets `CLOUDFLARE_API_TOKEN` (scoped `D1:Read` +
      `Workers KV Storage:Read`) and `CLOUDFLARE_ACCOUNT_ID` so the backup job
      runs (it no-ops with a warning until then).
- [ ] **[HUMAN]** Run `scripts/relay-restore-drill.sh` monthly and after any
      schema migration — an unrehearsed backup is not a backup.

## Per-release-workflow preflight

Each artifact has its own tag-triggered workflow. Confirm the secrets/vars exist
in **repo Settings → Secrets and variables → Actions** before pushing the tag.
Tags and secret names below are read straight from the workflow files.

### `release-gateway.yml` — GHCR image (`.github/workflows/release-gateway.yml`)
- **Trigger:** push tag matching `v*` (`on.push.tags: ["v*"]`, line 9–10), e.g. `git tag v0.1.0 && git push origin v0.1.0`.
- **Secrets:** none to add — uses the auto-provided `GITHUB_TOKEN` (line 31) with `permissions: packages: write` (line 17).
- **[HUMAN] one-time:** the GHCR package `ghcr.io/<owner>/zintus-gateway` must allow the repo to publish (Actions has `packages: write`; for an org, confirm package creation/visibility is permitted). Image name derives from `github.repository_owner` (line 37).
- **Gate:** builds + boots the image and probes `/health` before pushing (line 56) — a crash-on-boot tag will not publish.

### `release-cli.yml` — npm publish (`.github/workflows/release-cli.yml`)
- **Trigger:** push tag matching `cli-v*` (line 16–17), e.g. `git tag cli-v0.0.1 && git push origin cli-v0.0.1`. `workflow_dispatch` (line 19) runs the build/pack/scan gates but **never publishes** (publish step is `if: github.event_name == 'push'`, line 94).
- **Secrets:** `NPM_TOKEN` (line 97) — an npm automation token with publish rights to `zintus`. `id-token: write` (line 23) is set for provenance (OIDC, no secret needed).
- **[HUMAN]:** create/rotate the npm automation token; ensure the npm account can publish the public `zintus` package.

### `release-mobile.yml` — EAS build (`.github/workflows/release-mobile.yml`)
- **Trigger:** push tag matching `mobile-v*` (line 5–6) or `workflow_dispatch` (line 7).
- **Secrets/vars:** `secrets.EXPO_TOKEN` (line 20) — Expo access token; `vars.EXPO_PUBLIC_VALIDATE_URL` (line 24) — repo **variable**, not a secret.
- **[HUMAN]:** EAS build credentials (iOS distribution cert/provisioning, Android keystore) live on Expo's servers / `eas.json`, not in this repo — set them up in the Expo project before tagging. The workflow runs `eas build --platform all --profile production` (line 22).

### `release-desktop.yml` — Tauri bundles (`.github/workflows/release-desktop.yml`)
- **Trigger:** push tag matching `desktop-v*` (line 5–6). Matrix builds macOS/Windows/Linux (line 12–19).
- **Secrets:** `TAURI_SIGNING_PRIVATE_KEY` (line 36) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (line 37) — the Tauri updater signing keypair.
- **[HUMAN]:** generate the Tauri signing key (`tauri signer generate`) and add both secrets before tagging. Artifacts are uploaded per-target (line 38–43); this workflow does **not** auto-create a GitHub Release.
