# Zintus Roadmap

This document outlines the current state, architectural lessons, and the forward roadmap for Zintus. It distinguishes between what is shipped and working today, what was intentionally removed or deprecated, and what is planned for future phases.

---

## 1. Current State (Shipped & Verified)

Zintus is a local-first multi-provider AI gateway and memory system. The following modules are active and tested in the codebase:

| Component | Status | Reality in Codebase |
| :--- | :--- | :--- |
| **Multi-Provider Routing** | ✅ Shipped | Standardized adapters in `@zintus/providers` routing through `@zintus/router` with `fastest`, `economy`, and `capability` strategies. Supports sticky sessions (30-min TTL) and failover. |
| **Rate Limit & Cooldown** | ✅ Shipped | Exponential backoff cooldown logic. Specialized parsing of Groq `x-ratelimit-*` headers to trigger rolling-window resets. |
| **Quota Ledger** | ✅ Shipped | SQLite-backed database (`quota.db`) driven by Drizzle ORM to enforce daily per-provider limits (Requests + Tokens). |
| **Context Compiler** | ✅ Shipped | Dynamic token budget allocator (`Smart`, `Fast`, `Deep` modes) managing static profiles, facts summary, and recalled vectors. |
| **Memory System** | ✅ Shipped | Deterministic summaries + regex facts. SQLite vector search (`sqlite-vec` virtual table `vec0` on `memory.db`) with a fallback cosine-similarity scanner. |
| **Gateway Orchestrator** | ✅ Shipped | Bun-native gateway HTTP server serving as the single "brain" for key resolution, caching, memory, and database writes. |
| **Client UI Shells** | ✅ Shipped | CLI, Mobile (Expo), Desktop (Tauri), and Web (Next.js 16) communicating with the gateway or performing secure client-side encryption. |

---

## 2. Removed or Deprecated Components

During past iterations, several speculative or fragile architectures were intentionally removed to maintain codebase hygiene:

-   **Old Cache Layer:** An exact-match replay cache and a prompt-marker cache (injecting marker text into prompts to simulate caching without actual backend support) were removed.
-   **Speculative Checkpoint Store:** A graph-like agent execution checkpoint store was removed to prevent premature complexity (YAGNI).
-   **Direct Web/Tauri Databases:** Direct database calls or keychain bindings from the Web frontend were avoided. Next.js in serverless contexts cannot bind to `bun:sqlite` or native OS keyrings. The **Gateway** must serve as the stateful engine.

---

## 3. Roadmap (Shipped vs. Planned)

All work adheres to these strict constraints:
-   **Gateway-First State:** Stateful databases (`bun:sqlite`, keyring, memory indices) exist *only* inside the Gateway (Bun) and CLI. Frontends remain lightweight clients.
-   **Realistic Latency Goals:** L1 exact matches must resolve in `< 2ms`. L2 semantic vector matches must account for local embedding model times (Ollama/Transformers.js), typically taking `100ms - 300ms+`.

### Phase 1: Real Two-Tier Response Caching (`@zintus/cache`) — ✅ Shipped
Implemented in `packages/cache`, consulted by the engine before any provider call:
1.  **L1 Exact Hash Cache — ✅** SHA-256 of message history + model/provider/temperature/max-tokens. O(1) lookup.
2.  **L2 Semantic Cache (opt-in path) — ✅** `sqlite-vec` cosine search on prompt embeddings, bounded by a strict threshold (≤ 0.12), with a deterministic hashing fallback when no embedding model is available.
3.  **Scope Guardrails — ✅** Keys scoped to `providerId`, `model`, and settings; cache tier surfaced to callers via the `X-Cache-Hit` header.

### Phase 2: Weighted & Declarative Routing — ✅ Shipped
1.  **Weighted Load Balancing — ✅** Per-provider weights (`providerWeights` / `strategy: "weighted"`) split traffic; covered by `weighted.test.ts`.
2.  **Virtual API Keys — ✅** Downstream per-key daily quota **and rolling 60s RPM/TPM** limits enforced in `quota-ledger.ts` (`quota-ledger.vk.test.ts`) and exposed on the gateway as `virtual_key`.
3.  **Declarative Policies — ✅ Shipped** Hot-reloadable `policy.json` (priority/weights/model-groups/fallbacks/limits) via `policy.ts` + `watchPolicy`, loaded and live-reloaded by the gateway (`apps/gateway/src/index.ts`); covered by `policy.test.ts`.

### Phase 3: Memory Hardening & Checkpointing — ✅ Shipped
1.  **Fact Conflict Resolution (Mem0-style) — ✅** `consolidateFactsWithLlm` detects contradictions and adds/updates/deletes facts; opt-in via `MEMORY_LLM=1` (deterministic regex extraction is the default).
2.  **Local Execution Checkpoints (LangGraph-style) — ✅** SQLite checkpoint table keyed by `thread_id` with serialized state; exposed via the engine's `saveCheckpoint`/`getCheckpoint`/`listCheckpoints`.

### Phase 4: Competitive parity — ✅ Mostly shipped
1.  **Same-model multi-provider failover — ✅** OpenRouter-style "model groups": a logical model maps to an ordered provider list with whole-group cooldown (`factory.ts`, `factory.model-groups.test.ts`).
2.  **Latency routing — ✅** `fastest` orders by real p95 latency over recent successes (`priority.ts`, `quota-ledger.ts recentLatencyP95`, `factory.latency.test.ts`). (PeakEWMA/P2C remains a possible refinement.)
3.  **Cost-aware `economy` routing — ✅** `economy` ranks by cheapest paid-equivalent cost and is **quota-aware**: a provider whose remaining quota drops below `LOW_QUOTA_FLOOR` is demoted behind every healthy provider, so we never route a request into a near-exhausted (about-to-fail) provider just because it is cheap (`priority.ts`, `priority.test.ts`). Cost is resolved **per-model** (`paidEquivalentUsdPerMTok` + `MODEL_PAID_EQUIVALENT_USD_PER_MTOK`), so Groq's 8B tier vs 70B and the smaller OpenRouter `:free` models are priced correctly, falling back to the provider anchor. The same per-model resolver values the **savings** estimate: `usage_log` now records the model served and `savingsUsd` groups by (provider, model) (`limits.test.ts`, `quota-ledger.test.ts`).
4.  **Token-aware budgets + zero-completion — ✅** Daily + rolling-minute (TPM/RPM) windows; failed runs don't debit token quota (`recordUsage` `billable`). `$` spend caps not implemented (free-tier lane doesn't need them).
5.  **OpenTelemetry tracing — ✅** Dependency-free OTLP/HTTP export (`otel.ts`), env-gated. **Provable savings** (`savingsUsd`) and a background **health probe** also shipped. Still **planned**: context-window/content-policy fallbacks and content-aware (quality) routing.
