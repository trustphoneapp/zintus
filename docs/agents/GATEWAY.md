# GATEWAY Agent

**Owns:** `apps/gateway/src/`
**Risk:** HIGH — the main API server users run locally. Receives chat requests, routes, compresses (Tokzen), streams back.

## Source of truth
| Fact | Where |
|---|---|
| `/health` + `/v1/status` shapes | `apps/gateway/src/handler.ts` (`/health` block) |
| Timeout defaults | `apps/gateway/src/auth.ts` (`buildGatewayConfig`) + `handler.ts` (`DEFAULT_*`) |
| `onError` wiring | `apps/gateway/src/index.ts` (`createErrorSink` → passed to handler) |
| No-providers error | `packages/router/src/factory.ts` |
| Rate limit / auth / metrics / observability | `apps/gateway/src/{rate-limit,auth,metrics,observability}.ts` |

## Request flow
`HTTP → rate-limit (rate-limit.ts) → auth (auth.ts) → Zod validate (handler.ts) → engine.routeAndStream() (packages/engine) → router picks provider (packages/router) → SSE stream`

## Decisions you must NOT reverse

### `/health` vs `/v1/status` — DIFFERENT endpoints
`GET /health` (`handler.ts`): **public, no provider data.** Returns
`{ ok: <not-draining>, auth: "required" | "disabled" }` (+ `status: "draining"`
when draining); HTTP **200**, or **503** while draining. Note `auth` is a
**string enum**, not a boolean. Used by Docker HEALTHCHECK + uptime monitors.

`GET /v1/status`: **full provider topology + quota + savings.** Bearer-gated when
`GATEWAY_TOKEN` is set. Used by CLI + web dashboards.

**Do NOT put provider topology in `/health`** — leaking it was a real security
bug (closed by the `/health`→`/v1/status` split).

### Real gateway response shapes (NOT OpenAI's)
- Non-streaming chat: `{ id: <UUID trace id>, ... provider, thread_id }`. There is
  **no** `created` and **no** `usage` top-level field, and `id` is a UUID — not
  `chatcmpl-…`. (See `apps/gateway/src/contracts.test.ts` for the pinned shape.)
- Error body: `{ error: { message: string } }`. The bare-string routes
  (`/v1/traces/:id`, 404) return `{ error: "Not found" }` (a string, not an object).
- 400 = invalid JSON / Zod validation; 408 = request/start timeout; 413 = body too
  large / too many messages; 429 = the gateway **rate limiter** (`GATEWAY_RATELIMIT_RPM`).

### Exhaustion is NOT a 429 from the gateway
When no provider can serve, the router **throws**
`"No providers available. Configure API keys or start Ollama."` (`factory.ts:432`)
or `"All providers exhausted"` (`factory.ts:694`). For a **streaming** request
this surfaces as an SSE `data: {"error":{"message":…}}` frame, then `[DONE]`.
The gateway does **not** emit `429` / `Retry-After` for exhaustion — that belongs
to the **relay's managed-tier quota** only (`workers/relay/src/index.ts:688`,
429 + `Retry-After` + `X-Quota-*`). Keep these two paths distinct.
> The exact non-streaming HTTP status for the no-providers throw is not pinned by
> a test today — read the current `handler.ts` catch chain before asserting it.

### SSE streaming
Each chunk: `data: {…"object":"chat.completion.chunk"…}\n\n`; terminal:
`data: [DONE]\n\n`. No role-prime chunk, no `finish_reason` terminal chunk. (A
usage/transparency frame, when present, is wrapped as a `chat.completion.chunk`
so generic OpenAI clients stay happy.)

### Timeouts — REAL values (both default 60s, both env-configurable)
- `GATEWAY_REQUEST_TIMEOUT_MS` — connect/start (TTFB) timeout. **Default 60_000.**
- `GATEWAY_STREAM_IDLE_TIMEOUT_MS` — mid-stream idle watchdog (aborts upstream if
  no chunk arrives within the window). **Default 60_000.** Set `0` to disable.

All abort via a single `AbortController` threaded `RouteRequest → router →
provider fetch`. There is **no** separate "total 600s" or "provider 30s" timeout
in the gateway today — don't document numbers that don't exist.

### `onError` is wired
`apps/gateway/src/index.ts`: `const onError = createErrorSink(process.env, log)`
is passed to the handler. Remove it and errors get silently swallowed (the Sentry
sink is opt-in via `SENTRY_DSN`; `undefined` when unset).

## What already exists (do not rebuild)
Rate limiting (`rate-limit.ts`), auth (`auth.ts`), Prometheus metrics
(`metrics.ts`), Sentry sink (`observability.ts`), SSE idle watchdog (in
`handler.ts`) — all tested.

## When you're done
- [ ] `bun run test apps/gateway/src/` + full `bun run test` — 0 failures
- [ ] `bun run typecheck` — 0 errors
- [ ] Smoke: start the gateway, hit `/health` and a `/v1/chat/completions`
- [ ] PR opened, not merged
