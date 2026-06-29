# Agent 1 — Router / Marketplace vs OpenRouter (debate re-score)

Date: 2026-06-28 · Branch: `feat/zintus-10-10` · Benchmark: **OpenRouter** (literal 10/10 bar).
Method: every claim re-VERIFIED in source on this branch (read-only). I did NOT trust the
prior audit (`01-vs-openrouter.md`, `FINAL-SCORECARD.md`) or commit messages — and indeed
the prior audit is now **stale on one major axis** (see "What changed" below).

## SCORE: **7 / 10** on the router/marketplace axis.

Honest, OpenRouter-*shaped*, and now genuinely **performance-aware** — but breadth is
~9% of OpenRouter and the public `/catalog` over-claims routability. Two things keep it
firmly off 10: (1) only **12 routable providers / 37 routable models** vs 400+/60+, and
(2) a real **honesty over-claim** in the marketing catalog. The differentiators (no-custody,
route-reason, Tokzen, capability/quota intel) remain 8–9.

---

## What changed since the prior audit (prior audit is STALE here)

The prior `01-vs-openrouter.md` scored "Provider routing / fallback 6/10" with the headline
**"No performance-aware selection… Zintus routes by static priority + capability + quota,
not by measured latency/uptime."** That is **no longer true.** Verified now:

- **Measured latency feeds routing.** `quota-ledger.ts:211 recentLatencyP95` computes p95
  over recent *successful* requests from a durable sqlite column (`usage_log.latency_ms`,
  `quota-ledger.ts:76,107`). `factory.ts:414` wires it into candidate selection.
- **Real strategy set** in `priority.ts:54 sortProviders`: `fastest` (p95 ascending,
  `:124-135`), `balanced` (40% capability / 30% cost / 30% latency, `:99-123`), `quality`
  (capability then p95 tie-break, `:86-98`), `economy` (quota-aware cheapest, `:61-79`),
  `capability`, and `weighted` (random^(1/w) reservoir, `factory.ts:445-461`).
- **Per-request strategy + weights override:** `request.strategy` / `request.providerWeights`
  (`factory.ts:426,443`) — a GUI/caller can pick the strategy per request.
- **Health probing / circuit breaker landed:** `factory.ts:532 probeProviders` validates each
  keyed provider and records a failure to demote it; half-open single-probe admission
  (`factory.ts:669-688`), tested in `factory.half-open.test.ts`, `factory.probe.test.ts`,
  `factory.latency.test.ts`, `weighted.test.ts`.

So routing intelligence is materially better than the prior 6. This is the single biggest
reason I land at 7 rather than 6.5.

---

## Per-axis (verified)

### 1. Catalog breadth + depth — **Zintus 4/10 · OpenRouter 9/10**
- **37 routable models / 12 providers.** `catalog.ts` `SEEDS` (verified count = 37,
  `:139-198`): gemini×6, mistral×8, cohere×5, groq×4, cerebras×3, openrouter×3, deepseek×2,
  fireworks×2, xai×1, huggingface×1, lmstudio×1, ollama×1. `ProviderId` (`provider-id.ts:1-13`)
  is a closed union of exactly those **12** — there is no `anthropic`/`openai` provider.
- Depth is genuinely high: each entry carries `contextWindow/vision/tools/structuredOutput/
  inputPer1M/outputPer1M(null when unknown)/free/local/dataPolicy/isProviderDefault`
  (`catalog.ts:51-78`), and `catalog.test.ts` asserts the capability flags **mirror**
  `capabilities.ts` so it cannot silently over-claim. Depth 9, breadth 2 → blended 4.
- **Gap to 10:** 300+ routable models. OpenRouter = 400+/60+.

### 2. Provider routing / fallback — **Zintus 7/10 · OpenRouter 8/10** (was 6)
- Failover real: `on_429`/`on_5xx → next_provider` (`factory.ts:201-203`), capability-aware
  candidate filtering, same-model multi-provider groups (`factory.ts:431-441`,
  `factory.model-groups.test.ts`), sticky/default provider (`:477-482`).
- Performance-aware selection now real (see "What changed").
- **Gaps to 10:** measured latency is **internal-only** — it is NOT surfaced (no
  `provider:{order,allow_fallbacks,sort}` in the OpenAI body, no percentile-throughput
  cutoffs like OpenRouter's `>50 tok/s @ p90`). Throughput and uptime are **not tracked at
  all** (only p95 latency + an error-streak demotion; grep for `throughput|uptime` in
  router/engine = only comments + process-uptime in `metrics.ts:62`).

### 3. Pricing transparency — **Zintus 6/10 · OpenRouter 9/10**
- `GET /v1/pricing` (`handler.ts:2370`) returns only models with a KNOWN list price
  (`m.inputPer1M !== null && m.outputPer1M !== null`) — unknown omitted, never invented.
- **~16 priced pairs** (`pricing.ts`, verified `inputPer1M` count = 16). No per-provider
  price spread for the same model (OpenRouter's core strength). Gap to 10: price every
  routable model + multi-provider spread.

### 4. Usage / activity — **Zintus 6/10 · OpenRouter 8/10** (durable store landed)
- **Durable sqlite store is real:** `activity-store.ts` — `ACTIVITY_RETENTION_DAYS=30`
  (`:15`), prune-on-write (`:101-113`), `recordActivity`/`listActivity` with
  `provider`/`model`/`since`/`limit` filters (`:53-60,150`). `/v1/activity` reads the store
  first, falls back to the in-memory trace ring (`handler.ts:2395-2405`).
- **But the web UI does NOT consume it.** `app/(app)/usage/page.tsx:43` fetches
  `fetchGatewayTraces(5)` — the **last 5 in-memory traces**, not the durable 30-day store.
  CSV export is trace-derived too (`:111`). No charts, no date-range, no aggregation in the
  API or UI. By-key grouping is absent (moot — single no-custody token).

### 5. Key / quota API — **Zintus 7/10 · OpenRouter 8/10**
- `GET /v1/key` (`handler.ts:2306`): `is_free_tier:true`, `managed_keys_available:false`,
  per-provider `{has_key, available, in_cooldown, quota_used, quota_limit,
  quota_remaining_ratio}`. Honest: `quota_limit`/`ratio` are **null** when no denominator
  (`:2314-2318`) — no fabricated cap. `/v1/status` mirrors it (`:2276-2298`).
- Gap: introspects only the gateway token (by design — no custody, no credits, correct).

### 6. BYOK key management (priority/fallback) — **Zintus 6/10 · OpenRouter 9/10** (engine real, UI thin)
- **Engine + keychain real:** `factory.ts:298 keysFor` returns an ordered list
  (per-request `request.keys`, then keychain primary + `::fallbacks`), deduped, order
  preserved; the stream walk retries the same provider+model on a pre-stream 401/403 then
  falls to normal failover (`factory.ts:692-709`). `factory.keys.test.ts` covers it. With
  0/1 keys behavior is identical to the old single-key path — additive.
- **UI gap:** the cockpit (`app/(app)/providers/page.tsx`) is single-key per provider; there
  is no multi-key priority/fallback ordering editor or per-key validation surfaced. OpenRouter
  has Prioritized + Fallback BYOK ordering in the UI.

### 7. Developer API + docs — **Zintus 5/10 · OpenRouter 9/10**
- OpenAI-compatible `/v1/chat/completions`, `/v1/models` (the `{id,object:"model",owned_by}`
  triple pinned by `contracts.test.ts`), OpenAPI spec test. No reference site / playground /
  published SDK / OAuth.

### 8. Differentiators OpenRouter lacks (unchanged, strong)
- **No-custody / local-first — 9.** `managed_keys_available:false` hard everywhere
  (`handler.ts:2329`); keys local; no credits/markup. Genuine moat.
- **Route-reason — 8.** `engine.ts:87 buildRouteReason`, emitted on every route
  (`:778,899,1017`), header + activity + all 4 client surfaces.
- **Tokzen savings — 8.** `/v1/savings`, `saved_vs_baseline_usd` per activity row,
  `/v1/status` savings block (`handler.ts:2289-2296`) labelled estimate.
- **Capability/quota/privacy intel — 8.** `/v1/route/options`, data-policy tags, live quota.

---

## HONESTY FINDING (the load-bearing ding on this axis)

The public marketing catalog **over-claims routability.** `apps/web/data/providers.ts:1`
header literally says *"providers and models the router can reach"* and then lists **55
providers / 100 models**, including **Anthropic** ("Claude Opus 4.8 · Sonnet 4.6 · Haiku
4.5") and **OpenAI** ("GPT-5.5 · o3 · o4-mini") plus ~16 more BYOK providers, each with a
violet **"Add your key"** badge (`catalog/page.tsx:29 BADGE_LABEL["add-key"]="Add your key"`).

But **none of those `add-key` providers are routable.** `ProviderId` is a closed 12-member
union with **no `anthropic`/`openai`** (`provider-id.ts:1-13`), there is **no adapter**
(`packages/providers/src/providers/` = cerebras, gemini, groq, ollama, skeletons), and the
real BYOK cockpit only offers keys for the 12 routable providers (`providers/page.tsx`,
`FREE_KEY_URLS` lists 7). A user reading `/catalog` would reasonably believe they can add
their Anthropic key and route to Claude — they cannot. That is **~43 unwired "Add your key"
rows** presented as reachable. The actually-routable surface (`/v1/models`, `/v1/pricing`,
the cockpit) is honest; the *marketing* catalog is not. This must be fixed to hold the
honesty bar — the routable surface and the marketing surface disagree.

(Everything else checks out honest: prices null when unverified, savings labelled estimate,
managed keys hard-false, payouts/checkout "coming soon".)

---

## Top 3 CODEABLE gaps (ranked by 10/10 leverage)

1. **Surface live per-provider stats AND grow routable breadth.** p95 latency is already
   measured (`quota-ledger.ts:211`) but is *internal-only* — expose it in `/v1/models` /
   `toModelEntry` (`handler.ts:87`) or a `/v1/providers/stats` endpoint, add throughput
   (tok/s — derivable from `latency_ms` + tokens already logged) and an uptime% (derivable
   from the success/error rows in `usage_log`), and render it on the catalog/model pages.
   Same push: make many more models routable (the openai-compat base in
   `providers/src/openai-compat.ts` makes new adapters cheap). Closes the two biggest dings
   (breadth + "no live stats") at once. (catalog 4 + routing 7 → 9.)

2. **Resolve the catalog honesty over-claim.** Either build the missing BYOK adapters
   (Anthropic/OpenAI/Together/etc. — most are OpenAI-compatible) so "Add your key" is true,
   or relabel the marketing `/catalog` rows as "Planned / not yet routable" and fix the
   `providers.ts:1` "the router can reach" line. Non-negotiable for the honesty bar.

3. **Wire the durable activity store into the UI + add request-level provider preference.**
   `app/(app)/usage/page.tsx:43` reads the last-5 in-memory traces, not the durable 30-day
   `/v1/activity` store that already exists — point it at `/v1/activity`, add date-range +
   a simple chart. Separately, accept OpenRouter-style `provider:{order, allow_fallbacks,
   sort}` (+ percentile throughput cutoffs) in the `/v1/chat/completions` body and map to the
   existing strategy/weights/group machinery (`factory.ts:426,443`). (activity 6 → 8,
   routing 7 → 8.)

## [HUMAN] / device / business launch gates on this axis

- **Managed-key custody / live billing** — correctly gated (`MANAGED_KEYS_AVAILABLE=false`,
  checkout "coming soon", `pricing/page.tsx:322`). Turning it on needs a custody backend +
  Stripe + legal — a business decision, NOT codeable in CI.
- **Live BYOK adapter verification** — building Anthropic/OpenAI adapters is codeable, but
  proving they route end-to-end needs real third-party API keys / a keyed live run = [HUMAN].
- **Publishing third-party provider latency/uptime stats** — measuring and publicly
  publishing other vendors' performance carries a ToS/legal posture decision = [HUMAN].
- **Referral payouts** — `REFERRAL_PAYOUTS_LIVE=false`, "Payouts coming soon" (honest);
  going live is business/Stripe = [HUMAN].

## Bottom line
The router engine quietly got better than the last audit credits: it is now genuinely
latency/quality/cost-aware with health probing, real BYOK fallback, and a durable activity
store. But it remains a **12-provider / 37-model** marketplace measured against a 400+/60+
benchmark, the measured latency is never surfaced, and the public catalog claims routability
it does not have. Honest **7/10** — strong, transparent, uncopyable moat; not 10.
