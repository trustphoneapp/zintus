# Zintus — Production Architecture & Hardening Plan

> Synthesized from a 4-agent deep audit of the live codebase (gateway reliability,
> security/CI, Tokzen compression, structural health). Every claim below is grounded
> in `file:line` evidence verified against the working tree, not the original audit prose.

---

## 0. Audit recalibration (what the prose got wrong)

Two findings from the original 64/100 audit do **not** survive contact with the code.
They are corrected here so the remediation budget isn't spent on phantoms.

| Original claim | Reality | Source |
|---|---|---|
| **CRIT #1** "12 Tokzen tests fail / 77; compression silently broken on hot path" | **77/77 pass, 0 fail.** `compress()` runs at `handler.ts:241` with **real** `quotaRemaining` wired from `engine.getQuotaRemaining` (`index.ts:78`). Compression is correct. The *only* real gap is that tokzen's 77 tests aren't in the root `test` script. The phantom "12 fail" was almost certainly a stale/absent `dist/` (tokzen resolves to gitignored `./dist`). | tokzen agent ran the suite |
| **HIGH #10** "onError hook exists but is unused" | `onError` **is** invoked at every catch (`handler.ts:370,509,710,722`). The defect is at the *construction site*: `index.ts:72` builds the handler **without** passing `onError`, so the sink is a no-op. Fix = one line, not a hook rewrite. | architecture agent |

Everything else in the audit is **confirmed** with evidence. Net: the system is closer to
production than 64/100 implies on *correctness*, but the **reliability and security blind spots are real**.

---

## 1. Current architecture (as-built)

```
                         ┌─────────────────────────── Zintus Cloud (optional) ───────────────────────────┐
                         │  workers/relay (Cloudflare)                                                    │
                         │   • magic-link auth, JWT          • KV rate limits (3/hr, 60/min, 30/min)      │
   mobile / web ─────────┤   • BYOK: forwards OPAQUE ciphertext (zero-knowledge) ✔                         │
   dashboard             │   • Managed keys: AES-GCM decrypted SERVER-SIDE ✗ (not ZK)                      │
                         │   • billing / referral / tiers  ── ⚠ untested, not in CI                        │
                         └──────────────────────────────────────────┬─────────────────────────────────────┘
                                                                     │ WSS control channel
                                                                     │ (CloudConnection — .close() never called)
  OpenAI-compatible                                                  ▼
  clients  ─────────►  apps/gateway  (Bun.serve, single process, home machine)
                          handler.ts (769 LOC, god-object)
                            auth(bearer) → [NO rate limit] → [manual JSON parse] → search → compress(tokzen) → route
                                                                                                       │
                                                          ┌────────────────────────────────────────────┘
                                                          ▼
                          packages/engine  ──►  packages/router/factory.ts (670 LOC)
                            • inflight quota reservation ✔   • cooldown + failover ✔   • [NO circuit breaker]
                                                          │
                                                          ▼
                          packages/providers  (openai-compat / gemini / ollama / groq / cerebras)
                            fetch(url, { signal: options.signal })   ◄── options.signal is ALWAYS undefined ✗
                                                          │
                          packages/memory (sqlite, NO indexes on thread_id ✗) · cache · keychain (OS) · context-compiler
```

Dependency spine is clean: `types` → `providers`/`keychain` → `router` → `engine` → `gateway`.
`tokzen` and `crypto-e2e` are standalone leaves. This is a **good** foundation — the problems are
cross-cutting concerns that were never given a home, not a tangled graph.

---

## 2. Root-cause theme

Every confirmed defect is one missing cross-cutting layer. The codebase has excellent *vertical*
features (E2E crypto, inflight reservations, failover) but four *horizontal* concerns have no owner:

1. **Request lifecycle / cancellation** — no `AbortSignal` is ever constructed, so nothing can time
   out, no client disconnect propagates, no shutdown can drain.
2. **Edge validation** — no schema layer; both the gateway and the *public* relay hand-parse JSON.
3. **Abuse & failure control** — no rate limiter on the gateway, no circuit breaker in the router.
4. **Operability** — error sink unwired, `/health` over-shares, CI has blind spots (tokzen, relay,
   secret-scan, audit).

The target architecture introduces exactly these four layers and nothing speculative.

---

## 3. Target architecture

```
  clients ─►  apps/gateway
              ┌───────────────────────────── middleware pipeline (NEW) ─────────────────────────────┐
              │  1. auth (bearer, timing-safe)        [existing]                                     │
              │  2. rate-limit (rate-limit.ts)        in-proc token-bucket, keyed by IP→token-hash   │ ← NEW
              │  3. validate (@zintus/schemas, zod)   safeParse → 400 {issues}                        │ ← NEW
              │  4. dispatch → routes/                 chat-completions.ts · research.ts              │ ← split
              └────────────────────────────────────────┬────────────────────────────────────────────┘
                                                        ▼
              per-request AbortController = any([ request.signal,                  ← client disconnect
                                                  AbortSignal.timeout(connectMs),  ← connect deadline
                                                  idleWatchdog ])                  ← reset per SSE chunk   ← NEW
                                                        │ signal threaded: route.ts → factory.ts:473 → provider fetch
                                                        ▼
              packages/router/factory.ts
                 selection.ts (NEW split)  + circuit-breaker state {closed|open|half_open}  ← NEW
                 closed─►trip on failure-rate─►OPEN─►cooldown(exp)─►HALF_OPEN─►1 trial─►closed/open
                                                        ▼
              packages/providers   fetch(url, { signal })   ← now always populated ✔

  lifecycle:  SIGTERM/SIGINT ─► draining=true (/health=503) ─► cloud.close() ─► server.stop(drain) ─► clearTimers ─► exit  ← NEW
  observ.:    onError ─► createErrorSink(env) ─► Sentry/OTEL   (wired at index.ts:72)                                     ← NEW
  security:   /health = {ok} public  ·  /v1/status = full topology behind auth                                           ← split
  CI:         + tokzen tests + relay tests + relay typecheck + bun audit + gitleaks                                       ← NEW
```

### 3.1 New / changed components

| Component | Location | Responsibility |
|---|---|---|
| `@zintus/schemas` | `packages/schemas` (new) | zod schemas + inferred types for chat/research/relay payloads. Keeps `@zintus/types` runtime-free; relay (edge) imports the same schemas. |
| `rate-limit.ts` | `apps/gateway/src` (new) | In-process sliding-window/token-bucket. `createRateLimiter({limit,windowMs}).check(key)`. Key: peer IP → fallback bearer-hash → virtual_key (cloud). Config `GATEWAY_RATELIMIT_RPM` (default safe e.g. 120). Exempts `/health`,`/metrics`. |
| Abort plumbing | `types/route.ts`, `router/factory.ts:473`, `handler.ts` SSE loop | Add `signal?: AbortSignal` to `RouteRequest`/`EngineRouteRequest`; build per-request controller from `AbortSignal.any([...])`; `ReadableStream.cancel()` → `controller.abort()`; idle watchdog resets per chunk. Providers already forward `signal`. |
| Circuit breaker | `router` (ledger/quota-core + `factory.ts:195-212,545,616-660`) | Per-provider `{closed/open/half_open}` + rolling failure window. Reuses existing `computeCooldownMs` for OPEN duration and the **inflight reservation** as the natural HALF_OPEN single-probe gate. Policy `fail`/`next_provider` semantics unchanged — breaker governs *availability*, policy governs *routing*. |
| Graceful shutdown | `gateway/index.ts`, `cli/serve.ts:97` | `startGateway` returns `{ shutdown() }` capturing `probeTimer`, policy-watcher, `server`. Signal handler: draining flag → `cloud.close()` (capture the discarded return at serve.ts:97) → `await server.stop(drain, 10s)` → `clearInterval(probeTimer)` → exit. Track active-SSE counter to drain on real in-flight count. |
| `observability.ts` | `apps/gateway/src` (new) | `createErrorSink(env)`: `SENTRY_DSN`→`@sentry/node`; `OTEL_*`→OTLP span exception; unset→`undefined` (zero overhead). Wire `onError: createErrorSink(process.env)` at `index.ts:72`. |
| `/health` split | `handler.ts:555-578` | Public `/health` → `{ ok, auth: token?"required":"disabled" }`. Move `providers[]`+`savings` to auth-gated `/v1/status` (after `isAuthorized` at :580). Smoke test (`ci.yml:118`) still passes (checks 200/ok). |
| memory-store indexes | `memory/memory-store.ts:99-144` | Four `CREATE INDEX IF NOT EXISTS` on `thread_id` (+ `thread_id,key` composite). thread_id is the WHERE column on every read path (150,190,262,274,304,359,425). |
| CI security/coverage | `.github/workflows/ci.yml`, root `package.json`, `tsconfig.build.json` | Add tokzen + relay tests to `test` script; add `workers/relay` to typecheck matrix & composite build; new parallel `security` job: `bun audit --audit-level=high` + gitleaks. |

---

## 4. Phased remediation roadmap

Ordered by **risk-reduction per hour**, not by audit number. Phase 0 is the "stop the bleeding" set.

### Phase 0 — CI trust + cheap high-value fixes  (~1 day)
*Goal: make the test suite tell the truth, plug the two cheapest real holes.*
- [ ] Add `bun test packages/tokzen/tests/` + `workers/relay/tests/*` to root `test` script; prefix `--filter tokzen build`. *(audit #1,#3 — 15 min)*
- [ ] Add `workers/relay` to CI typecheck matrix + `tsconfig.build.json`. *(#3 — 15 min)*
- [ ] New `security` CI job: `bun audit --audit-level=high` (start `continue-on-error`, flip to gating after remediating undici/wrangler highs) + gitleaks. *(#7 — 0.5 day)*
- [ ] Add 4 `CREATE INDEX` statements to memory-store `init()`. *(#18 — pure upside, 30 min)*
- [ ] Split `/health` → public `{ok}` + auth-gated `/v1/status`. *(#8 — 0.5 day)*
- [ ] Wire `onError: createErrorSink(process.env)` + ~20-line `observability.ts`. *(#10 — 0.5 day)*

### Phase 1 — Request lifecycle (the highest-severity reliability work)  (~3 days)
*Goal: a hung or abandoned upstream can no longer wedge the process.*
- [ ] Thread `signal` through `RouteRequest`→`factory.ts:473`→providers.
- [ ] Per-request `AbortController` = `any([request.signal, AbortSignal.timeout(connectMs), idleWatchdog])`; `ReadableStream.cancel()`→abort; idle watchdog in SSE loop. *(#5 — the #1 reliability risk)*
- [ ] Graceful shutdown: capture `CloudConnection` at `serve.ts:97`, return `shutdown()` from `startGateway`, SIGTERM/SIGINT drain sequence, clear `probeTimer`. *(#6)*

### Phase 2 — Abuse & failure control  (~3-4 days)
- [ ] `@zintus/schemas` zod package; convert `handler.ts` body type + the **6 raw `JSON.parse...as`** casts in the public `relay/src/index.ts` (security-relevant). *(#21,#15)*
- [ ] Gateway rate limiter (`rate-limit.ts`), wired after auth, 429 + `Retry-After`, `metrics.recordRateLimited()`. *(#4)*
- [ ] Router circuit breaker (open/half-open) on top of existing cooldown. *(#9)*

### Phase 3 — Hardening, coverage, maintainability  (~1-2 weeks)
- [ ] Relay managed-key decision: **(a)** document now that managed keys are operator-decryptable / not ZK (`SECURITY.md`); **(b)** replace `crypto.ts:5` `slice(0,32).padEnd` with a real HKDF/PBKDF2 + per-user derived keys + Cloudflare Secrets Store; **(c)** track client-side-wrapped managed keys as the ZK target. *(#12)*
- [ ] Remediate `bun audit` highs (`bun update` undici/wrangler/xmldom chain), then flip audit job to gating. *(#7)*
- [ ] P0 tests: relay `crypto.ts`/`managed-keys.ts`/`billing.ts`, `keychain/storage.ts`, `memory-store.ts` CRUD. *(#17)*
- [ ] Extract `handler.ts` (769→thin router + `routes/` + `http-helpers.ts`); split `memory-store.ts`, `cache.ts`, `factory.ts/selection.ts`. *(#16)*
- [ ] Root `.env.example`, `CHANGELOG.md`, OpenAPI spec for `/v1/*`, rollback runbook. *(#19,#20)*

---

## 5. Definition of done (production-ready gate)

| Dimension | Exit criterion |
|---|---|
| **Tests truthful** | tokzen + relay suites run in CI; coverage measured on crypto/keychain/memory-store. |
| **No unbounded waits** | Every provider `fetch` has connect + idle timeouts; client disconnect aborts upstream. |
| **Safe deploys** | SIGTERM drains in-flight streams, closes cloud WS, clears timers; `/health` 503 while draining. |
| **Abuse-resistant** | Per-key/IP rate limit on chat/research; circuit breaker sheds load to down providers. |
| **No silent failures** | `onError`→Sentry/OTEL wired; errors aggregated + alertable. |
| **Least disclosure** | `/health` minimal; provider topology auth-gated; managed-key trust model documented. |
| **CI gates security** | `bun audit` (high+) + secret scan block merge; relay typechecked. |

---

---

## 6. Implementation status (2026-06-24, branch `feat/prod-hardening`)

All phases below are **implemented and green** (full `bun run typecheck` + `bun
run test` pass; relay typechecks). ~1,250 lines across 29 files.

| Item | Status |
|---|---|
| memory-store `thread_id` indexes | ✅ done |
| `/health` split → `/v1/status` (auth-gated) | ✅ done |
| `onError → Sentry` sink wired (`observability.ts`, opt-in) | ✅ done |
| CI: tokzen + relay tests, relay typecheck, `bun audit` + gitleaks jobs | ✅ done |
| AbortSignal plumbing (timeout + client-disconnect abort) | ✅ done |
| Graceful shutdown (drain, cloud `.close()`, timers, `503` draining) | ✅ done |
| Gateway rate limiter (`GATEWAY_RATELIMIT_RPM`, 429 + Retry-After) | ✅ done |
| `@zintus/schemas` (zod) — gateway chat **+ research** + relay magic-link | ✅ done |
| Circuit-breaker half-open probe gate | ✅ done |
| Relay managed-key HKDF-SHA256 (+ legacy decrypt fallback) | ✅ done |
| `SECURITY.md` managed-key trust model + `/health` + rate-limit docs | ✅ done |
| Root `.env.example`, `CHANGELOG.md` | ✅ done |
| New tests (rate limiter, /v1/status, draining, 429, zod ×2, relay crypto) | ✅ done |

### 6.1 Post-review fixes (a self-review caught two regressions I'd missed)

| Finding | Fix |
|---|---|
| **`/health` split broke web/desktop/mobile UIs** — clients fetched `/health` for `providers[]` (passed `typecheck` only because of an `as` cast) | All three clients + the cloud relay `getStatus` now fetch the authed `/v1/status`; `/health` kept for liveness. The regression is closed. |
| **tokzen CCR not hermetic** — wrote to `~/.tokzen/ccr.db`, failing on a read-only `$HOME` | Added `TOKZEN_HOME` override; CI sets it, and the root `test` script defaults it to workspace-local `.tokzen-test/` so local runs match CI on any machine. Locked in by `ccr-home.test.ts`. |
| **Desktop soft-failed `/v1/status` 401** as "online, empty providers" | Now returns `null` (not-ready) on a non-OK status, matching web/mobile, so a token mismatch doesn't render a misleading empty dashboard. |
| Research endpoint un-validated / no abort signal (#3, #8) | `ResearchRequestSchema` (zod) + client-disconnect `AbortSignal` wired into `handleResearch`. |
| Rate limiter trusted spoofable `X-Forwarded-For` (#10) | Default keys by the unspoofable bearer token; XFF used only under `GATEWAY_TRUST_PROXY`. |
| `workers/relay` not in composite build (#6) | Added to `tsconfig.build.json` references (verified `tsc -b` passes). |
| Sentry sink dropped errors during async init (#5) | Bounded buffer flushed on init. |
| `ControlPayloadSchema` defined but unused (#12) | Removed (relay already validates control payloads). |

**Deliberately deferred** (with rationale):
- *Audit highs remediation* (`undici` via `wrangler`): the audit job is
  non-gating until `bun update` clears them; transitive dev-tooling only.
- *Full handler.ts module split* (#16): mechanical refactor, no behaviour
  change — lower priority than the correctness/security work above.
- *Half-open concurrency unit test*: a timing-based test would be flaky and the
  audit credits "no flaky tests"; the gate's release path reuses the
  already-tested in-flight reservation lifecycle.
- *Per-chunk SSE idle watchdog* (#7): a hung mid-stream upstream is bounded by
  Bun's `idleTimeout` (default 10s) → connection close → `ReadableStream.cancel`
  → `upstreamAbort.abort()`. An explicit app-level watchdog would duplicate that
  timer; documented rather than added.
- *Wider relay zod coverage / OTLP error exporter*: magic-link + `SENTRY_DSN`
  paths shipped; remaining relay endpoints and OTLP are follow-ups.

---

*Generated 2026-06-24 from parallel-agent audit. Line references valid as of commit `922d383`; implementation on branch `feat/prod-hardening`.*
