# Security model & threat assumptions

This document states what Zintus does and does not protect against. Read it
before deploying anything beyond your own machine.

## Components and trust boundaries

| Component | Holds secrets? | Network exposure | Auth |
|-----------|----------------|------------------|------|
| CLI | OS keychain (`@napi-rs/keyring`) | none | OS user |
| Desktop (Tauri) | OS keychain via Tauri | local webview | OS user |
| Mobile (Expo) | `expo-secure-store` (Keychain/Keystore) | device | OS/biometric |
| Web | browser `localStorage`, AES-256-GCM + PBKDF2(600k) | browser | passphrase |
| Gateway (Bun) | reads keys from the host keychain at runtime | configurable | bearer token |
| validate-key worker | none (validates a key passed in the request) | public edge | rate limit |
| Cloud relay worker | BYOK: opaque ciphertext (cannot read). Managed (Pro): AES-256-GCM, **operator-decryptable** | public edge | JWT + KV rate limit |

## API key storage

- **CLI / Desktop / Mobile** use the OS-provided secure store. This is the
  recommended path. Keys never touch disk in plaintext.
- **Web** encrypts keys with AES-256-GCM using a key derived from a user
  passphrase via PBKDF2-HMAC-SHA256 at 600,000 iterations, then stores the
  ciphertext in `localStorage`.
  - **Threat:** `localStorage` is readable by any JavaScript running on the
    origin. A successful XSS against the web app can exfiltrate the ciphertext
    and, if the passphrase is weak or captured, the keys. Treat the web vault as
    convenience-grade, not as protection against a compromised page. Prefer the
    desktop/CLI for high-value keys.

## Gateway

- Binds to `127.0.0.1` by default. It **refuses to start** bound to a public
  interface (`0.0.0.0`/`::`) unless `GATEWAY_TOKEN` is set.
- When `GATEWAY_TOKEN` is set, every endpoint except `/health` requires
  `Authorization: Bearer <token>` (compared in constant time).
- `/health` is intentionally minimal — `{ ok, auth }` only. It does **not**
  expose provider inventory, key presence, live quota, or savings to
  unauthenticated callers. That operational snapshot lives at the auth-gated
  `GET /v1/status`.
- CORS defaults to `*`; restrict it with `GATEWAY_CORS_ORIGIN` for browser
  deployments.
- Optional per-client rate limiting on `/v1/chat/completions` and `/v1/research`
  via `GATEWAY_RATELIMIT_RPM` (requests/min). Off by default; set it when the
  gateway is network-exposed so a stolen token cannot burn provider quota
  unthrottled. Keyed by the bearer token by default (unspoofable);
  `X-Forwarded-For` is honoured only when `GATEWAY_TRUST_PROXY=1` (i.e. behind a
  reverse proxy that overwrites that header) — otherwise a client could forge a
  fresh IP per request to evade an IP-keyed limit.
- On `SIGTERM`/`SIGINT` the gateway drains in-flight streams, reports `/health`
  as `503 draining`, closes the cloud relay connection, and clears background
  timers before exiting (bounded by `GATEWAY_DRAIN_TIMEOUT_MS`, default 10s).
- Provider HTTP calls are cancellable: a client disconnect or the request
  timeout aborts the upstream fetch, releasing the in-flight quota reservation
  instead of leaking the connection.
- The gateway can spend any provider quota/credits associated with the keys in
  the host keychain. Anyone who can reach it and present the token can use those
  keys. Scope the token and network accordingly.

## Log & error redaction

- Strings bound for logs, traces, and error sinks (including `SENTRY_DSN`) are
  passed through `redactSecrets` (`packages/router/src/redact.ts`), wired into
  the gateway's logging/error path (`apps/gateway/src/index.ts`). It scrubs every
  provider key format with a recognizable prefix (OpenAI/DeepSeek/OpenRouter
  `sk-`, Gemini `AIza`, Groq `gsk_`, Cerebras `csk-`, xAI `xai-`, HuggingFace
  `hf_`) plus Stripe secrets (`sk_live_`/`rk_live_`/`whsec_`), replacing the body
  with `****REDACTED****`.
- **Best-effort, not a guarantee.** It is pattern-based: keys with no
  distinctive prefix (e.g. Cohere/Mistral/Fireworks bare-format keys) can't be
  matched without unacceptable false positives. The redactor reduces accidental
  leakage of *recognizable* secrets into logs; callers must still avoid logging
  raw key material directly.

## Cloud relay (Pro tier)

- **BYOK is zero-knowledge.** Clients encrypt key material to the home gateway's
  public key; the relay forwards the opaque ciphertext and never holds the
  plaintext or the key that decrypts it (`GatewaySession.ts`).
- **Managed keys are not currently available.** A managed-key Pro tier — where
  the relay would hold and decrypt provider keys to call providers on the user's
  behalf — is planned but **not implemented**. The server-side key-custody
  scaffold (AES-256-GCM, key derived from `KEY_ENCRYPTION_SECRET` via
  HKDF-SHA256, decrypted inside the relay worker) was **removed** because it was
  never wired into any route and shipped an operator-decryptable path that
  contradicts the BYOK-first trust model. The paid tiers that advertise managed
  keys are gated "Coming soon" and checkout for them is disabled
  (`MANAGED_KEYS_AVAILABLE` in the relay's `tiers.ts`).
  - **If reintroduced**, managed keys would **not** be zero-knowledge: the relay
    would hold both the ciphertext and the secret that decrypts it, so anyone
    with worker-env access (the platform, a compromised deploy, or an insider)
    could read them. BYOK remains the recommendation for high-value keys.

## validate-key worker

- Rate limited to 10 req/min per client IP via the Cloudflare native rate
  limiting binding (`RATE_LIMITER` in `wrangler.toml`), enforced across edge
  isolates. The in-process fallback limiter is for `wrangler dev` only.
- The worker validates a key supplied in the request body against the provider
  API. It does not store keys.

## Out of scope (known, accepted)

- Quota tracking is **per-device/per-process**. There is no shared global quota
  ledger, so multiple clients using the same provider account can collectively
  exceed a free-tier limit and be throttled by the provider.
- No multi-tenant authorization, audit logging, or per-key access control.
- The gateway trusts its local keychain; it is not a hardened multi-user server.

## Reporting

Open a private security advisory rather than a public issue for anything that
could expose keys or quota.
