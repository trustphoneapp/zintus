# Phase 0 — From-disk audit: **Core packages** column

Date: 2026-06-28 · Branch: `feat/zintus-10-10` · Scope (this column):
`packages/router`, `packages/providers`, `packages/types`, `packages/schemas`,
`packages/media`, `packages/engine`, `packages/tokzen`, `packages/memory`,
`packages/cache`, `packages/context-compiler`.

Read from source, not docs/memory. `✅` implemented+real · `🟡` partial ·
`❌` missing · `🔒` needs human/device/cert · `n/a` = surface concern, not core.

## Capability matrix — CORE layer

| Row | Core status | Evidence (file:line) |
|---|---|---|
| chat | ✅ | `engine/src/engine.ts:425` routeAndStream → `router/src/factory.ts:521` → provider `streamChat` (`providers/src/openai-compat.ts:362`, `providers/src/providers/gemini.ts:345`). Streaming, failover, usage all real. |
| markdown | n/a (surface) | Core emits raw assistant text; rendering is a web/desktop/CLI concern. |
| image input | ✅ | Type `ImageContentBlock` `types/src/route.ts:15`; processing+EXIF strip `media/src/shared.ts:195,394`; wire: Gemini `inlineData` `providers/.../gemini.ts:137`, OpenAI-compat `image_url` data-URL `providers/src/openai-compat.ts:56`; router GATES via `supportsVision` and hard-errors `unsupported_capability` `router/src/factory.ts:562`. |
| file input (docs/PDF) | ❌ | No file/document content block — union is text/image/tool only `types/src/route.ts:53`. `media` explicitly REJECTS PDF `media/src/shared.ts:166`. Edge schema accepts only text/image/tool blocks `schemas/src/index.ts:70`. |
| voice input | ❌ | No audio content block anywhere; no transcription path in core. |
| tool calling | ✅ | `ToolDefinition`/`ToolChoice` types; router gates `requiresTools` + per-model `supportsTools`, blocks failover onto non-tool models `router/src/factory.ts:578,671`; OpenAI-compat `tools`/`tool_choice` `openai-compat.ts:380`; Gemini `functionDeclarations` `gemini.ts:364`; live tool-call channel `factory.ts:754`. |
| structured output | ✅ | Buffered validate→repair loop `engine/src/engine.ts:541`; Ajv 2020 validation + JSON extraction + repair `schemas/src/index.ts:329,354,426`; Gemini `responseSchema` `gemini.ts:388`; OpenAI strict `json_schema` + schema normalization `openai-compat.ts:226,297`; 3-state level honored end-to-end `capabilities.ts:202`. |
| deep research | 🟡 | In-column only a request schema `schemas/src/index.ts:233`. Orchestration lives in `packages/search` (out of this column); `packages/engine` has NO research path. |
| compare | n/a (surface) | No model-compare in core; UI/gateway concern. |
| projects | ❌ / n/a (surface) | Conversation store is flat threads only (`types/src/conversation.ts:3` `Thread`); no project grouping in core. |
| provider keys | 🟡 (consumed, not owned) | Router resolves keys via injected `getApiKey` + per-request `request.keys` `router/src/factory.ts:278,290`; local providers keyless `factory.ts:204,307`. Vault/storage is `packages/keychain` (out of column). |
| BYOK vault | 🔒 / out-of-column | Per-request BYOK supported in router `factory.ts:290`; engine falls back to `getKey` `engine.ts:280`. Actual encrypted vault = `packages/keychain`/`crypto-e2e` (not this column). |
| local runtime | ✅ | Ollama provider real (`/api/chat`, `/api/tags` detect) `providers/src/providers/ollama.ts:25,107`; LM Studio skeleton; router treats local as keyless+free `factory.ts:204,307`, pricing 0 `pricing.ts:178`. |
| routing strategies | ✅ | `sortProviders` — fastest/economy/capability/quality/balanced + weighted `router/src/priority.ts:54`; per-request override `factory.ts:388`. |
| route reason | 🟡 | Router returns `providerId`/`model`/`resolvedStructuredLevel`/`privacyHonored` + per-attempt trace `factory.ts:858`, but emits NO human/machine route-REASON (chosen strategy, why-skipped, fallback cause). Surfaces must infer it. |
| quota display | ✅ | `getQuotaRemaining` (daily ∧ rolling-minute incl. in-flight) `factory.ts:465`; `getProviderStatus` full snapshot `factory.ts:297`; `QuotaLedger` persisted. |
| compression savings | 🟡 | `getSavings`/`savingsUsd` is FREE-TIER paid-equivalent savings, NOT Tokzen compression `quota-ledger.ts:263`, `limits.ts:62,90`. `tokzen.estimateSavings` exists but is **not imported by engine/router/compiler** — per-response compression savings unrealized in core. Compiler reduces tokens (`compileTokenEstimate`) without a savings ledger. |
| usage/activity | 🟡 | Data layer real: `usage_log` + `recordUsage` `factory.ts:783`; trace persistence + `listTraces`/`getTrace` (conversation-store). `/v1/activity` history surface is gateway. |
| model catalog | 🟡 | `MODEL_CAPABILITIES` registry real but **provider-keyed, one default model each** `providers/src/capabilities.ts:64`. No per-model listing/filtering. This is THE gap. |
| pricing catalog | ✅ (provider-keyed) | `PRICING_CATALOG` real, sourced+dated, `estimateCostUsd` `providers/src/pricing.ts:55,219`. One entry per provider default (+Groq 8B); no per-model breadth. |
| API docs | n/a (gateway/docs) | — |
| OpenAI-compatible API | n/a (gateway) | Outbound wire adapter exists `providers/src/openai-compat.ts`; the inbound `/v1` server is gateway. |
| account/auth | n/a (relay/web) | — |
| security | ✅ | Magic-byte mime + EXIF/GPS/XMP strip + SVG reject `media/src/shared.ts:195,394`; `redactSecrets` on persisted errors `factory.ts:889`; untrusted-context guard (OWASP LLM01) `context-compiler/src/compiler.ts:UNTRUSTED_GUARD`; `sanitizeInput`/`wrapUntrustedContext`; Ajv validator-cache DoS bound `schemas/src/index.ts:295`; image data never logged `media/src/shared.ts:6`. |
| observability | ✅ | Dependency-free OTLP/HTTP export with REAL measured span timing `engine/src/otel.ts:1,498`; per-attempt spans; cache-tier attribute; no-op when env unset. |
| billing/paid overflow | n/a (relay/web) | No custody in core (rule 2). Pricing is reference-only `pricing.ts:11`. |
| referral/node marketplace | n/a (relay) | — |

## (1) Catalog data-model verdict — **provider-keyed, one default model each**

**Provider-keyed, NOT per-model.** `MODEL_CAPABILITIES: Record<ProviderId, ModelCapabilities>`
has exactly one entry per provider, each carrying a single `model` field
(`capabilities.ts:64`, e.g. `gemini → gemini-2.5-flash`, `groq → llama-3.3-70b-versatile`).
`PRICING_CATALOG` mirrors this: one entry per provider default model, plus Groq's
8B failover and one representative OpenRouter `:free` route (`pricing.ts:55-194`) —
12 providers ≈ 13 priced pairs, not a model catalog.

Per-model awareness exists only as narrow **gating allowlists** layered on top —
`VISION_MODELS` (gemini + 2 OpenRouter), `TOOL_MODELS` (gemini + groq),
`JSON_SCHEMA_MODELS` (gemini) at `capabilities.ts:105,142,184` — used so a
specific model can be checked for vision/tools/schema and fail closed. They do
NOT make the catalog enumerable per-model. A genuine OpenRouter-grade `/v1/models`
cannot be built on this; Phase 1 (model-keyed data) is a hard prerequisite and the
roadmap already flags it.

## (2) False / overstated claims in core

Core comments are unusually honest (most caveat themselves). Findings:

- **None hard-false.** `capabilities.ts:9-18` claims the engine "DOES emit these
  features on the wire" — verified true (Gemini inlineData, OpenAI image_url,
  tools, response_format all present). The header also self-discloses it covers
  only each provider's DEFAULT model.
- **Overstated breadth (structural, not a lie):** the registry presents itself as
  "the single source of truth for what each provider's model can do"
  (`capabilities.ts:4`) while only describing ONE model per provider — anything
  built on top (a "catalog") will overstate model breadth. Tracked as P0.
- **`compression savings` naming risk:** `getSavings` is free-tier savings, not
  Tokzen compression savings; honest in its own comment (`quota-ledger.ts:260`)
  but easily conflated with the roadmap's "per-response Tokzen savings," which is
  NOT wired in core.
- **Pricing entries to re-verify:** `deepseek-chat` annotated "V4 Flash"
  (`pricing.ts:132`) — DeepSeek's current public model is V3-class; verify before
  surfacing. `cerebras` price self-marked "approximate (dev tier)" `pricing.ts:63`.
- **`estimateCostUsd` silent 0:** OpenRouter free-failover models (`gemma-2-9b:free`,
  `mistral-7b:free`) are routable (`factory.ts:135`) and have economy anchors
  (`limits.ts:90`) but have NO `PRICING_CATALOG` entry, so `estimateCostUsd` returns
  0 for them (`pricing.ts:226`) — silently understates cost. P2.
- **Dead surface:** `tokzen` pipeline advertises `anthropic`/`openai` providers
  (`tokzen/src/pipeline/types.ts:2`, proxy `tokzen/src/proxy/server.ts:25`) that the
  Zintus router never serves — could imply capability that isn't exposed.

## (3) Brutal P0–P3 — core layer toward 10/10 OpenRouter-grade

**P0 — blocks truth/security/build**
- **Model-keyed catalog data model.** Evolve `MODEL_CAPABILITIES` (`capabilities.ts:64`)
  and `PRICING_CATALOG` (`pricing.ts:55`) from `Record<ProviderId, …>` to genuine
  per-model rows (price·context·vision·tools·json·privacy·local·quota). Until then,
  any catalog UI/`/v1/models` overstates breadth — the single load-bearing gap.

**P1 — blocks serious product**
- **Route reason.** Router must emit a structured reason (chosen strategy, candidates
  considered, why-skipped/cooldown/quota, fallback cause) alongside the winner
  (`factory.ts:858`). Consistency + honesty rules require route-reason on every
  surface; core produces none today.
- **Wire Tokzen compression into the hot path.** `tokzen.compress`/`estimateSavings`
  exist but engine never calls them; add a per-response compression-savings ledger
  distinct from free-tier savings (engine has no `@zintus/tokzen` import).
- **File + voice input content blocks.** Add document/audio blocks to
  `types/src/route.ts:53`, `schemas/src/index.ts:70`, `media`, and provider adapters;
  gate like vision. Needed for ChatGPT/Gemini multimodal parity.
- **Deep-research path in engine** (or explicit delegation) — only a schema exists
  in-column; core has no orchestration.

**P2 — parity/polish**
- Per-model pricing for failover models so `estimateCostUsd` ≠ 0 for OpenRouter
  free routes (`pricing.ts` add gemma/mistral `:free`).
- Grow `VISION_MODELS`/`TOOL_MODELS`/`JSON_SCHEMA_MODELS` allowlists
  (`capabilities.ts:105,142,184`) — most non-default models fail closed, capping a
  per-model catalog.
- De-duplicate context-window source: `engine.ts:53` heuristic vs
  `capabilities.ts.contextWindow` (drift risk).
- Cache L2 semantic lookup is not user/thread-scoped (`engine.ts:741`) — safe for
  single-user local DB, must gain a scope dimension before any shared/multi-tenant use.

**P3 — growth**
- Project grouping in the conversation store (threads only today).
- Decide catalog data source (curate vs ingest provider `/models` vs mirror
  OpenRouter `/models`) — Phase 1 dependency.
- Remove/segregate unused `tokzen` anthropic/openai proxy surfaces or document them
  as a separate library, not Zintus routing.
