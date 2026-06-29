# Advocate C — Replace the flat ReAct loop with a structured Plan-and-Execute + Reflexion CONTROLLER

Position paper for the 4-agent architecture debate. Ground truth:
`00-current-architecture.md`, `01-research-sota.md`. Branch `feat/zintus-10-10`.

My thesis in one line: **the model should decide WHAT to do; the controller should
decide WHETHER it's allowed to move on.** Reliability comes from determinism in the
*control flow* — an explicit plan object the controller drives step-by-step, a
**mandatory** verify after every editing step, and a **bounded** reflect→revise
before the plan pointer is allowed to advance — not from the model's good intentions.

---

## 1. The brutally honest diagnosis of today's loop

`runAgentToolLoop` (`agent-tools.ts:1268`) is a clean, correct **flat ReAct loop**:
`route() → stream text + tool_calls → execute ALL calls → feed tool_results back →
repeat until a round emits no calls or `maxRounds``. Everything that matters —
whether to plan, whether to verify, whether to revise after a failed test — is
**model discretion**. There is no controller. There is a loop.

Three concrete places this bites, all visible in doc-00:

1. **`update_plan` is advisory, and advisory plans are ignored under pressure.**
   The tool (`agent-tools.ts:970`) literally says in its own description "does not
   read or write files and does not count against any budget." Its `execute` just
   stores `ctx.plan.steps` and bumps `revision` — it is a **render target for the
   user**, nothing more. Nothing in the loop reads the plan back, blocks on it, or
   checks that the in_progress step actually got verified before the model marches
   to the next one. A plan the control flow never consults is a comment, not a plan.
   Doc-00 gap #2 names this exactly: "no automatic 'tests failed → revise'
   controller — it's all left to the model."

2. **Verification is opt-in to the *model*, not enforced by the *machine*.**
   `run_command` (`agent-tools.ts:1110`) has real teeth — allowlist, argv-only, no
   shell, confirm-gated, run-budget 10, 120s timeout, 16KiB cap. Doc-00 §2.6 calls
   this "the strongest, cheapest reliability lever in all of agentic coding," then
   delivers the indictment: Zintus "has the plumbing … but it's **model-discretion,
   not a controller**." A model that just wrote a broken edit is precisely the
   model least likely to notice it needs to run the tests. The capability exists;
   the *guarantee* does not.

3. **"Done" is whatever round the model stops emitting tool calls.** The loop exits
   on `calls.length === 0`. There is no success criterion, no gate, no "did the
   thing you claimed to do actually typecheck." The end-of-run verify (doc-00 Safety)
   is a single trailing check, not a per-step gate — by then the context may be
   poisoned by five steps of compounding error.

The research is blunt about why this is the failure mode. Reflexion (arXiv
2303.11366) earns **+11% HumanEval / +22% AlfWorld** *only when there is a clear
gradable signal* — and it *hurt* MBPP (80.1→77.1) and *failed* WebShop where the
signal was fuzzy. For a coding agent the gradable signal is **tests/typecheck**,
which Zintus already has wired. Leaving the decision to invoke that signal — and to
act on its failure — to the model's discretion throws away the one place Reflexion
is *proven* to pay. Determinism in the controller is how you cash that in.

---

## 2. The design — a LIGHTWEIGHT controller OVER the existing loop (not a rewrite)

I am not proposing a heavy state-machine framework. I am proposing **one outer
function that wraps `runAgentToolLoop`** and makes three things deterministic that
are currently discretionary: the plan pointer, the post-edit verify, and the
bounded revise. The inner ReAct loop — the thing that's already good — stays.

### 2.1 Promote `ctx.plan` from render-target to driven state

Today `ctx.plan` is write-only-by-the-model and read-only-by-the-renderer. Make the
controller the owner of a real cursor:

```
PlanState = {
  steps: { text, status, successCriterion }[]   // successCriterion is NEW, required for editing steps
  cursor: number                                // controller-owned, NOT model-owned
}
```

- The model still authors the plan via `update_plan` (router moat intact — strong
  model plans). The controller, not the model, advances `cursor`.
- For any step that touches files, the model must supply a **machine-checkable
  success criterion**: which allowlisted verify command must pass (`bun run
  typecheck`, `bun test path/to/file`). If it can't name one, the step is
  flagged "unverifiable" and runs in plain-ReAct mode (see §3 — this is the escape
  hatch that keeps it from being rigid).

### 2.2 The controller loop (pseudocode, ~1 screen)

```
for step in plan.steps (driven by controller cursor):
    mark step in_progress (this is the ONLY auto status transition)

    # EXECUTE: hand this step to the EXISTING runAgentToolLoop, scoped to the step.
    # Inner loop is unchanged — model freely reads/searches/edits with full discretion.
    runAgentToolLoop(stepMessages, handlers)   # bounded by per-step round sub-budget

    # VERIFY (mandatory, deterministic — controller calls run_command, not the model):
    if step has successCriterion:
        result = run_command(step.successCriterion)   # reuses existing allowlist+budget
        if result.exitCode == 0:
            mark step done; cursor += 1; continue

        # REFLECT→REVISE (bounded — THIS is Reflexion-lite, test-gated):
        for attempt in 1..MAX_REVISE (=2, hard cap):
            feed back {the diff so far, the failing command, its stderr/exit code}
            runAgentToolLoop(reviseMessages, handlers)   # model revises with the error in context
            if run_command(successCriterion).exitCode == 0:
                mark step done; cursor += 1; break
        else:
            # exhausted revises — DO NOT silently advance.
            mark step blocked; surface to user (honesty bar); stop or ask.
    else:
        mark step done; cursor += 1    # unverifiable step: trust the model, ReAct as today
```

### 2.3 Exactly how it maps onto doc-00's primitives (no new moat-breaking machinery)

| Research pattern | doc-00 primitive it reuses | What the controller adds |
|---|---|---|
| Plan-and-Execute (§2.1) | `update_plan` / `ctx.plan` | controller-owned `cursor`; steps are *driven*, not rendered |
| Reflexion-lite, test-gated (§2.6, arXiv 2303.11366) | `run_command` allowlist (`agent-tools.ts:1110`) + run-budget 10 | **mandatory** post-edit verify; bounded revise on non-zero exit |
| Model tiering (§2.7 — the moat) | `route()` already picks per call | strong model plans/revises, cheap model executes routine steps — **near-free here, impossible single-vendor** |
| Bounded execution (doc-00 Safety) | `maxRounds`, mutation/run budgets | per-step round sub-budget; `MAX_REVISE` hard cap |

Crucially every model call still goes through `route()` — **the controller never
hardcodes a model**, so the router moat (doc-00 constraint) is preserved. This is
doc-01's ranked idea **#2 (verify→revise controller)** and **#5 (model-tiered
plan→execute)** fused, which is exactly the pair doc-01 calls "the cheapest
reliability win" and "the moat's flagship."

---

## 3. The brutal honesty: where my own thesis is DANGEROUS

I have to argue against myself here, because the research demands it and because a
debate that hides its losing cases is propaganda.

**The strongest evidence in doc-01 cuts AGAINST heavy control structure:**

- **mini-SWE-agent** (doc-01 §2.8): a deliberately *tiny bash-only single-agent
  loop* is on the SWE-bench Verified leaderboard. "Scaffolding minimalism + a good
  model" is competitive with elaborate orchestration.
- **Agentless** (arXiv 2407.01489): *no agent at all*, a fixed pipeline, beats many
  agents at ~$0.70/task. But note — its win is **localize→repair→validate + test
  filtering + majority vote**, i.e. its structure is *verification*, not a
  conversational state machine. That actually supports the verify half of my thesis
  while undercutting the plan-state-machine half.
- **Cross-cutting attribution** (doc-01 §2.8): top scorers credit **tool/interface
  quality + in-the-loop test verification + context discipline** — *not* heavy
  control flow.

So the honest decomposition of my own thesis:

| Sub-claim | Verdict | Why |
|---|---|---|
| **Mandatory post-edit verify (test-gating)** | **STRONGLY SUPPORTED — build it** | doc-01 §2.6, Agentless, Reflexion-when-signal-exists. This is the cheap, deterministic, high-leverage half. |
| **Bounded reflect→revise on failing tests** | **SUPPORTED but only with a gradable signal and a hard cap** | Reflexion helps on HumanEval/AlfWorld, *hurts* MBPP/WebShop. Cap revises at 2; only reflect on a real non-zero exit, never on vibes. |
| **A rigid plan→execute state machine the controller marches through** | **PARTIALLY SUPPORTED — keep it OPTIONAL and lightweight** | This is where over-engineering lives. mini-SWE-agent says a strong model + a flat loop is already competitive. A rigid cursor that fights a strong model's adaptive recovery is *negative* value. |

**The specific over-engineering failure modes I am warning against:**

1. **Rigidity fighting adaptation.** ReAct's whole strength (doc-01 §2.1) is
   recovering from surprises. A controller that force-marches a stale plan when the
   model has discovered the plan was wrong is worse than no plan. Plan-and-Execute's
   named weakness (§2.1) is "brittle when a step fails." If my re-plan path is weak,
   I've built the brittle thing.
2. **Verify tax on trivial work.** Forcing `bun run typecheck` after a one-line
   README edit burns the run-budget-10 and 120s timeouts for nothing.
3. **Reflexion on a fuzzy signal.** If a step has no test, reflecting on the model's
   own narration is exactly the MBPP/WebShop regression case. Don't.
4. **State-machine sprawl.** The moment the controller grows phases, sub-states, and
   transition tables, it becomes the brittle scaffolding the research warns against,
   and it fights every model upgrade.

**Guardrails that keep it lightweight (these are non-negotiable for my own design):**

- The controller is **one wrapper function**, not a framework. If it doesn't fit on
  ~one screen of pseudocode (§2.2), it's wrong.
- **The inner `runAgentToolLoop` is untouched.** Execution inside a step is full,
  free ReAct. I am adding gates *between* steps, not caging the model *within* one.
- **Verify is mandatory only for steps the model itself marked as editing+verifiable.**
  Unverifiable / trivial steps fall straight through to plain ReAct (§2.2 `else`).
- **Plan-execute mode is OPT-IN / auto-triggered by task size**, default off for
  short tasks. A 2-step task should never see the state machine. Honor mini-SWE's
  lesson: small task → flat loop.
- **Re-plan is a first-class transition, not an exception.** On a blocked step the
  controller hands control *back to the planner model* to revise remaining steps —
  it does not force-march. This is the answer to failure mode #1.
- **Everything stays bounded and surfaced** (doc-00 honesty bar): `MAX_REVISE`,
  per-step round budget, blocked steps shown to the user — never silently skipped.

---

## 4. Conceding to Advocate A (the "simple loop" thesis)

A is right about the load-bearing fact: **mini-SWE-agent and Agentless prove a
strong model + good tools + verification beats orchestration complexity for the edit
itself.** I concede that the flat `runAgentToolLoop` should remain the spine and the
default. I am **not** asking to replace it for the common case; I'm asking to wrap it
for the multi-step case, and even then to keep execution-within-a-step as the same
free ReAct A defends.

Where A and I genuinely disagree is narrow and worth stating cleanly: A's "simple
loop" still leaves **verification to model discretion**. That is the one place
"simple" tips into "unreliable." Making the *verify gate* deterministic is not
orchestration complexity — it is *interface/verification quality*, the exact thing
doc-01 §2.8 says top scorers credit. A simple loop with a mandatory test gate is
still a simple loop. It's just an honest one.

---

## 5. Build vs avoid (concrete)

**BUILD (high confidence):**
1. **Mandatory post-edit verify gate** — controller calls `run_command` with the
   step's success criterion after any editing step; reuses the existing allowlist,
   budget, timeout, output cap. (doc-01 #2; doc-00 gap #2.)
2. **Bounded reflect→revise** — on non-zero exit, feed back {diff, command, stderr},
   re-enter `runAgentToolLoop`, re-verify; hard cap `MAX_REVISE=2`; blocked steps
   surfaced, never silently advanced.
3. **`successCriterion` field on editing plan steps** — the model names the verify
   command when it plans; this is the seam that makes the gate deterministic.
4. **Model-tiered routing across phases** — strong model plans/revises, cheap model
   executes routine steps, all via `route()`. The moat's flagship; near-free.

**BUILD (lightweight, optional, default-off for small tasks):**
5. **Controller-owned plan cursor** — promote `ctx.plan` to driven state with a
   re-plan transition on a blocked step. Auto-engage only above a task-size
   threshold.

**AVOID (the over-engineering A is right to fear):**
- A general state-machine/workflow framework with phase tables and sub-states.
- Forcing verify on trivial/unverifiable steps (Reflexion-on-fuzzy regression).
- Force-marching a stale plan instead of re-planning (Plan-and-Execute brittleness).
- Tree/Graph-of-Thoughts plan search — doc-01 §2.1/§3 say skip; token-heavy, weak
  real-repo evidence. Use test-gated self-consistency *only* behind `--thorough`.
- Anything that hardcodes a model and breaks the router (doc-00 constraint).

The deterministic *verify gate* is the part I'd defend to the death; the plan *state
machine* is the part I'd keep optional, small, and humble — because the research
says the model is often smarter than my control flow, and an honest architecture
plans for that.

---

## 6-line summary

1. Today's loop leaves the three reliability decisions — plan, verify, revise — to
   model discretion; `update_plan` is an advisory render-target the control flow
   never reads back, and `run_command` is "plumbing, not a controller" (doc-00/§2.6).
2. Fix: a one-screen wrapper over the EXISTING `runAgentToolLoop` that makes the plan
   cursor, the post-edit verify, and a bounded reflect→revise **deterministic** —
   the model decides what, the controller decides whether it may advance.
3. It reuses doc-00 primitives wholesale (`ctx.plan`, `run_command` allowlist+budget,
   `route()`), so the router moat and all bounds stay intact; it's doc-01 ideas #2+#5
   fused — "cheapest reliability win" + "the moat's flagship."
4. Brutally honest danger: mini-SWE-agent/Agentless prove simple loop + good tools +
   verification beats heavy control; a rigid plan state machine that fights a strong
   model is NEGATIVE value, and Reflexion regresses on fuzzy signals (MBPP/WebShop).
5. So: the **mandatory test-gated verify+revise** half is strongly supported — build
   it; the **plan state-machine** half stays optional, lightweight, default-off for
   small tasks, with re-plan (not force-march) as a first-class transition.
6. Concede A: keep the flat loop as the spine and default, and keep execution-within-
   a-step as free ReAct — I only make the *verify gate* deterministic, which is
   interface/verification quality (what top SWE-bench scorers actually credit), not
   orchestration bloat.
