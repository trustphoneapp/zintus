# State of the Art in Agentic Coding Architectures (research survey, 2026-06-29)

Purpose: inform a redesign of the Zintus CLI coding agent. Baseline being judged
against is `00-current-architecture.md`: a **single-agent bounded ReAct loop**,
local-first, no-custody, BYOK, whose unique moat is a **multi-provider ROUTER**
(every model call can go to the best/cheapest of 12 providers — model-tiering is
nearly free, unlike single-vendor agents).

Sourcing note: this is mid-2026 and many secondary "2026 guide" pages and some
arXiv IDs surfaced in search are speculative or auto-generated (and a few cite
unverifiable future model names / leaderboard numbers). This survey deliberately
anchors on **primary** sources — vendor engineering blogs, official docs, the
canonical papers (SWE-agent, Reflexion, Agentless, OpenHands), and Aider's own
benchmark write-ups. Where a number comes from a secondary page it is flagged.

---

## 1. System comparison table

| System | Loop shape | Context strategy | Codebase strategy | Edit format | Verification | Multi-agent? |
|---|---|---|---|---|---|---|
| **Claude Code** (Anthropic) | ReAct loop: *gather context → act → verify → repeat*; explicit TODO planning | 5-layer compaction (tool-output budgeting, snip, microcompact, context-collapse, auto-compact summarization); structured note-taking (TODO / NOTES.md); on-demand tool-schema loading | **Agentic search ("just grep")** — bash `grep`/`tail`/filesystem over semantic indexing | Surgical string-replace + diff preview | Rules-based (lint/typecheck), visual (screenshots), optional LLM-as-judge | **Yes** — `Task`/subagents with *isolated* context windows that return only summaries; transcripts stored separately so main compaction doesn't touch them |
| **Cursor** (Composer/Agent) | Plan → multi-file edit → verify; Composer 2 is multi-agent-aware | 272k-ctx; trajectory/context pruning | **Embedding index (RAG)** — query embeddings → nearest-neighbour vs repo vectors in Turbopuffer (obfuscated paths), then read real code locally | Lazy "`// ... existing code ...`" snippet + dedicated **fast-apply** model rewrites whole file | Code review / test sub-agents in Composer | **Yes** (Composer 2 multi-agent; review/test/doc agents) |
| **Aider** | ReAct-ish; optional **architect/editor** two-model split | Repo map fit to a token budget; user curates files in chat | **Repo map**: tree-sitter extracts symbols → **PageRank** over the symbol reference graph → ranked context | Configurable: **search/replace blocks** (default), **unified diff**, whole-file, patch | Optional run-tests/lint in loop; auto-commit per edit | **No core multi-agent**, but architect (planner) + editor (applier) = 2-model pipeline |
| **SWE-agent** (Princeton) | ReAct | Windowed file viewer, bounded outputs | grep/find + special navigation commands | **ACI** purpose-built edit command w/ linting feedback on edit | Edit-time lint; run tests | No (single agent; the ACI *is* the contribution) |
| **OpenHands / OpenDevin** | Event-stream loop: Agent → Action → Observation → Agent | Event log as history | CodeActAgent executes code/bash in Docker; browser + IPython | Code actions (write files via runtime) | Run code/tests in sandboxed runtime | **Yes** — AgentHub (CodeAct, Browser, micro-agents); delegation supported |
| **Cline / Roo** | **Plan mode → Act mode** (explicit separation, human-approved) | User-added context (files/URLs/errors); `/deep-planning` writes a plan doc | User-directed + workspace errors | **Diff-based editing** (changed lines only; ~30% token saving claimed) | Errors/tests fed back; approval gate | Roo had custom-mode "personas"; (Roo shut down Apr-2026, folded toward cloud) |
| **Goose** (Block) | Rust core agent loop: plan → select tool → execute → evaluate → loop | Local; MCP-tool driven | Via MCP extensions (git/github/fs) | File-op tools via MCP | Evaluate-and-loop; runs commands | Mostly single agent; extensible via 70+ MCP extensions, recipes |
| **Amp** (Sourcegraph) | Main thread + fire-and-forget **Task** sub-agents | **Sub-agent context isolation** keeps main thread lean | Sourcegraph code search heritage | Editor edits | **Oracle** sub-agent (high-reasoning model) for review/planning | **Yes** — Oracle (reason/review), Librarian (lib research), Painter; mixes models per role |
| **Devin** (Cognition) | Long-horizon plan→execute→iterate in a sandbox VM | DeepWiki codebase docs/diagrams as durable context | **DeepWiki** auto-generated wiki + diagrams; MCP server | Editor/terminal in VM | Runs in VM, iterates against tests | **Argues AGAINST** generic multi-agent; "single-writer", extra agents add *intelligence not actions* |
| **Agentless** (baseline) | **No agent** — fixed pipeline: localize → repair → validate | N/A (hierarchical localization) | Hierarchical localization (files→class/func→lines) | Diff patches, majority-vote select | Syntax + regression-test filtering, self-consistency voting | No (deliberately) |

Sources: Claude Code / Agent SDK — [Anthropic: Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk), [Claude Code sub-agents docs](https://code.claude.com/docs/en/sub-agents), [Context management with subagents](https://www.richsnapp.com/article/2025/10-05-context-management-with-subagents-in-claude-code). Cursor — [InfoQ: Cursor 2.0 Composer multi-agent](https://www.infoq.com/news/2025/11/cursor-composer-multiagent/), [Cursor semantic search (ZenML)](https://www.zenml.io/llmops-database/enhancing-ai-coding-agent-performance-with-custom-semantic-search). Aider — [Repo map / tree-sitter](https://aider.chat/2023/10/22/repomap.html), [Repository map docs](https://aider.chat/docs/repomap.html), [Unified diffs](https://aider.chat/docs/unified-diffs.html). SWE-agent — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793), [ACI doc](https://github.com/princeton-nlp/SWE-agent/blob/main/docs/background/aci.md). OpenHands — [arXiv 2407.16741](https://arxiv.org/abs/2407.16741). Cline/Roo — [Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act). Goose — [Block announcement](https://block.xyz/inside/block-open-source-introduces-codename-goose). Amp — [Amp Owner's Manual](https://ampcode.com/manual). Devin — [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents). Agentless — [arXiv 2407.01489](https://arxiv.org/abs/2407.01489).

---

## 2. Pattern-by-pattern: the evidence

### 2.1 ReAct vs Plan-and-Execute vs Reflexion vs Tree/Graph-of-Thoughts
- **ReAct** (think→act→observe loop) is the default and what Zintus already does. Strength: adaptive, recovers from surprises. Weakness: one LLM call per step with growing history → cumulative cost/latency on long tasks ([dev.to comparison](https://dev.to/jamesli/react-vs-plan-and-execute-a-practical-comparison-of-llm-agent-patterns-4gh9)).
- **Plan-and-Execute**: front-loads planning, then executes steps without re-consulting the big model each step → cheaper/faster on multi-step work, and lets you use a **strong model to plan, cheap model to execute** ([LangChain pattern](https://medium.com/@visakhpadmanabhan7/plan-and-execute-in-langchain-handling-complexity-with-structure-b5972dbce577)). Weakness: brittle when a step fails — needs a **re-planning** mechanism or it gets stuck. This is the single most router-friendly pattern (see §3).
- **Reflexion** (self-critique → verbal feedback → retry): canonical result is **+11% on HumanEval, +22% on AlfWorld** ([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)). **Honest caveat:** it *hurt* on MBPP (80.1%→77.1%) and *failed* on WebShop — reflection only helps when there's a clear, gradable signal to reflect on. For coding, the gradable signal is **tests/typecheck**, which is exactly where reflect-and-revise pays off.
- **Tree/Graph-of-Thoughts**: largely **overhyped for coding agents**. Big token multipliers, mostly demonstrated on puzzles/math, weak evidence on real repo tasks, and hard to justify in a cost-sensitive CLI. The practical analogue that works is **self-consistency / majority-vote on patches** (Agentless), not full ToT search.

**Verdict for Zintus:** keep ReAct as the spine; add a **plan-then-execute option** and a **verify→revise (Reflexion-lite) sub-loop gated on test/typecheck output**. Skip ToT/GoT.

### 2.2 Multi-agent orchestration — the central debate
This is the most contested architectural question, and the two best primary sources disagree on purpose:

- **PRO (Anthropic, multi-agent research system):** orchestrator-worker with subagents in **isolated context windows** exploring in parallel and returning **only summaries**. Reported **+90.2% over single-agent Claude Opus 4** on an internal *breadth-first research* eval — but costs **~15× the tokens** of chat (vs ~4× for a single agent). Explicit guidance: **1 agent** for fact-finding, **2–4** for comparisons, **10+** for complex research. Critically: multi-agent wins on **parallelizable, read-heavy** tasks and **loses** when "agents share context or have many dependencies." ([Anthropic blog](https://www.anthropic.com/engineering/multi-agent-research-system))
- **CON (Cognition / Devin, "Don't Build Multi-Agents"):** for *coding* — where decisions are deeply interdependent — split contexts cause conflicting actions and compounding failure. Principles: **(1) share as much context as possible; (2) don't split decision-making that can conflict.** Their refined production stance: **multi-agent works only when writes stay single-threaded and extra agents add *intelligence, not actions*** ([Cognition blog](https://cognition.com/blog/dont-build-multi-agents)).

**Synthesis (the reconcilable truth):** the two camps actually agree on the shape that works — **one writer, many read-only explorers/reviewers.** Parallel *exploration/search/review* in isolated contexts is a robust win (Anthropic, Amp's Oracle, Claude Code's Task tool all do this); parallel *editing* is fragile. SWE-bench-grade coding does **not** need a swarm — Agentless (no agent at all) and mini-SWE-agent (a tiny single-agent bash loop) are competitive, which is strong evidence that **a single strong agent + good tools beats orchestration complexity for the edit itself**.

### 2.3 Context management
The mature toolkit (Anthropic [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):
1. **Compaction**: at the window limit, summarize the conversation and reinitialize with the summary (Claude Code `/compact`). High-fidelity, minimal degradation. **This is the #1 missing piece in Zintus** (its `convo` grows unbounded).
2. **Structured note-taking / agentic memory**: agent writes a `NOTES.md` / TODO persisted *outside* context, pulled back as needed — survives compaction and dozens of tool calls.
3. **Tool-result eviction / budgeting**: cap each tool output; evict or replace stale large outputs with a pointer. Claude Code budgets individual tool outputs and loads tool schemas on demand.
4. **Sub-agent context isolation**: the strongest lever — give a subtask its own window, return a summary. Keeps the main thread lean and is cheap if the subagent runs on a small model.
- **Retrieval over indexing** is the trend for *agents that can act*: rather than maintaining a vector index, let the agent search the live filesystem on demand. (Tension with §2.4.)

### 2.4 Codebase understanding — repo-map vs embeddings vs grep
Three live philosophies, and the evidence says **all three work, but for different reasons**:
- **"Just grep" (Claude Code / Agent SDK):** agentic filesystem search, no index to build/stale/sync. Anthropic: *"the folder and file structure becomes a form of context engineering."* Zero infra, always fresh, transparent. ([Agent SDK blog](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)) — best fit for a local CLI.
- **Repo-map (Aider):** tree-sitter symbols → **PageRank** on the reference graph → a ranked, token-budgeted map in the system prompt. Gives the model a *structural* prior without reading every file. Cheap, local, no embeddings. ([Aider repomap](https://aider.chat/2023/10/22/repomap.html))
- **Embedding index (Cursor):** semantic NN retrieval; Cursor reports **~12.5% better QA accuracy**, more on large repos ([ZenML](https://www.zenml.io/llmops-database/enhancing-ai-coding-agent-performance-with-custom-semantic-search)). But it needs an index to build, store, and keep in sync, and Cursor offloads vectors to a cloud service (Turbopuffer) — **a poor fit for no-custody local CLI** unless embeddings are local (Ollama).
- **Evidence on what actually works:** grep + a structural map is enough for top scores (Claude Code, Aider, mini-SWE-agent all eschew mandatory cloud embeddings). Embeddings add a measurable but modest edge, mostly on *large* repos and *vague* queries. **For Zintus: grep + a local repo-map is the high-leverage, low-infra answer; keep optional local embeddings (Ollama) as the large-repo upgrade.**

### 2.5 Edit application
- **Search/replace blocks** (Aider default, Zintus's `apply_edit` exact-unique): simple, robust for contiguous edits; fails on non-unique anchors or moved code.
- **Unified diff**: Aider's benchmark is the load-bearing evidence — switching GPT-4 Turbo from search/replace to **unified diff raised a refactoring score from 20%→61% and cut "lazy" output 3×** ([Aider unified diffs](https://aider.chat/docs/unified-diffs.html)). Diffs make the model treat editing as structured data.
- **Lazy snippet + fast-apply model** (Cursor/Morph): planner emits `// ... existing code ...` and a small purpose-trained model (**Morph: ~10,500 tok/s, ~98% accuracy**) stitches the full file ([Morph](https://www.morphllm.com/fast-apply-model)). Handles non-contiguous/refactor edits that diffs/patches break on. **Honest take:** great in a GUI with a hosted apply model; in a no-custody CLI you'd need a *local/router-hosted* apply model — feasible via the router, but it's a second model call per edit.
- **Error-recovery on failed edits** is where Zintus is weakest. The pattern that works: on a failed/ambiguous edit, **fall back to a different format** (search-replace → unified-diff → whole-file) and/or re-show the model the *current* file region, rather than just erroring. SWE-agent's ACI bakes lint feedback into the edit command so the model fixes immediately.

### 2.6 Verification loops
Strongest, cheapest reliability lever in all of agentic coding:
- **Run tests/typecheck/lint in the loop** and feed failures back — "rules-based feedback" (Anthropic). Zintus has the plumbing (`run_command` allowlist) but it's **model-discretion, not a controller**.
- **Self-consistency / majority vote** on candidate patches filtered by regression tests — this is *the* mechanism behind Agentless's competitive SWE-bench scores at low cost ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489)).
- **LLM-as-judge** for fuzzy criteria (no tests) — useful but adds latency; use a cheap model.
- **Lint/typecheck gating** before declaring done — cheap, deterministic, catches the majority of regressions.

### 2.7 Model tiering / routing — Zintus's structural advantage
Every multi-model pattern other agents bolt on awkwardly (Amp pairing Claude-for-speed + GPT-for-reasoning across separate contexts; Plan-and-Execute using a strong planner + cheap executor; Aider's architect/editor split) **is native and nearly free for Zintus because of the router.** Single-vendor agents *cannot* cheaply put a frontier model on planning and a 7B model on search/triage/apply. This is the one area where Zintus can be *architecturally ahead of the field*, not just at parity.

### 2.8 Benchmark signal (what top scorers attribute results to)
- **SWE-agent**: the **Agent-Computer Interface** (LLM-optimized commands, bounded outputs, edit-time lint) took SWE-bench from 3.8% (RAG) to 12.5% — *interface design, not a bigger model* ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793)).
- **Agentless**: a fixed localize→repair→validate pipeline with **majority voting** beat many agents on SWE-bench Lite at **~$0.70/task**, and >50% on Verified with Claude 3.5 Sonnet — *simplicity + self-consistency + test filtering* ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489)). OpenAI/DeepSeek adopted it for model eval.
- **mini-SWE-agent**: a deliberately tiny bash-only single-agent loop is on the leaderboard — strong evidence that **scaffolding minimalism + a good model** is competitive with elaborate orchestration ([leaderboard](https://www.swebench.com/verified.html)).
- **OpenHands**: ~77% Verified with a strong backend ([arXiv 2407.16741](https://arxiv.org/abs/2407.16741)) — a general event-stream single agent with a solid runtime.
- **Cross-cutting attribution:** top scorers credit **tool/interface quality, in-the-loop test verification, and context discipline** far more than multi-agent swarms. (Specific 2026 leaderboard *numbers* from secondary "guide" pages were inconsistent/unverifiable and are intentionally not relied on here.)

---

## 3. Highest-leverage, IMPLEMENTABLE ideas for Zintus (ranked by impact × feasibility)

Each: what it is · how it maps to Zintus · does it exploit the router moat?

1. **Context compaction + tool-result eviction** — summarize-and-reinitialize at the context limit; cap/evict large tool outputs with a pointer to re-read. *Maps:* wrap the growing `convo` in a compactor; cap `read_file`/`search_code`/`run_command` outputs. *Router:* yes — run the summarizer on a cheap model. **Biggest single fix; closes gap #1; pure CLI, no GUI/cloud.**
2. **Verify→revise controller (Reflexion-lite, test-gated)** — after edits, auto-run typecheck/test; on failure, feed the diff+errors back for a bounded revise loop instead of leaving it to the model. *Maps:* promote the existing `run_command` allowlist into a controller around the edit phase. *Router:* yes — cheap model triages errors, strong model revises. **Closes gap #2; CLI-native; the cheapest reliability win.**
3. **Read-only explorer subagent with isolated context** — a `Task`-style subagent (own window, small model) that searches/maps and returns a *summary*; main writer stays single-threaded. *Maps:* new tool spawning a child loop over read-only tools; honors Cognition's single-writer rule + Anthropic's isolation win. *Router:* yes — explorer on a cheap model, writer on a strong one. **Closes gap #3 safely (explore-only, not parallel edits).**
4. **Local repo-map (tree-sitter + PageRank) in the system prompt** — ranked symbol map within a token budget, no embeddings. *Maps:* extend `@zintus/codebase-indexer` to emit an Aider-style ranked map; inject at session start. *Router:* neutral. **Closes gap #4; fully local; high impact on first-shot navigation.**
5. **Model-tiered plan→execute pipeline** — strong model writes/maintains the plan; cheap model executes routine steps; re-plan on failure. *Maps:* generalize `update_plan` into a controller that picks the tier per phase. *Router:* **yes — this is the moat's flagship; near-free here, impossible for single-vendor agents.**
6. **Edit-format fallback ladder + better failure recovery** — on a failed/ambiguous `apply_edit`, auto-fall back search-replace → unified-diff → whole-file, and re-show the current region. *Maps:* wrap `apply_edit` with retry/fallback; add a unified-diff applier (Aider's 20%→61% evidence). *Router:* optional (cheap model for the re-apply). **Closes gap #5; CLI-native.**
7. **Persistent scratchpad / agentic memory (`NOTES.md` / TODO)** — agent writes progress/decisions to a file that survives compaction and cold starts. *Maps:* a memory tool + load-on-start; closes gap #6. *Router:* neutral. **Cheap, high-leverage for long tasks.**
8. **Self-consistency on risky patches (opt-in)** — for hard edits, generate N candidate patches, keep those that pass tests, majority-vote (Agentless evidence). *Maps:* opt-in flag around the edit phase, gated by `run_command`. *Router:* yes — fan out candidates across cheap providers. **Higher cost; reserve for `--thorough`.**

**Honest "does NOT fit a CLI / is hype" list:**
- **Hosted embedding index (Cursor/Turbopuffer style):** violates no-custody and needs cloud infra. Only the *local-embeddings (Ollama)* variant fits, as an optional large-repo upgrade — not the default.
- **Large multi-*writer* swarms (10+ parallel editing agents):** Cognition's evidence says they're fragile for code; Anthropic's 15× token cost makes them a non-starter for a cost-sensitive BYOK CLI. Restrict to read-only explorers/reviewers.
- **Tree/Graph-of-Thoughts search:** token-heavy, weak real-repo evidence — skip; use test-gated self-consistency instead.
- **Dedicated fast-apply model (Morph):** real GUI win, but in-CLI it needs a local/router-hosted apply model and a second call per edit — defer behind the format-fallback ladder (#6) unless a router-hosted apply model proves cheap.
- **Cloud/async background-agent fleets, browser/computer-use, auto-PR review bots:** GUI/cloud-shaped; out of scope for the local CLI surface.

---

## Summary

**The single biggest architectural lever: context management — compaction + tool-result eviction + structured note-taking.** Zintus's current unbounded `convo` is the hard ceiling on every long task; fixing it (idea #1, plus #7) unlocks everything else, is pure-CLI, and runs the summarizer on a cheap router model for almost nothing.

**Top ranked ideas:** (1) context compaction/eviction, (2) test-gated verify→revise controller, (3) read-only explorer subagent with isolated context (single-writer preserved), (4) local tree-sitter+PageRank repo-map, (5) **model-tiered plan→execute — the flagship exploit of the router moat**, (6) edit-format fallback ladder, (7) persistent scratchpad memory, (8) opt-in self-consistency on risky patches.

**The decisive evidence:** top SWE-bench results credit **tool/interface quality + in-the-loop test verification + context discipline**, not agent swarms (SWE-agent's ACI; Agentless's localize→repair→vote at ~$0.70/task; mini-SWE-agent's minimal single-agent loop). The multi-agent debate resolves to **one writer, many read-only explorers** (Anthropic and Cognition effectively agree). And Zintus's **router makes model-tiering — the thing every other agent bolts on awkwardly — native and nearly free**, which is the one place it can lead the field rather than match it.

Doc written to `docs/audit/2026-06-29/agentic/01-research-sota.md`.
