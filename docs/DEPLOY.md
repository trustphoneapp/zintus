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
