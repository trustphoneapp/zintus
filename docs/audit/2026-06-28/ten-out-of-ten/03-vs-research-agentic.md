# 03 — Zintus vs Perplexity (Research) & Cursor (Agentic Coding) + the Moat

Brutal, from-disk benchmark. Branch `feat/zintus-10-10`. READ-ONLY audit — no code
changed. Scores are 1–10 with the explicit gap-to-10. **No claim here exceeds what
the code on disk does**, and nothing credits an unrun or key-gated path.

Benchmarks:
- **Research** → Perplexity Deep Research (multi-pass decompose → search hundreds of
  sources → cross-verify → cited synthesis; 93.9% SimpleQA; citations assigned during
  context assembly, not retrofitted).
- **Agentic coding** → Cursor 2.0 (Composer agent: whole-repo semantic index, autonomous
  multi-file coordinated edits, terminal execution, test/verify loop, IDE surface).

---

## A. Deep Research — Zintus vs Perplexity

### What Zintus actually has (verified)
- **Orchestrator** `packages/search/src/deep-research.ts`: `decompose → parallel
  sub-search (1/3/5 by depth) → dedupe by URL → streamed synthesis → cited `done`
  event`. Clean async-generator event stream (`queries`, `search_start/complete`,
  `synthesizing`, `answer_chunk`, `done{sources}`).
- **Gateway** `/v1/research` (`apps/gateway/src/handler.ts:1467+`, route `:2006`): wires
  the engine as `decompose`/`synthesize` and the search providers as `search`, streams
  over SSE, propagates client-disconnect aborts to all upstream calls, scrubs keys from
  error text. Real, production-shaped.
- **Search providers** `packages/search/src/router.ts` + `providers/`: native strategies
  (groq-compound, gemini-grounding, openrouter-tool) **plus** external fallback
  Tavily → Serper with quota-aware failover (`runFallbackSearch`).
- **Web UI** `apps/web/app/(app)/research/page.tsx`: genuinely polished — depth picker,
  live stepper (planned angles → per-source progress → synthesizing), inline numbered
  citation chips by hostname, a "N sources cited" list, copy / download `.md` /
  "continue in chat", consent gate before any provider send. This is the strongest
  surface and is close to Perplexity's UX shell.
- **CLI** `zintus research` (`apps/cli/src/commands/research.ts`): same orchestrator +
  engine in-process, streams plan/searches/synthesis, prints a `Sources:` list, `--json`.

### Where it is honestly weaker than Perplexity
- **Depth is a fixed 1/3/5 sub-queries**, single pass. No iterative deepening, **no
  cross-verification / conflict-flagging**, no reliability/uncertainty notes. Perplexity
  reads *hundreds* of sources and double-checks conflicting claims; Zintus reads ≤5
  searches × `maxResults: 5` ≈ ≤25 raw hits, deduped.
- **Citations are model-emitted inline `[n]`**, instructed by a system prompt — *not*
  structurally guaranteed/aligned to the gathered sources the way Perplexity assigns
  them during context assembly. Source list is real; the inline `[n]↔source` binding is
  best-effort and can drift.
- **CLI is key-gated and, per the phase-0 audit, never actually run** — `runResearch`
  hard-exits unless `TAVILY_API_KEY`/`SERPER_API_KEY` is set. The code path is sound but
  unverified end-to-end on CLI; the matrix marks CLI deep research **🟡** for this reason.
  (Web/gateway path is the one to trust.)
- No source-quality ranking, no date/freshness weighting, no domain-authority signal, no
  follow-up "ask about this" threading beyond "continue in chat".

### Score — Research depth + citations
**Zintus: 6/10.** A real, streamed, multi-source, cited deep-research pipeline with a
genuinely good web UI — far past a toy. Gap to 10 (≈4 points): (1) iterative/multi-pass
deepening + far more sources, (2) cross-verification & conflict/uncertainty notes,
(3) structurally-bound citations (assign-during-assembly, not prompt-instructed),
(4) source ranking/freshness/authority, (5) verify the CLI path actually runs.
Perplexity ≈ 9/10 here.

---

## B. Agentic coding / codebase context — Zintus vs Cursor

### What Zintus actually has (verified)
- **Local codebase index** `packages/codebase-indexer/src/code-index.ts`: walks a repo,
  skips `node_modules/.git/dist/...`, chunks source, embeds (local Ollama
  `nomic-embed-text` with a deterministic **offline fallback** — works with no Ollama),
  stores in `~/.zintus/code.db`. Vector search via **sqlite-vec with a linear-scan
  cosine fallback** when the extension is unavailable. Idempotent (sha256+mtime). Solid,
  100% local.
- **Context compiler** `packages/context-compiler/src/compiler.ts`: token-budgeted
  context assembly with code-recall (`codeSearch`, capped ~20% of prompt budget), git-diff
  block, facts/recall/handoff, and a strong **OWASP-LLM01 untrusted-data guard** wrapping
  all code/diff/log context — better prompt-injection hygiene than most IDE assistants.
- **CLI wiring** `apps/cli/src/commands/chat.ts`: `--workspace` indexes + injects
  codebase-aware context; working **git diff is included by default**; project
  instructions folded into the turn; `--tools` loads a `ToolDefinition[]`.

### Where it is honestly weaker than Cursor — and it's a chasm
- **No agentic loop at all.** `--tools` tool calls are **printed, not executed**
  (`chat.ts:192` "the CLI does not auto-execute tools — the user runs them"). There is
  no plan→act→observe loop, no terminal execution, **no file writes/edits**.
- **No multi-file editing.** Zintus *reads* code as retrieval context; it never proposes
  or applies coordinated diffs. Cursor's whole reason for existing (Composer:
  simultaneous route+controller+test+docs edits, breaking-change propagation) is absent.
- **No IDE surface.** No editor integration, no inline apply/accept-diff, no autocomplete,
  no "run & verify" feedback loop. It's a one-shot CLI chat with code context injected.
- **Index is single-shot context retrieval**, not an agent tool the model can call
  iteratively to navigate the repo ("grep, open file, follow call sites") mid-task.

### Score — Agentic coding / codebase context
**Zintus: 3/10.** Real, local, privacy-respecting codebase retrieval + diff context +
injection-hardened context compiler — a legitimately good *RAG-over-code context layer*.
But "agentic coding" implies autonomy Zintus does not have. Gap to 10 (≈7 points):
(1) an actual agent loop with **tool execution**, (2) **file write / multi-file
coordinated edits + apply-diff**, (3) repo-navigation tools the model drives, (4) run/test/
verify feedback, (5) an editor/IDE surface. Cursor ≈ 9/10 here. This is the widest gap in
the whole benchmark — and arguably the wrong fight to pick.

---

## C. The Moat — what neither Perplexity nor Cursor has

This is where Zintus is genuinely best-in-class, and the scores invert.

### 1. Provable Tokzen compression savings (10/10)
- `packages/tokzen` compresses prompts at the gateway; `apps/gateway/src/handler.ts:1091+`
  emits **real, measured** per-request headers only when compression actually happened
  (`compressedTokens < originalTokens && ratio < 1`): `X-Zintus-Original-Tokens`,
  `-Compressed-Tokens`, `-Tokens-Saved`, `-Compression-Ratio`, `-Cost-Saved-Usd`. Not a
  marketing estimate — derived from the actual compress pass.
- **Honest:** cost-saved header is suppressed when it can't be priced. This is a provable,
  per-call savings receipt. No competitor exposes anything like it.

### 2. Free-vs-paid savings ledger (10/10)
- `packages/router/src/quota-ledger.ts:savingsUsd()`: sums successful free-tier tokens,
  **grouped per (provider, model)** so each model is valued at its own paid-equivalent
  (`paidEquivalentUsdPerMTok`) — Groq-8B ≠ 70B, OpenRouter `:free` models priced
  honestly. Persisted in sqlite, labelled an estimate in the UI. A durable "here's what
  you'd have paid OpenAI/Anthropic" ledger. Unique.

### 3. Local-first / no-custody (10/10)
- Matrix: no-custody **proven** across core/gateway/relay/web/mobile. Keys live in OS
  keychain (`@zintus/keychain`); codebase index + quota DB are local (`~/.zintus/*`,
  `chmod 600`); Ollama/LM Studio give fully-local inference with offline embedding
  fallback. Neither Perplexity (hosted SaaS) nor Cursor (cloud index + model) can claim
  this. **This is the defensible identity.**

### 4. Capability / quota / privacy-aware routing (8/10)
- `packages/providers/src/capabilities.ts`: model-keyed `vision/tools/json/structuredOutput`
  flags + per-model allowlists (`VISION_MODELS`/`TOOL_MODELS`/`JSON_SCHEMA_MODELS`),
  fail-closed gating so an image/tool/schema only reaches a capable model.
- `packages/providers/src/data-policies.ts`: per-provider training/retention/ZDR badges
  with `mayTrainOnUserData` (conservative — "unknown" counts as may-train), wired to a
  `blockTrainingProviders` privacy filter; engine emits `privacyHonored` +
  `X-Zintus-Private-Honored`.
- Quota ledger drives availability/cooldown/health/p95-latency routing across free tiers.
- **🟡 caveats (from the matrix, kept honest):** registry covers **default models only**
  (~13 priced pairs / 12 providers), not a full enumerable catalog; **no human
  route-reason** in core (router emits winner + raw trace only, `factory.ts:858`); CLI
  quota uses a **fabricated 1,000,000 denominator** (`router.ts:21`). These keep it 8, not 10.

### Moat verdict
**The savings + privacy + local-first triad is a genuine 10/10 and is differentiated —
neither competitor has it, and it can't be copied without abandoning their hosted
business model.** Capability/quota/privacy routing is a strong 8/10 held back by
catalog-breadth and the missing human route-reason. The moat is the product; research is
a credible feature; agentic coding is the weakest and most contested surface.

---

## Scorecard

| Dimension | Zintus | Benchmark | Gap to 10 | Verdict |
|---|:--:|:--:|:--:|---|
| Research depth | 6/10 | Perplexity 9 | +4 | 🟡 real pipeline, shallow vs multi-pass+verify |
| Research citations | 6/10 | Perplexity 9 | +4 | 🟡 prompt-instructed `[n]`, not structurally bound |
| Research web UX | 7/10 | Perplexity 9 | +3 | 🟢 polished, close to Perplexity's shell |
| Research CLI | 4/10 | — | +6 | 🟡 sound but key-gated / unverified end-to-end |
| Agentic coding | 3/10 | Cursor 9 | +7 | 🔴 no agent loop / edits / IDE — wrong fight |
| Codebase context layer | 6/10 | Cursor 8 | +4 | 🟢 strong local RAG-over-code, no autonomy |
| **Tokzen per-call savings** | **10/10** | none | 0 | ✅ provable, measured, honest |
| **Free-vs-paid ledger** | **10/10** | none | 0 | ✅ per-model, persisted, unique |
| **Local-first / no-custody** | **10/10** | none | 0 | ✅ proven, defensible identity |
| Cap/quota/privacy routing | 8/10 | none | +2 | 🟢 strong; catalog + route-reason gaps |

## Top gaps to close (priority)
1. **Stop competing with Cursor head-on.** Either build a real agent loop (tool execution
   + multi-file apply-diff + run/verify) or reframe codebase support as "private,
   local context layer" and lean on the moat. Today's 3/10 over-promises "agentic".
2. **Research → multi-pass + cross-verification + structurally-bound citations**, more
   sources, freshness/authority ranking. That's the path from 6 to 8.
3. **Verify the CLI research path actually runs** (it's key-gated and unrun); drop or fix
   the fabricated CLI quota denominator.
4. **Surface the moat everywhere as the headline.** The savings receipt + ledger +
   no-custody are the 10/10s; route-reason generation (P0 in the matrix) makes the
   privacy/quota routing legible and pushes it from 8 to 10.

Sources:
- `packages/search/src/deep-research.ts`, `packages/search/src/router.ts`,
  `packages/search/src/providers/*`
- `apps/gateway/src/handler.ts` (research `:1467+`/`:2006`, savings headers `:1091+`)
- `apps/web/app/(app)/research/page.tsx`
- `apps/cli/src/commands/research.ts`, `apps/cli/src/commands/chat.ts` (`:192` no auto-exec)
- `packages/codebase-indexer/src/code-index.ts`, `packages/context-compiler/src/compiler.ts`
- `packages/router/src/quota-ledger.ts` (`savingsUsd`), `packages/router/src/factory.ts`
- `packages/providers/src/capabilities.ts`, `packages/providers/src/data-policies.ts`
- `docs/audit/2026-06-28/phase0/MATRIX.md`
- Perplexity Deep Research: https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research ·
  https://ziptie.dev/blog/how-perplexity-ai-answers-work/ ·
  https://www.datastudios.org/post/perplexity-ai-deep-research-how-it-works-limitations-and-use-cases-for-professionals
- Cursor 2.0 agent / Composer: https://cursor.com/changelog/2-0 ·
  https://cursor.com/blog/agent-best-practices ·
  https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide
