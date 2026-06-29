# Advocate A — Harden the Loop, Don't Orchestrate

**Position:** KEEP Zintus's single-writer ReAct agent. Spend the entire complexity
budget *inside* the loop — context discipline, in-loop verification, edit-format
robustness, and a local repo-map — not on multi-agent orchestration.

Ground truth: `docs/audit/2026-06-29/agentic/00-current-architecture.md` (the loop)
and `docs/audit/2026-06-29/agentic/01-research-sota.md` (the survey). Code on
`feat/zintus-10-10`: the loop is `runAgentToolLoop` at
`apps/cli/src/lib/agent-tools.ts:1268`; driver `apps/cli/src/commands/agent.ts:runAgent`.

---

## 1. The thesis, and why the evidence is on its side

The central claim of the multi-agent camp is that *parallelism + role specialization*
buys reliability. The benchmark record says the opposite for the part that matters —
**the edit itself.** Read doc 01 §2.8 honestly and the attribution is unambiguous:

- **SWE-agent** went from 3.8% → 12.5% on SWE-bench by *redesigning the
  Agent-Computer Interface* — LLM-shaped commands, bounded outputs, edit-time lint —
  with **one agent and no orchestration** (doc 01 §2.8, arXiv 2405.15793). The ACI
  *is* the contribution.
- **Agentless** beat a pile of agents on SWE-bench Lite at **~$0.70/task** with *no
  agent at all* — a fixed localize→repair→validate pipeline whose secret sauce is
  **test filtering + majority vote**, i.e. verification discipline (doc 01 §2.8,
  arXiv 2407.01489).
- **mini-SWE-agent** — a deliberately tiny bash-only single-agent loop — sits on the
  leaderboard. That is the cleanest possible control experiment: strip the
  scaffolding to nothing and a good model + good tools is still competitive (doc 01
  §2.8).

Doc 01 §2.2 states the reconciliation in plain terms: **Anthropic and Cognition
actually agree on the shape that works — one writer, many read-only explorers.**
Anthropic's own multi-agent win (+90.2%) is on a *breadth-first research* eval, costs
**~15× the tokens of chat**, and they explicitly warn it **loses** "when agents share
context or have many dependencies." Coding is the canonical high-dependency,
write-heavy task. Cognition's "Don't Build Multi-Agents" (doc 01 §2.2, §1 Devin row)
is blunt: split contexts cause **conflicting actions and compounding failure**;
multi-agent only works when **writes stay single-threaded and extra agents add
intelligence, not actions.**

So the strongest pro-multi-agent source and the strongest anti- source **both** tell
you: don't add a writer. And the SWE-bench record says the reliability you're chasing
lives in interface quality + in-loop verification + context discipline. That is a
to-do list of *loop-internal* work. Zintus has **zero** of the top three (doc 00 gaps
#1, #2, #5) and a single subagent (gap #3) is ranked *below* all of them in doc 01 §3.

**Conclusion:** orchestration is the expensive, fragile lever with the weakest
real-repo evidence. The cheap, well-evidenced levers are unbuilt. Build those.

### Why this is doubly true for *Zintus specifically*

1. **No-custody local CLI.** A token-15× orchestration tax lands directly on the
   user's BYOK bill (doc 00 constraints; doc 01 §2.2). Every other agent that runs
   swarms is venture-subsidized or cloud-metered. Zintus is not.
2. **The router already gives you the *good* part of multi-agent for free.** The one
   genuine reason to want multiple agents is **model heterogeneity** — cheap model
   for triage, strong model for the hard call (Amp's Oracle, Aider architect/editor).
   Doc 01 §2.7 is explicit: model-tiering is **native and nearly free** for Zintus
   because of the router, and *impossible* to do cheaply for single-vendor agents.
   You can put a 7B on search and a frontier model on the edit **inside one context,
   one writer** — capturing the heterogeneity benefit without paying the
   split-context reliability tax. Orchestration would be re-buying, at 15× cost, a
   capability the router hands you for one `route()` call.
3. **Honesty bar (doc 00).** "No claimed capability without a real, tested path."
   A verify→revise controller is *trivially* testable (deterministic: feed canned
   failing output, assert a revise round fires). A multi-writer swarm's correctness
   is emergent and nearly untestable. The harden-loop list is the one that can clear
   Zintus's own honesty gate.

---

## 2. Build-now list — ranked by impact × feasibility, scoped to THIS codebase

The loop today (`agent-tools.ts:1268`) does exactly one thing well: append assistant
turn + tool_results to `convo` and re-route until no tool calls (lines 1308–1325).
Everything below wraps or extends that spine without forking it.

### #1 — Context compaction + tool-result eviction *(the #1 lever; build first)*
- **What:** `convo` (`agent-tools.ts:1276`) grows unbounded — preamble + every
  assistant turn + every `tool_result` (lines 1308–1325), capped only by `maxRounds`
  (15, hard cap 40, line 1272). This is the hard ceiling on every long task and the
  worst current gap (doc 00 #1; doc 01 §2.3, §3.1). Two parts:
  - **Tool-result eviction/budgeting:** cap each tool output (`read_file` already has
    `MAX_FILE_BYTES`=1MiB at line 70 — far too large to keep in *history*). When a new
    `read_file`/`search_code`/`run_command` result lands, replace older large results
    in `convo` with a one-line pointer ("[evicted: read_file src/x.ts:1-400 — re-read
    if needed]"). Pure bookkeeping over the existing `results.push`/`convo.push`.
  - **Compaction:** when estimated tokens cross a threshold, summarize the older half
    of `convo` via `handlers.route` on a **cheap** model and reinitialize with the
    summary + the live tail (Claude Code's `/compact`, doc 01 §2.3).
- **Scope:** ~1 module (`context-compactor.ts`) + a hook in the loop between rounds in
  `runAgentToolLoop`. The loop already centralizes all `convo` mutation in one place,
  so this is a localized wrap, not a rewrite. **Router exploit: yes** (cheap
  summarizer). Highest impact, fully CLI, no GUI/cloud. **Hardest to get *right*:**
  see §3 — fidelity of summarization is the real risk.

### #2 — Test-gated verify→revise controller (Reflexion-lite)
- **What:** `run_command` exists (`agent-tools.ts:1110`, allowlisted
  test/typecheck/lint/build, argv-only, confirm-gated, run-budget 10) but is
  **model-discretion, not a controller** (doc 00 #2; doc 01 §2.6, §3.2). Promote it:
  after a mutation round (write_file/apply_edit), if `--allow-run` is on, the
  *controller* runs the project's verify command, and on a non-zero exit feeds the
  captured failure back deterministically with an instruction to fix, for a **bounded**
  number of revise rounds (e.g. 2–3) before surfacing failure.
- **Evidence + honesty:** Reflexion is **+11% HumanEval / +22% AlfWorld** but *hurt*
  MBPP and *failed* WebShop — it only helps with a **clear gradable signal** (doc 01
  §2.1). Coding's gradable signal is tests/typecheck — exactly our case. So gate the
  revise loop strictly on a real exit code; never reflect on vibes.
- **Scope:** a controller wrapper around the edit phase in `runAgent`
  (`commands/agent.ts`), reusing the existing `run_command` plumbing, accounting, and
  the end-of-run verify (doc 00 safety). ~150–250 LOC. **Router exploit: yes** (cheap
  model triages the error, strong model writes the fix). The cheapest reliability win.

### #3 — Edit-format fallback ladder + failed-edit recovery
- **What:** `apply_edit` (`agent-tools.ts:929`, exact-unique old_string, unified-diff
  preview) **errors back to the model** on a non-unique/missing anchor with no
  fallback (doc 00 #5; doc 01 §2.5). Aider's unified-diff evidence is load-bearing:
  search/replace → unified diff took a refactor score **20%→61% and cut lazy output
  3×** (doc 01 §2.5). Build the ladder: on a failed `apply_edit`, (a) **re-show the
  model the current file region** around the intended anchor, then (b) fall back
  search-replace → **unified-diff applier** → whole-file rewrite.
- **Scope:** wrap `gatedWrite`/`apply_edit` with a retry/fallback path + a new
  unified-diff applier. ~200–300 LOC; the diff applier is the bulk. **Router:**
  optional cheap re-apply. CLI-native, directly closes gap #5.

### #4 — Local tree-sitter + PageRank repo-map in the system prompt
- **What:** no persistent repo-map today (doc 00 #4); the model rediscovers structure
  via tools every run. Aider's recipe — tree-sitter symbols → **PageRank** on the
  reference graph → token-budgeted ranked map — gives a structural prior with **no
  embeddings, fully local** (doc 01 §2.4, §3.4). Inject at session start in `runAgent`.
- **Honest scoping note from the code:** `@zintus/codebase-indexer` is today
  **parser-free** — `chunker.ts` uses a regex symbol heuristic
  (`/^\s*(export\s+)?...(function|class|interface|...)\b/`), `code-index.ts` does
  lexical/embedding chunk ranking. There is **no tree-sitter and no symbol graph
  yet.** So this is genuinely new: add a tree-sitter dep + symbol-reference extraction
  + a PageRank pass. **Feasibility hedge:** a v0 "grep-based repo-map" reusing the
  existing regex symbol detector (no graph, just ranked declarations by file) is ~a
  day and captures most of the first-shot-navigation win; the tree-sitter+PageRank
  upgrade is the v1. Ship v0 first. **Router: neutral.**

### #5 — Persistent scratchpad / NOTES.md (agentic memory)
- **What:** a memory tool the agent writes progress/decisions to, persisted *outside*
  `convo` so it survives compaction (#1) and cold starts (doc 00 #6; doc 01 §3.7).
  Small, but it is the natural complement to #1 — compaction throws away history;
  NOTES.md is where the agent deliberately keeps what must survive.
- **Scope:** one tool (`note`/`read_notes`) + load-on-start, modeled on the existing
  `update_plan` advisory-state tool (doc 00). ~100 LOC. **Router: neutral.** Build
  *with* #1 since they're two halves of one context strategy.

**Deliberately sequenced:** #1 first (it's the ceiling and #5 depends on its
threshold logic), then #2 (cheapest reliability), #3 (edit robustness), #4 v0, #5.

---

## 3. Honest weaknesses of my own position

I will not pretend the single-context loop is free of real costs:

1. **Huge repos genuinely break a single context.** The repo-map (#4) and grep mitigate
   but don't eliminate it: a 2M-LOC monorepo where the relevant files are spread across
   ten packages is a case where the model burns the whole window just locating things.
   Here the *isolated read-only explorer subagent* (doc 01 §3.3) is a real win I'm
   deferring, not denying — it keeps the main writer's context lean by returning only a
   summary. My claim is narrower: it's **#3-priority behind the unbuilt context/verify
   levers**, not that it's worthless.
2. **Parallel exploration is a true latency loss.** When a task needs three independent
   investigations (e.g. "how is auth done in web vs cli vs the indexer"), a single
   context does them serially. Fan-out read-only subagents would be faster. I'm betting
   that for a *local CLI* wall-clock-vs-reliability favors serial-but-correct, but it is
   a real tradeoff, not a non-issue.
3. **Compaction (#1) is the hardest of my own list to get right.** Summarize-and-
   reinitialize can silently drop the one fact the agent needed three steps later;
   bad compaction degrades a long task *worse* than hitting the context limit (which at
   least fails loudly). Mitigations: keep a verbatim live tail, never compact the
   system/task preamble, pair with NOTES.md (#5) so critical state lives outside the
   summarizable region, and gate it behind a token threshold so short tasks never
   compact. But the failure mode is real and must be tested adversarially.
4. **Reflexion-lite (#2) can loop on a non-gradable failure.** If the verify command is
   flaky or the failure isn't actually fixable by the model, a bounded revise loop burns
   rounds and tokens. The bound (2–3) and strict exit-code gating are the guardrails;
   doc 01 §2.1's MBPP/WebShop caveat is the warning I'm heeding.

---

## 4. What I'd defer, and what I'd reject outright

**Defer (good, but after the loop-internal wins):**
- **Read-only explorer subagent w/ isolated context** (doc 01 §3.3). The *one* form of
  multi-agent the evidence endorses (single-writer preserved, Anthropic isolation win +
  Cognition single-writer rule both satisfied). I defer it only because gaps #1/#2/#5
  are higher impact×feasibility and unbuilt — not because it's wrong. It's the **next**
  thing after this list.
- **Model-tiered plan→execute** (doc 01 §3.5) — the router's flagship exploit. I'd fold
  the *tiering* into #1/#2 immediately (cheap summarizer, cheap error-triage) but defer
  a full re-plan-on-failure plan→execute controller until the verify loop exists to
  catch the failures it would re-plan against.
- **Local-embeddings (Ollama) large-repo upgrade** — keep as the optional escalation
  behind grep + repo-map (#4), per doc 01 §2.4.

**Reject for the CLI surface (doc 01 §3 "does NOT fit" list):**
- **Multi-*writer* swarms (parallel editing agents):** Cognition says fragile for code;
  Anthropic's 15× token cost makes it a non-starter on a BYOK bill. Hard no.
- **Hosted embedding index (Cursor/Turbopuffer):** violates no-custody (doc 00). Only
  local-Ollama embeddings are admissible, and only as an opt-in.
- **Tree/Graph-of-Thoughts:** token-heavy, weak real-repo evidence (doc 01 §2.1). Use
  test-gated self-consistency instead, and only behind a `--thorough` flag.
- **Dedicated fast-apply model (Morph):** a GUI win; in-CLI it needs a router-hosted
  apply model + a second call per edit. Defer behind the #3 fallback ladder.
- **Cloud/async background-agent fleets, browser/computer-use, auto-PR bots:** wrong
  surface for a local CLI.

**What the other camps get right (conceded):** the orchestration camp is correct that a
single context *does* hit a wall on huge repos and *does* serialize parallel
exploration — and that **isolated read-only explorers** are a real, evidence-backed
fix. The plan-execute camp is correct that the router makes model-tiering Zintus's
unique structural edge. My disagreement is purely about **ordering and which form**:
do the loop-internal, well-evidenced, cheaply-testable work first; add exactly one
read-only explorer subagent next; never add a second writer.

---

## Summary (6 lines)

1. SWE-bench's top scorers credit interface quality, in-loop test verification, and context discipline — **not** orchestration (SWE-agent ACI 3.8→12.5%, Agentless $0.70/task, mini-SWE-agent); doc 01 §2.8.
2. The pro- and anti- multi-agent camps **agree**: one writer, many read-only explorers — and Anthropic's swarm win is read-heavy research at 15× tokens, a non-starter for a no-custody BYOK CLI.
3. Zintus's router gives the *only* real multi-agent benefit (model heterogeneity) for free, inside one context — so orchestration would re-buy at 15× what `route()` already offers.
4. Build-now, ranked: (1) context compaction + tool-result eviction, (2) test-gated verify→revise controller, (3) edit-format fallback ladder, (4) local repo-map (v0 grep-based, v1 tree-sitter+PageRank), (5) NOTES.md scratchpad — all wrap the existing `runAgentToolLoop` (`agent-tools.ts:1268`).
5. Honest weaknesses: huge repos and parallel exploration genuinely favor an isolated explorer subagent (deferred, not denied), and compaction is the hardest of my own list to get right (can silently drop state).
6. Defer the single read-only explorer subagent + plan→execute to *next*; reject multi-writer swarms, hosted embeddings, and ToT outright.
