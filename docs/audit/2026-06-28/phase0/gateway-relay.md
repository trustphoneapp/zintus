# Phase 0 From-Disk Audit — Gateway + Relay

**Scope:** `apps/gateway` (the local-first router) and `workers/relay` (the no-custody
coordination Worker). Branch `feat/zintus-10-10`. Read from source, not docs.
Legend: ✅ real (code + path) · 🟡 partial/data-exists-no-surface · ❌ absent · 🔒 intentionally
gated/out-of-scope (by no-custody / free-core rules).

Key files read: `apps/gateway/src/handler.ts`, `apps/gateway/src/index.ts`,
`apps/gateway/src/crypto.ts`, `workers/relay/src/index.ts`, `workers/relay/src/tiers.ts`,
`workers/relay/src/billing.ts`, `workers/relay/src/GatewaySession.ts`,
`packages/providers/src/{factory,capabilities,pricing}.ts`.

---

## Capability matrix — Gateway vs Relay

| Row | Gateway | Relay |
|---|---|---|
| chat | ✅ `/v1/chat/completions` stream + JSON `handler.ts:639,1745` | 🔒 no inference by design — proxies mobile↔home-gateway over WS `index.ts:821,866` |
| markdown | n/a (API returns text; client renders) | n/a |
| image input | ✅ vision routing + hard-error when no vision provider `handler.ts:687-705,933-938` | 🔒 forwarded only; not image-aware |
| file input | ❌ only images; no document/PDF blocks `handler.ts:726` | ❌ n/a |
| voice | n/a | n/a |
| tool calling | ✅ OpenAI tool_calls stream/JSON + 422 gate `handler.ts:700,1016,1177` | n/a (forwarded) |
| structured output | ✅ `response_format` json_schema/json_object, 422 honesty `handler.ts:716-725,1037,1100` | n/a |
| deep research | ✅ `/v1/research` SSE (needs Tavily/Serper key) `handler.ts:1321,1351` | n/a |
| compare | ❌ no compare endpoint | n/a |
| projects | ❌ threads exist (memory) but no "projects" `handler.ts:1668` | ❌ |
| provider keys | ✅ inline `body.keys` + encrypted key-push `handler.ts:879`; `crypto.ts:83` | ✅ forwards `set_key`/`remove_key` verbatim, never decrypts `GatewaySession.ts:341`, `index.ts:854` |
| BYOK vault | ✅ local x25519 vault, OS-keychain persisted, decrypts only on user's own box `crypto.ts:2-85` | ✅/🔒 never holds keys (no-custody passthrough) `GatewaySession.ts:341` |
| local runtime | ✅ Ollama/LM-Studio probe `local-runtimes.ts`, `handler.ts:539` | n/a |
| routing strategies | ✅ `strategy`/`provider_weights`/`mode` → engine `handler.ts:867-877`; policy hot-reload `index.ts:129` | n/a |
| route reason | 🟡 chat metadata exposes provider/model/`routing_strategy` only `handler.ts:85`; full reason only on `/v1/route/options` `handler.ts:602-624` | n/a |
| quota display | ✅ `/v1/status` quotaUsed/Limit `handler.ts:1607`; `/v1/route/options` quotaRemaining `handler.ts:626` | ✅ `/api/usage/current`, `/api/billing/status` tokens_used/limit/percent `index.ts:1049,1007` |
| compression savings | ✅ Tokzen `X-Zintus-*` headers + metadata `handler.ts:947-970,81` | ❌ |
| usage/activity | 🟡 `/v1/traces`, `/v1/traces/last`, `/v1/savings` (per-request) — **no aggregate `/v1/activity`** `handler.ts:1638,1643` | ✅ `/api/usage/history` 30-day per-day tokens `index.ts:1069` |
| model catalog | ❌ `/v1/models` is a **provider stub** (see below) `handler.ts:1627-1636` | ❌ n/a |
| pricing catalog | 🟡 `PRICING_CATALOG`/`listPricing()` exist + used internally; **no endpoint** `pricing.ts:55,210`; `handler.ts:558` | ❌ n/a |
| API docs | 🟡 `docs/openapi.yaml` + `openapi-spec.test.ts` exist; gateway serves no `/openapi` route | ❌ no spec |
| OpenAI-compatible API | ✅ `/v1/chat/completions` OpenAI shape (object/choices/tool_calls/[DONE]) `handler.ts:1057,1160` | ❌ Hono control plane, not OpenAI-shaped |
| account/auth | 🟡 single bearer `GATEWAY_TOKEN`, no user accounts `auth.ts`, `handler.ts:1589` | ✅ magic-link + Google OAuth (RS256/JWKS) + CLI + mobile OTP + sessions + account-delete `index.ts:347-754`, `google-auth.ts` |
| security | ✅ CORS allowlist + origin-reject, body caps, rate-limit, redactSecrets, PNA preflight `handler.ts:382,1534`; `index.ts:176` | ✅ CORS, security headers, redirect-validation, timing-safe Stripe HMAC, rate limits, deleted-user tombstone `index.ts:182-198`; `billing.ts:125`; `http-security.ts` |
| observability | ✅ Prometheus `/metrics`, structured redacted logs, Sentry sink, traces `metrics.ts`, `observability.ts`, `index.ts:111` | 🟡 redacted error log + optional Sentry sink; **no metrics endpoint** `index.ts:86-105`, `observability.ts` |
| billing / paid overflow | 🔒 none — BYOK-only; `/v1/route/options` deliberately offers **no** `use_credits`/overflow `handler.ts:587-596` | 🟡 full Stripe checkout/portal/webhook + tiers + quota enforce **built but 503-gated** `billing.ts`, `tiers.ts:54`, `index.ts:990` |
| referral / node marketplace | 🔒 n/a | 🟡 referral tracking LIVE (codes, webhook commission, stats) but **no payout**; node/compute marketplace ❌ `index.ts:1106-1165`, `billing.ts:247` |

---

## Critical OpenRouter-benchmark checks

### (1) What does `GET /v1/models` actually return?
**Provider-default stub, NOT rich per-model metadata.** `handler.ts:1627-1636`:

```
data: listProviders().map(p => ({ id: p.id, object: "model", owned_by: p.name }))
```

`listProviders()` (`factory.ts:40`) returns **one object per provider** (~12 entries). So the
`id` is a *provider id* (`"gemini"`, `"groq"`, …) — not a model id — and each entry carries
**only** `id`/`object`/`owned_by`. There is **no** price, context length, vision, tools,
json, privacy, local, or quota field. The rich data already exists model-keyed in the codebase
(`MODEL_CAPABILITIES` `capabilities.ts:64`; `PRICING_CATALOG`/`listPricing()` `pricing.ts:55,210`;
`supportsVision`/`supportsTools`/`structuredOutputLevel`) and is used *internally* by
`/v1/route/options` and the chat capability gates — but is **never surfaced through `/v1/models`**.
This is the single biggest gap vs OpenRouter's `/api/v1/models`.

### (2) `/v1/activity` (usage history) or `/v1/key` (key/quota introspection)?
**Neither exists by those names on the gateway** (grep for `/v1/activity` / `/v1/key` → 0 hits).
Closest gateway analogues: `/v1/traces*` (per-request traces), `/v1/savings`, and `/v1/status`
(auth-gated provider inventory + live quota + savings) `handler.ts:1597-1666`.
The **relay** does ship the data behind cookie auth: `/api/usage/history` (30-day per-day
tokens, `index.ts:1069`), `/api/usage/current` (`index.ts:1049`), and `/api/billing/status`
(tier/limit/quota, the de-facto "key info", `index.ts:1007`) — but none are OpenAI-compatible
`/v1/key`/`/v1/activity` endpoints. Phase 5 work is genuinely absent, not just unnamed.

### (3) NO-custody confirmation
- **Relay holds/decrypts nothing.** grep of `workers/relay/src` for
  `decrypt|x25519|payout|nacl|seal|private_key` finds only comments asserting the relay
  **never** decrypts (`GatewaySession.ts:55,341`, `tiers.ts:2`). `handleControl` validates
  shape then forwards `encryptedKey` **verbatim** to the home gateway `GatewaySession.ts:341`.
- **Decryption is gateway-local only.** `apps/gateway/src/crypto.ts` holds an x25519 private
  key in the OS keychain and `decryptKeyPayload` runs on the **user's own** machine
  (`crypto.ts:2-85`) — the BYOK-vault model, i.e. operator never has custody.
- `MANAGED_KEYS_AVAILABLE = false` (`tiers.ts:8`) is the single re-enable toggle.
- **503-before-Stripe gate confirmed:** `checkoutAvailability()` returns
  `{status:503, code:'managed_keys_unavailable'}` for starter/growth/scale while the flag is
  off, *before* any Stripe call `tiers.ts:54-73`; enforced at `index.ts:990`. Also 503s on
  `price_FILL…` placeholders (`tiers.ts:26-35,65`).
- **Stripe webhook + tiers + referral all EXIST but gated:** full HMAC-verified, replay-windowed,
  idempotent webhook handling checkout/invoice/subscription events + referral commission rows
  (`billing.ts:176-365`), tier table (`tiers.ts:13`), referral routes (`index.ts:1106-1165`) —
  none purchasable because checkout is 503-gated.

### (4) False / overstated claims
1. **"Gateway `/v1/models` exists" implies a catalog.** It exists but is a 12-row provider
   stub with zero capability/price metadata — the roadmap's Phase-1 "rich `/v1/models`
   metadata (price, context, vision, tools, json, privacy, local, quota)" is **not** met.
   Any marketing of an OpenRouter-grade catalog API is overstated.
2. **`/v1/models` mislabels providers as models.** Entries are `object:"model"` but `id` is a
   *provider* id. A client passing `model:"gemini"` works via routing, but this is not a real
   model list and will mislead OpenAI-SDK users enumerating models.
3. **"Pricing catalog" is data, not an API.** `PRICING_CATALOG` is real and used internally,
   but there is no public pricing endpoint on either surface — don't claim a pricing API.
4. **Referral "earnings" are tracked but unpayable.** Commission rows are written
   (`billing.ts:247-263`) and `/api/referral/code` sums `commission_cents`
   (`index.ts:1113`), yet **no payout path exists** (no Stripe Connect / transfer; grep
   `payout` → 0). Earnings shown must stay labelled pending/coming-soon (commit `bbd7a85`
   already moves toward "honest referral earnings while gated") — surfacing them as real
   redeemable money would be overstated.
5. **"OpenAI-compatible" applies to the gateway only.** The relay is a Hono control plane and
   is not OpenAI-compatible; don't let a single "OpenAI-compatible API" claim imply the relay.

### (5) Brutal P0–P3 toward 10/10

**Gateway**
- **P0 — Rich `/v1/models`.** Rebuild the handler to enumerate **models** (not providers) from
  `MODEL_CAPABILITIES` + `PRICING_CATALOG`, emitting per-model `pricing`, `context_length`,
  `vision`, `tools`, `json/structured_level`, `local`, `privacy/data-policy`, and `quota`
  fields. Data already exists; this is plumbing + a contract test. (`handler.ts:1627`)
- **P0 — `/v1/key` (key/quota introspection).** OpenAI-style endpoint returning the caller's
  auth status + per-provider key presence + live quota/cooldown (reuse `engine.getProviderStatus`
  / `getQuotaRemaining`, already powering `/v1/status`).
- **P1 — `/v1/activity` (usage history).** Aggregate per-request traces/savings into a
  paginated history (today only `/v1/traces` raw list). Pairs with the relay's `usage_log`.
- **P1 — Serve `/openapi.json` + a `/v1/pricing` route.** `docs/openapi.yaml` exists but is not
  served; expose it + a pricing endpoint to hit the "developer API / pricing transparency" bar.
- **P2 — Surface a human route-reason on chat responses** (why this provider/model), not just
  `routing_strategy`; the reason string already exists in `/v1/route/options`.
- **P2 — File/document input** (currently images-only) and a **compare** endpoint.
- **P3 — Projects** abstraction over threads.

**Relay**
- **P0 (gated, no custody) — Turn on subscription paid WITHOUT custody.** The honest path:
  flip the paywall to gate **only premium coordination** (sync, activity history, aggressive
  Tokzen tiers, advanced routing) — NOT managed keys. That means **decoupling purchasability
  from `MANAGED_KEYS_AVAILABLE`**: today every paid tier is `managed_keys:true` (`tiers.ts:17-20`)
  so checkout is 503-blocked. Add BYOK-only paid tiers (managed_keys:false) whose value prop is
  coordination, set real `STRIPE_PRICES`, and let `checkoutAvailability` pass them. Webhook +
  quota enforcement are already built and idempotent.
- **P1 — Activity/key parity behind the gateway's new endpoints.** Expose `usage_log` history +
  tier/quota as the relay-side feed for a Pro dashboard (data done; needs a stable contract).
- **P1 — Relay observability.** Add a metrics endpoint / structured counters (only error logging
  exists, `index.ts:86`).
- **P2 — Referral payout or explicit "tracking-only" labeling.** Either build a payout path
  (Stripe Connect) or hard-label earnings as non-redeemable until built (keep honesty bar).
- **P3 — Node/compute marketplace** stays deferred (highest risk, per roadmap "later/gated").
