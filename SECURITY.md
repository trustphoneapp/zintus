# Security model & threat assumptions

This document states what MultipleAI does and does not protect against. Read it
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
- CORS defaults to `*`; restrict it with `GATEWAY_CORS_ORIGIN` for browser
  deployments.
- The gateway can spend any provider quota/credits associated with the keys in
  the host keychain. Anyone who can reach it and present the token can use those
  keys. Scope the token and network accordingly.

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
