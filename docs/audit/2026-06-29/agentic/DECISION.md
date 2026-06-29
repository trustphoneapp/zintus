# DECISION — Zintus agent architecture (Judge / Advocate D, 2026-06-29)

Verdict, sequenced build-now spec, and defer/reject. Ground truth verified against
code on `feat/zintus-10-10` (not taken on the advocates' word — see §0).

---

## 0. What I verified in the code (so the rest is trustworthy)

| Claim | Verified | Evidence |
|---|---|---|
| Single-writer bounded ReAct loop; `convo` unbounded | **TRUE** | `agent-tools.ts:1268` `runAgentToolLoop`; `convo = [...messages]` at `:1276`; all growth centralized in `convo.push` at `:1308–1325`; bounded only by `maxRounds` (`:1272`). One clean wrap point. |
| The agent **never sets a routing strategy** — the moat is unused by the agent | **TRUE (and damning)** | `agent.ts:277–284` calls `engine.routeAndStream({messages, mode, tools})` with **no `strategy`**. Tiering is sitting on the floor unused. |
| Per-call tiering is a one-field change, zero engine work | **TRUE** | `RouteRequest.strategy` (`packages/types/src/route.ts:246`), honored as `request.strategy ?? strategy` (`packages/router/src/factory.ts:448`), enum `fastest\|capability\|economy\|quality\|balanced` (`packages/types/src/config.ts:3`). |
| `apply_edit` errors back with no fallback on 0/>1 match | **TRUE** | `agent-tools.ts:962–967` returns `err(...)` on not-found / non-unique; no diff fallback, no region re-show. |
| `update_plan` is advisory render-only; verify is model-discretion | **TRUE** | doc-00 §Tools; nothing reads `ctx.plan` back; `run_command` is invoked only if the model chooses. |
| `codebase-indexer` has **no** tree-sitter / PageRank | **TRUE** | `packages/codebase-indexer/src/chunker.ts:10` "No tree-sitter… (that is a future v2)"; regex `DECLARATION_RE` at `:31`. |
| Executor runs tool calls **sequentially** | **TRUE** | `agent-tools.ts:1302` `for (const c of calls)`. So no parallel exploration exists (B's "v2" caveat is honest). |

**The decision-changing discovery the advocates all missed:** there is an existing,
**unwired** in-repo workspace package **`tokzen`** (`packages/tokzen`, workspace name
`tokzen`) built for *exactly* build-now #1. It exports `manageContext`
(rolling-window history that keeps tool_use+tool_result pairs atomic —
`src/transforms/context-manager.ts`), `compress`/`compressCode`/`compressDiff`/`compressLog`/`compressJSON`
(per-tool-output compressors), a **CCR store + `retrieve` tool** (the evict-with-a-pointer
pattern, `src/ccr/`), `countTokensFast` (the threshold), and a `CacheAligner` that
stabilizes the system prefix and injects provider `cache_control`. It is **not** a
dependency of `apps/cli` and is **used nowhere** in `cli`/`engine` (grep: zero hits).
This means the #1 lever is *far* smaller and lower-risk than Advocate A scoped it: we
wire an existing, tested package instead of writing a compactor from scratch.

---

## 1. Verdict: the current architecture is the right SPINE. Do not replace it.

**Keep the single-writer bounded ReAct loop. Change nothing about its shape. Spend the
whole complexity budget hardening it from the inside.**

The evidence is one-directional (doc-01 §2.8): SWE-agent's jump (3.8→12.5%) was *interface
quality*, Agentless wins at ~$0.70/task on *test-filtering + majority vote*, and
mini-SWE-agent — a tiny single-agent bash loop — is on the leaderboard. Both poles of the
multi-agent debate converge on **one writer, many read-only explorers** (doc-01 §2.2), and
Anthropic's own swarm win is read-heavy research at **~15× tokens** — a non-starter on a
no-custody BYOK bill. **Advocate A wins the framing.** Orchestration is the expensive,
fragile, weakly-evidenced lever; the cheap, well-evidenced levers (context discipline,
deterministic verification, edit robustness) are entirely **unbuilt**.

Two refinements to A's position, settling the disagreements:

- **Advocate C is right on the one thing A is soft on:** verification must be *deterministic*,
  not model-discretion. But C's own honest self-critique is decisive — build the **verify→revise
  gate**, and **reject the rigid plan state-machine** (C concedes it's "negative value" against a
  strong model). So C contributes a gate, not a controller framework.
- **Advocate B is right that the router moat is Zintus's only un-copyable edge, and that the
  agent embarrassingly doesn't use it** (verified: no `strategy` set anywhere). But B's *explorer
  subagent* is correctly **deferred**: B concedes it "rides on context management it doesn't
  provide" and is below the unbuilt context/verify levers. We **harvest B's tiering insight now**
  (nearly free) and **defer B's subagent** to next.

So: not "keep current + 2 small wins" — the loop is genuinely under-built — but emphatically
**not** an architecture replacement. It's **harden the spine, in this order.**

---

## 2. Build-now plan (ordered implementation spec)

Every item wraps or extends `runAgentToolLoop` (`agent-tools.ts:1268`) and the driver
`runAgent` (`commands/agent.ts`). Every model call still flows through `route()` — **no item
hardcodes a model**, so the moat is preserved throughout. Sizes: S ≈ ≤½ day, M ≈ 1–2 days,
L ≈ 3+ days.

### B1 — Context management via `tokzen` *(M — the #1 lever; build first)*
- **What:** Add `tokzen` as an `apps/cli` workspace dep. In `runAgentToolLoop`, between rounds
  (right where `convo.push` happens, `:1308–1325`): (a) **tool-result eviction** — wrap large
  `read_file`/`search_code`/`run_command` results with `compressCode`/`compressJSON`/`compressLog`
  and register the full text in the CCR store, leaving a one-line pointer + the `tokzen` `retrieve`
  tool so the model can pull it back on demand; (b) **compaction** — when `countTokensFast(convo)`
  crosses a threshold, run `manageContext` (it keeps tool pairs atomic) over the *older* half,
  **never** the system/task preamble, and **keep a verbatim live tail**.
- **Why:** doc-00 gap #1, doc-01 §2.3/§3.1 — "the biggest single fix," the hard ceiling on every
  long task. De-risked from L→M because `tokzen` already exists and is tested (§0).
- **Moat/honesty/bounds:** the CacheAligner keeps provider prompt-caching intact across compaction;
  pointer+`retrieve` is honest (nothing silently vanishes — it's re-fetchable); gated behind a token
  threshold so short tasks never compact. Adversarial test required (see risks).

### B2 — Harvest the router moat: plumb a per-call strategy seam *(S — nearly free; do alongside B1)*
- **What:** Today every agent call is strategy-less (`agent.ts:277–284`). Thread an optional
  `strategy` through the route closures so (a) the **writer** uses the user's configured
  `config.routingStrategy` (do **not** silently force "quality" over a user's "fastest" — honesty),
  and (b) **internal/auxiliary** calls (B3's error-triage, and the deferred explorer) can request
  `strategy:"economy"`. One field on the route call; the router still picks best/cheapest across 12
  providers *within* the tier (`factory.ts:448`).
- **Why:** doc-01 §2.7 — model-tiering is the one place Zintus can *lead*, not match; it's currently
  unused. This is the seam that makes "cheap model for triage, strong for the edit" real.
- **Moat/honesty/bounds:** never overrides an explicit user `provider`/`model`/global strategy
  (`route.ts:234–246`); surfaced in the existing route-reason line (`engine.ts:167`).

### B3 — Test-gated verify→revise controller (Reflexion-lite) *(M — the cheapest reliability win)*
- **What:** A wrapper in `runAgent` around the edit phase. After a round that ran a mutating tool
  (`isMutatingTool`, `agent-tools.ts:1197`), **if `--allow-run`**, the *controller* (not the model)
  runs the project verify command via the existing `run_command` allowlist/budget; on non-zero exit,
  feed back `{unified diff so far, command, stderr, exit code}` and re-enter the inner loop for a
  **bounded** `MAX_REVISE = 2` revise rounds; on exhaustion mark **blocked** and surface to the user —
  never silently advance.
- **Why:** doc-00 gap #2, doc-01 §2.6, C's strongly-supported half. Reflexion pays **only** on a
  gradable signal (+11% HumanEval / +22% AlfWorld) and *hurts* on fuzzy ones (MBPP/WebShop) — so the
  gate fires **only** on a real exit code, never on vibes.
- **Moat/honesty/bounds:** error-triage can route `economy` (B2), the revise routes the writer's tier;
  reuses run-budget 10 + 120s timeout + 16KiB cap; bounded + surfaced (honesty bar). **Build the gate,
  not a plan state-machine** (see Defer).

### B4 — Edit-format fallback ladder + failed-edit recovery *(M — diff applier is the bulk)*
- **What:** Wrap `apply_edit` (`agent-tools.ts:962`). On 0/>1 match, instead of bare `err`: (a) **re-show
  the model the current file region** around the intended anchor, then (b) fall back search/replace →
  **unified-diff applier** → whole-file rewrite, all through the existing `gatedWrite` confirm path.
- **Why:** doc-00 gap #5, doc-01 §2.5 — Aider's load-bearing number: search/replace → unified diff took
  a refactor score **20%→61%** and cut lazy output 3×.
- **Moat/honesty/bounds:** still confirm-gated + mutation-budgeted; re-apply can route `economy` (B2).

### B5 — `NOTES.md` scratchpad (agentic memory) *(S — build with B1)*
- **What:** A `note`/`read_notes` tool modeled on `update_plan`, persisting outside `convo`; load-on-start.
- **Why:** doc-00 gap #6, doc-01 §3.7 — the deliberate place critical state survives B1's compaction and
  cold starts. Two halves of one context strategy; ship together.

### B6 — Repo-map v0 (grep-based ranked declarations) *(S)*
- **What:** Reuse the existing `DECLARATION_RE` (`chunker.ts:31`) to emit a token-budgeted ranked list of
  top-level symbols by file, injected into the system prompt at session start in `runAgent`. **No graph,
  no tree-sitter** in v0.
- **Why:** doc-00 gap #4, doc-01 §2.4/§3.4 — most of the first-shot-navigation win for ~a day. The
  tree-sitter+PageRank v1 is deferred (and, usefully, `tokzen` already ships `web-tree-sitter` AST
  signature extraction that v1 can borrow — §0).

**Sequence:** B1+B2 together (context + the tiering seam), then B5 (its memory complement), then B3
(deterministic reliability), then B4 (edit robustness), then B6 (navigation). B1 is the gate to everything.

---

## 3. DEFER (valuable; not now — with the promotion trigger)

- **Read-only explorer subagent w/ isolated context (Advocate B's core).** The *correct* form of
  multi-agent (single-writer preserved). B's own design is clean — recurse `runAgentToolLoop` with a
  read-only tool filter, share `ctx.sandbox`+`ctx.semantic`, isolate `convo`, structural write-refusal,
  spawn budget 3, route `economy` (B2 makes this trivial). **Defer because** B concedes it "rides on
  context management it doesn't provide" and is below the unbuilt levers. **Trigger:** B1 shipped **and**
  telemetry shows real runs blowing the context budget on *exploration* (large/multi-package repos). It
  is the **next** thing after this list.
- **Plan controller / cursor (Advocate C's optional half).** **Trigger:** B3 telemetry shows multi-step
  tasks failing mid-sequence in ways a re-plan (not just revise) would catch. Keep it lightweight and
  default-off if ever built.
- **Tree-sitter + PageRank repo-map v1 (powered by `tokzen`'s `web-tree-sitter`).** **Trigger:** B6 v0
  proves navigation value and large repos show the regex map is too coarse.
- **Parallel explorer executor (`Promise.all` independent read-only calls).** **Trigger:** explorer
  shipped and serial latency is measured as the bottleneck.
- **Opt-in self-consistency on risky patches (`--thorough`).** **Trigger:** B3 exists (it provides the
  test filter) and users hit hard refactors. Fan candidates across cheap providers via the router.
- **Local-embeddings (Ollama) large-repo upgrade.** Already optional; keep as the escalation behind B6.

---

## 4. REJECT (doesn't fit a no-custody CLI) — one line each

- **Multi-*writer* swarms (parallel editing agents)** — fragile for interdependent code (Cognition); 15×
  tokens on a BYOK bill (Anthropic).
- **Hosted embedding index (Cursor/Turbopuffer)** — violates no-custody; cloud vector store.
- **Tree/Graph-of-Thoughts search** — token-heavy, weak real-repo evidence; use test-gated self-consistency.
- **Dedicated hosted fast-apply model (Morph) as default** — second model call per edit; the B4 ladder covers it.
- **Cloud/async background-agent fleets, browser/computer-use, auto-PR bots** — wrong surface for a local CLI.
- **A rigid plan/workflow state-machine framework** — Advocate C's own verdict: negative value against a
  strong model; build the verify *gate*, not the machine.

---

## 5. The single most important change + the smallest first slice

**Most important change: context management (B1)** — it is the hard ceiling on every long task, and it is
uniquely de-risked because `tokzen` already exists, unwired, in the repo.

**Smallest first slice that proves the new architecture:**
1. Add `tokzen` dep to `apps/cli`; in `runAgentToolLoop`, gate on `countTokensFast(convo)` past a threshold.
2. **Tool-result eviction first** (simpler than full compaction): on a new large `read_file`/`run_command`
   result, store the full text in the CCR store and replace older large results in `convo` with a pointer;
   register `tokzen`'s `retrieve` tool so the model can re-fetch.
3. One adversarial test (mirroring `agent-loop.integration.test.ts`): a synthetic long convo past threshold
   gets compacted, the **system/task preamble and the verbatim live tail survive**, an evicted result is
   retrievable via the pointer, and total tokens drop below the cap.

That slice alone lifts the ceiling that bounds every other improvement, runs entirely in-CLI/local, exploits
no model lock-in, and is fully testable — clearing Zintus's own honesty bar. Land it, then turn on the B2
tiering seam in the same PR series.
