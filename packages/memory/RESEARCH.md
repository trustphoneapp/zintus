# Zintus Phase 2 OSS Research

Date: 2026-06-15  
Scope: memory, embeddings, LLM summarization, semantic cache  
Constraint: Bun-native, local-first, avoid heavy dependencies

## Decision Summary

- **Adopt now:** `sqlite-vec`, Ollama embeddings (HTTP or `ollama` JS client), LangGraph checkpoint schema patterns.
- **Fork/copy pattern only:** Mem0 architecture, GPTCache semantic cache policy, LlamaIndex memory-block design, Transformers.js fallback strategy.
- **Skip direct dependency:** `sqlite-vss`, deprecated `run-llama/LlamaIndexTS`, full Mem0/GPTCache framework ingestion.

## 1) mem0ai/mem0

- **GitHub URL:** [https://github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)
- **License:** Apache-2.0
- **Bun/TypeScript compatibility:** TS package exists (`mem0ai`), but full stack is broad and provider-heavy.
- **COPY vs DEPEND:**
  - **COPY:** memory pipeline layering (`extract -> embed -> index -> retrieve`), scoped memory model (user/session/app), provider abstraction.
  - **DEPEND:** not recommended for `@zintus/memory` core right now.
- **Recommendation:** **fork pattern only**

## 2) sqlite-vec (and sqlite-vss comparison)

### sqlite-vec

- **GitHub URL:** [https://github.com/asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)
- **License:** Apache-2.0
- **Bun/TypeScript compatibility:** explicit Bun support with `bun:sqlite`; designed for local embedding/vector use.
- **COPY vs DEPEND:**
  - **COPY:** SQL-first retrieval pattern (`vec0`, top-k + metadata filters), vector + metadata co-location in SQLite.
  - **DEPEND:** yes, as primary local vector backend.
- **Recommendation:** **adopt**

### sqlite-vss

- **GitHub URL:** [https://github.com/asg017/sqlite-vss](https://github.com/asg017/sqlite-vss)
- **License:** MIT OR Apache-2.0
- **Bun/TypeScript compatibility:** workable but legacy; project is no longer actively developed and superseded by `sqlite-vec`.
- **COPY vs DEPEND:** neither for new work.
- **Recommendation:** **skip**

## 3) @xenova/transformers vs Ollama embeddings

### Transformers.js (`@xenova/transformers` legacy / `@huggingface/transformers` current)

- **GitHub URL:** [https://github.com/huggingface/transformers.js](https://github.com/huggingface/transformers.js)
- **License:** Apache-2.0
- **Bun/TypeScript compatibility:** good; Bun supported.
- **COPY vs DEPEND:**
  - **COPY:** local in-process embedding adapter shape, pooling/normalization pattern, offline fallback behavior.
  - **DEPEND:** optional only for offline fallback path (not default).
- **Recommendation:** **fork pattern only** (defer direct dependency unless daemon-free requirement is strict)

### Ollama embeddings

- **GitHub URL:** [https://github.com/ollama/ollama-js](https://github.com/ollama/ollama-js) (client), [https://github.com/ollama/ollama](https://github.com/ollama/ollama) (server)
- **License:** MIT (JS client; verify exact server license on pin)
- **Bun/TypeScript compatibility:** strong fit; official JS/TS client and straightforward local HTTP.
- **COPY vs DEPEND:**
  - **COPY:** provider interface (`embed`, `embedBatch`, health checks, model pinning).
  - **DEPEND:** either keep direct `fetch` (lightest) or use `ollama` package for typed API.
- **Recommendation:** **adopt**

## 4) GPTCache / semantic-cache patterns

- **GitHub URL:** [https://github.com/zilliztech/GPTCache](https://github.com/zilliztech/GPTCache)
- **License:** MIT
- **Bun/TypeScript compatibility:** Python-first; TS integration generally through service mode.
- **COPY vs DEPEND:**
  - **COPY:** exact-hit first, semantic-hit second; TTL + score threshold + metadata/version-aware invalidation.
  - **DEPEND:** not recommended for Bun package.
- **Recommendation:** **fork pattern only**

## 5) LlamaIndex memory blocks patterns

- **GitHub URL:** [https://github.com/run-llama/LlamaIndexTS](https://github.com/run-llama/LlamaIndexTS)
- **License:** MIT
- **Bun/TypeScript compatibility:** patterns are portable, but this TS repo is deprecated/archived.
- **COPY vs DEPEND:**
  - **COPY:** `BaseMemoryBlock` style contracts, priority-based merge/truncation, block types (static/fact/vector).
  - **DEPEND:** skip direct dependency due to deprecation risk.
- **Recommendation:** **fork pattern only**

## 6) LangGraph checkpoint stores

- **GitHub URL:** [https://github.com/langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs)
- **License:** MIT
- **Bun/TypeScript compatibility:** strong TS ecosystem fit; official checkpoint packages for SQLite/Postgres.
- **COPY vs DEPEND:**
  - **COPY:** checkpoint tuple schema (`thread_id`, namespace, checkpoint id, pending writes), deterministic resume semantics.
  - **DEPEND:** avoid direct dependency unless adopting LangGraph runtime itself.
- **Recommendation:** **adopt (pattern), skip library for now**

---

## Actionable guidance for implementation agents

- Keep `@zintus/memory` dependency surface small and Bun-native.
- Add `sqlite-vec` for local vector search; maintain SQL visibility for debugging.
- Keep Ollama as default embedding provider and add explicit batch embedding support.
- Harden semantic cache with:
  - exact key lookup,
  - compiled-context hash lookup,
  - semantic similarity fallback,
  - threshold + TTL + model/version metadata checks.
- Implement internal memory blocks and checkpoint tables inspired by LlamaIndex/LangGraph patterns, not framework-coupled.

## Top 3 integrations to implement this week

1. **Integrate `sqlite-vec` retrieval path**
   - Add vector table migration and SQL search path.
   - Replace candidate scan with vector query + threshold in semantic cache.

2. **Upgrade Ollama embedding adapter**
   - Use `/api/embed` and implement `embedBatch()`.
   - Persist `provider`, `model`, `dimensions` metadata for cache validity checks.

3. **Add internal memory-block + checkpoint primitives**
   - Implement `StaticProfileBlock`, `FactSummaryBlock`, `VectorRecallBlock`.
   - Add priority-based context assembly and lightweight SQLite checkpoint tables.

## Final recommendation snapshot

- **Adopt:** `sqlite-vec`, Ollama local embeddings, LangGraph checkpoint schema patterns.
- **Fork pattern only:** Mem0 architecture, GPTCache cache policies, LlamaIndex memory blocks, Transformers.js fallback design.
- **Skip:** `sqlite-vss`, deprecated LlamaIndexTS runtime, direct GPTCache dependency in Bun memory package.
