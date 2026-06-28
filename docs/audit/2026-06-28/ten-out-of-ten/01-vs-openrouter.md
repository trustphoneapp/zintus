# Zintus ROUTER + MODEL MARKETPLACE vs OpenRouter — brutal 10/10 benchmark

Date: 2026-06-28 · Branch: `feat/zintus-10-10` · Benchmark: **OpenRouter** (Zintus's
primary competitor on this axis). Scoring is against a true 10/10, not against "is it
built." Every Zintus claim below was verified in source (read-only); OpenRouter facts
are from current public docs (see Sources).

**Overall router-marketplace score: 6 / 10.**

Zintus has built a genuinely honest, OpenRouter-*shaped* surface — rich `/v1/models`,
`/v1/pricing`, `/v1/activity`, `/v1/key`, route-reason on every response, a models
catalog UI, a provider cockpit, and a public catalog — and it layers four real
differentiators OpenRouter lacks (no-custody/local-first, Tokzen savings ledger,
capability/quota/privacy intelligence, route-reason). But the *marketplace core* is
thin: **23 live-routable models across 12 providers** vs OpenRouter's **400+ models /
60+ providers**, no live latency/throughput/uptime stats, single-key BYOK ("priority +
fallback" is an honest "Coming soon" stub), and activity history is in-memory
trace-derived rather than durable. The differentiators are 8–9/10; the commodity axes
are 3–6/10, and they drag the blended score down.

---

## Per-axis scores

### 1. Model catalog — breadth + depth — **Zintus 4/10 · OpenRouter 9/10**

What's built (verified):
- `packages/providers/src/catalog.ts` — `MODEL_CATALOG`, **23 enumerable entries**
  across **12 providers** (Gemini ×5, OpenRouter ×3, DeepSeek/Mistral/Cohere/Cerebras/
  Groq ×2, Fireworks/xAI/HuggingFace ×1, lmstudio/ollama ×1). Each entry is rich:
  `contextWindow`, `vision`, `tools`, `structuredOutput`, `inputPer1M/outputPer1M`
  (null when unknown — no invented prices), `free`, `local`, `dataPolicy`,
  `isProviderDefault`. Capability flags are test-asserted (`catalog.test.ts`) to mirror
  the actual chat gates — it **cannot silently over-claim** a capability. This is a
  genuinely high-quality data model.
- A separate **100-model / 55-provider marketing catalog** (`apps/web/data/providers.ts`
  → `/catalog` page, `apps/web/app/catalog/page.tsx`) with search/sort/tier/family
  filters and a derived stat strip (`CATALOG_STATS`).

Brutal gaps to 10:
- **Breadth is ~5% of OpenRouter.** 23 routable models vs 400+. The 100-model public
  catalog is **static marketing data, not routable** — a user cannot select most of
  those models and have them served. The depth/honesty is 9/10; the breadth is 2/10.
- **No live provider stats.** OpenRouter shows p50/p75/p90/p99 latency, throughput, and
  uptime per provider per model on every model page. Zintus's catalog is a curated
  static snapshot (`updatedAt` dates, hand-seeded), no measured metrics.
- **No model detail / benchmark pages** comparable to OpenRouter's per-model provider
  comparison + benchmark scores. Zintus has `ModelDetailPanel.tsx` / `CompareTable.tsx`
  (good), but they show catalog flags, not live performance or eval data.
- To reach 10: 300+ live-routable models (curate or mirror provider `/models`), measured
  latency/throughput/uptime per (provider, model), and benchmark data on detail pages.

### 2. Provider routing / fallback — **Zintus 6/10 · OpenRouter 8/10**

What's built (verified):
- `packages/router/src/factory.ts` — real failover: `on_429`/`on_5xx → next_provider`,
  priority-sorted candidates (`sortProviders`), sticky provider, capability-aware
  candidate filtering (won't route a tools request to a non-tools failover).
- Route-reason emitted on the winning route (see axis 8).

Brutal gaps to 10:
- **No performance-aware selection.** OpenRouter load-balances on price *while weighting
  uptime*, supports `sort` (price/latency/throughput), and lets callers set **percentile
  throughput cutoffs** (e.g. ">50 tok/s at p90") with multi-cutoff preferred groups.
  Zintus routes by static priority + capability + quota, not by measured latency/uptime.
- **No caller-facing provider-preference ordering** in the OpenAI-compatible request
  (OpenRouter's `provider: { order, allow_fallbacks, sort }`).
- To reach 10: measured latency/uptime feeding selection, request-level provider
  ordering/sort knobs, percentile cutoffs.

### 3. Pricing transparency — **Zintus 6/10 · OpenRouter 9/10**

What's built (verified):
- `packages/providers/src/pricing.ts` — `PRICING_CATALOG`, USD/1M in+out, per-entry
  source citations and `updatedAt`, conservative caveats (`freeLimitNotes`), 0→null
  mapping so local/free never reads as a misleading price.
- `GET /v1/pricing` (`handler.ts:1841`) returns only models with a **known** list price
  (unknown omitted, never invented). A `/pricing` web page exists.

Brutal gaps to 10:
- **Coverage is ~13 priced pairs.** OpenRouter publishes input/output/image/request
  pricing for **all 400+ models, per serving provider**, at-or-near passthrough cost.
- **No per-provider price comparison** for the same model (OpenRouter's core strength).
- Honesty is a win (Zintus discloses BYOK = your own provider bill, no markup; OpenRouter
  adds a 5.5% credit-purchase fee + 5% BYOK fee). To reach 10: price every routable
  model, show multi-provider price spread per model.

### 4. Usage / activity — **Zintus 5/10 · OpenRouter 8/10**

What's built (verified):
- `GET /v1/activity` (`handler.ts:1864`) — OpenRouter-shaped: paginated (`limit` cap 200,
  honest `has_more` via fetch-one-extra), `?provider`/`?model` filters, per-request
  `{provider, model, tokens, cost_usd, saved_vs_baseline_usd, latency_ms, cache_hit,
  route_reason?}`. `toActivityEntry` is honest by construction — cost $0 on free tier,
  tokens default 0 when unrecorded, `route_reason` omitted when absent.

Brutal gaps to 10:
- **Not durable history.** It's derived from the same in-memory `engine.listTraces()`
  ring as `/v1/traces` — there is no 30-day persistent store. OpenRouter returns daily
  activity grouped by endpoint for the last 30 completed UTC days, filterable by key.
- **No aggregation / charts / date-range**, no by-key grouping, and the web side is
  "last-5 traces," not a real activity dashboard.
- To reach 10: durable usage store, date-range + by-key aggregation, an activity UI page.

### 5. Key / quota API — **Zintus 7/10 · OpenRouter 8/10**

What's built (verified):
- `GET /v1/key` (`handler.ts:1777`) — `is_free_tier:true`, `managed_keys_available:false`,
  per-provider `{has_key, available, in_cooldown, quota_used, quota_limit,
  quota_remaining_ratio}`. Honest: `quota_limit`/`ratio` are **null** when the provider
  reports no denominator (no fabricated cap) — directly fixes the MATRIX honesty bug.

Brutal gaps to 10:
- Introspects only the **gateway token**, not arbitrary per-key (no provisioning/
  management-key model — by design, since there's no custody).
- No standardized rate-limit response headers. OpenRouter's `/key` returns live credit +
  rate-limit state. (Zintus has no credits — correct given no-custody.) To reach 10:
  per-key introspection + rate-limit headers.

### 6. BYOK key management — priority / fallback — **Zintus 3/10 · OpenRouter 9/10**

What's built (verified):
- BYOK is local + no-custody (keys encrypted client-side; `apps/web/lib/crypto.ts`),
  surfaced in the provider cockpit (`apps/web/app/(app)/providers/page.tsx`).

Brutal gaps to 10:
- **One key per provider.** "Key priority & fallback" is an explicit **honest "Coming
  soon" placeholder** (`providers/page.tsx:497-517`), not a control. OpenRouter has
  **Prioritized** (tried before OR endpoints) and **Fallback** (tried after) BYOK keys,
  multiple keys per provider, in order.
- To reach 10: multiple keys per provider with prioritized/fallback ordering + per-key
  validation. (Zintus's no-custody BYOK is itself a differentiator — see axis 8 — but on
  the *management* sub-axis it is behind.)

### 7. Developer API + docs — **Zintus 5/10 · OpenRouter 9/10**

What's built (verified):
- OpenAI-compatible gateway (`/v1/chat/completions`, `/v1/models` with the
  `{id, object:"model", owned_by}` triple pinned by `contracts.test.ts`), an OpenAPI
  spec (`apps/gateway/src/openapi-spec.test.ts`), and web `docs` + `developers` pages.

Brutal gaps to 10:
- No full API reference site, no interactive playground, no published SDK, thin error/
  auth docs, no OAuth/PKCE app-auth flow. OpenRouter has a complete reference, OAuth,
  SDKs, and tutorials. To reach 10: reference docs + playground + SDK + error catalog.

### 8. Zintus differentiators OpenRouter lacks

- **Local-first / no-custody / BYOK — 9/10 (genuine moat).** `managed_keys_available`
  is hard-`false` everywhere; keys stay local; no credits, no funds held, no markup.
  OpenRouter is custodial (credits ledger, 5.5% purchase fee, 5% BYOK fee). This is a
  real, defensible, *proven* differentiator. Gap to 10: it's a positioning win, not yet
  a fully marketed product surface.
- **Tokzen savings ledger — 8/10.** `/v1/savings` (`handler.ts:1885`) +
  `saved_vs_baseline_usd` per activity row + compression. OpenRouter has nothing
  equivalent. Caveat (from MATRIX): compression runs at the gateway, and "savings" has
  two flavors (compression-token vs free-vs-paid) — keep them distinct; estimate-only.
- **Capability / quota / privacy intelligence — 8/10.** `/v1/route/options` decision API,
  per-model capability flags test-locked to real gates, data-policy badges
  (no-train/may-train/ZDR/unknown) on models and the cockpit, live quota bars. OpenRouter
  has privacy *controls* but not this unified, surfaced intelligence. Gap to 10: expose
  it as first-class API/filters end-to-end.
- **Route-reason — 8/10.** `buildRouteReason` (`engine.ts:87`) emits a human "Routed to
  X (model) via the auto strategy (vision/tools-capable) after N failovers; Private Mode
  honored." on every response (header `X-Zintus-Route-Reason` + `MessageBubble.tsx` +
  `/v1/activity`). OpenRouter does not surface a per-response why. Gap to 10: it's
  somewhat templated — add the *losing* candidates and the price/latency tradeoff that
  drove the pick.

---

## Scorecard

| Axis | Zintus | OpenRouter | Gap to 10 (Zintus) |
|---|:--:|:--:|---|
| Model catalog breadth+depth | 4 | 9 | 300+ routable models, live latency/throughput/uptime, benchmark detail pages |
| Provider routing / fallback | 6 | 8 | Performance-aware selection, request-level provider order/sort, percentile cutoffs |
| Pricing transparency | 6 | 9 | Price every routable model; per-provider price spread |
| Usage / activity | 5 | 8 | Durable 30-day store, by-key/date aggregation + charts, activity UI |
| Key / quota API | 7 | 8 | Per-key introspection + rate-limit headers |
| BYOK key mgmt (priority/fallback) | 3 | 9 | Multiple keys/provider, prioritized + fallback ordering |
| Developer API + docs | 5 | 9 | Reference site, playground, SDK, error/auth docs |
| Differentiator: no-custody/local-first | 9 | — | Productize/market the moat |
| Differentiator: Tokzen savings | 8 | — | Unify the two savings flavors, harden estimates |
| Differentiator: capability/quota/privacy intel | 8 | — | First-class API/filter surfacing |
| Differentiator: route-reason | 8 | — | Add losing candidates + tradeoff |

**Blended router-marketplace score: 6 / 10.** Commodity-axis median ~5.5; differentiator
median ~8. The data model, honesty bar, and the four moats are real and strong; breadth,
BYOK key management, and durable usage are what keep it off 10.

## Top 3 gaps to 10/10
1. **Catalog breadth + live provider stats.** 23 routable models / 12 providers vs 400+;
   the 100-model public catalog is static, non-routable marketing; no measured latency/
   throughput/uptime. Make 300+ models actually routable and add live per-provider stats.
2. **BYOK priority / fallback key management.** Today one key per provider with a "Coming
   soon" stub; OpenRouter has prioritized + fallback multi-key ordering. Build multiple
   keys/provider with prioritized/fallback ordering and per-key validation.
3. **Durable usage/activity + full priced coverage.** `/v1/activity` is in-memory
   trace-derived (no 30-day store, no by-key/date aggregation, no UI dashboard), and
   `/v1/pricing` covers only ~13 priced pairs. Add a durable usage store + activity UI
   and price every routable model with per-provider comparison.

## Sources
- https://openrouter.ai/pricing
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/guides/overview/auth/byok
- https://openrouter.ai/docs/api/reference/overview
- https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity
- https://openrouter.ai/docs/api/api-reference/credits/get-credits
- https://openrouter.ai/docs/faq
- https://openrouter.ai/compare
- https://openrouter.ai/docs/api/reference/limits
- Zintus source (read-only, branch `feat/zintus-10-10`): `packages/providers/src/catalog.ts`,
  `packages/providers/src/pricing.ts`, `apps/gateway/src/handler.ts`
  (`/v1/models`,`/v1/pricing`,`/v1/activity`,`/v1/key`), `packages/engine/src/engine.ts`
  (`buildRouteReason`), `packages/router/src/factory.ts`, `apps/web/app/catalog/page.tsx`,
  `apps/web/data/providers.ts`, `apps/web/app/(app)/models/*`, `apps/web/app/(app)/providers/page.tsx`,
  `docs/ROADMAP-10-10.md`, `docs/audit/2026-06-28/phase0/MATRIX.md`.
