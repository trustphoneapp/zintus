# Advocate B: Read-only EXPLORER subagents + a model-TIERED pipeline that exploits the router moat

Position paper for the 2026-06-29 agentic architecture debate. Ground truth:
`../00-current-architecture.md` (the loop, tools, gaps) and `../01-research-sota.md`
(the evidence). Code refs are to `feat/zintus-10-10`.

---

## 0. Thesis in one breath

The single-loop hardening camp (Advocate A) is right about the *spine* and right
that **context management is the prerequisite**. But hardening a single loop only
gets Zintus to *parity* with mini-SWE-agent and Claude Code. The place Zintus can
**lead the field instead of matching it** is the one capability no single-vendor
agent has natively: **per-call model tiering across 12 providers via the router.**
The cleanest, lowest-risk vehicle for that tiering is a **read-only EXPLORER
subagent** — its own isolated context, a cheap model, read/search/map only, returns
a compact summary. This is *exactly* the slice of multi-agent the evidence says
**works** (parallel read-heavy exploration in isolated contexts) while structurally
honoring the slice the evidence says **fails** (parallel writing / split
decision-making). One writer. Many cheap explorers. The router makes the "cheap"
free.

This is not a swarm. It is orchestrator-worker with a **single writer** and
**read-only workers**, which is the synthesis both primary sources converge on
(`01-research-sota.md` §2.2).

---

## 1. Why this is the differentiated win (the evidence, brutally)

**The multi-agent debate already resolved — to my shape.** The two best primary
sources disagree on tone and agree on geometry (`01-research-sota.md` §2.2):

- **Anthropic** (multi-agent research system): orchestrator-worker subagents in
  **isolated context windows** returning **only summaries** scored **+90.2% over
  single-agent Opus 4** on breadth-first research — but at **~15× tokens**, and it
  **wins on parallelizable, read-heavy tasks** and **loses when agents share context
  or have dependencies.**
- **Cognition/Devin** ("Don't Build Multi-Agents"): for code, **keep writes
  single-threaded; extra agents add *intelligence, not actions*.**

Read together, both endorse the same machine: **one writer, many read-only
explorers/reviewers.** Amp ships exactly this (Oracle/Librarian are read/reason
roles, the main thread writes). Claude Code's `Task` subagent is exactly this
(isolated context, returns a summary). My proposal is not exotic — it is the
*converged* design, and Zintus has gap #3 ("No subagents / context isolation")
open precisely here (`00-current-architecture.md`).

**The router makes the tiering native, not bolted-on.** Every multi-model trick
other agents contort themselves into — Amp pairing Claude+GPT across separate
contexts, Plan-and-Execute's strong-planner/cheap-executor, Aider's architect/editor
split — **Zintus gets for one field on a request object** (`01-research-sota.md`
§2.7, §3 idea #5). Single-vendor agents *cannot* put a frontier model on the edit
and a 7B model on search/triage; Zintus can, today. That is the moat the audit named
as the thing any new architecture MUST honor (`00-current-architecture.md`,
"the router moat"). An architecture that doesn't *exploit* it is leaving the only
structural advantage on the table.

**Tiering needs a clean seam, and the explorer *is* that seam.** Tiering *inside*
one conversation is awkward and arguably dishonest: switching providers mid-thread
discards provider-side prompt caching, and a different model inheriting context
authored by another model is a quality cliff. A subagent is a **fresh conversation**
— the natural, honest place to drop to a cheap tier. This is why B's two halves
reinforce each other: the explorer is where "cheap model" stops being a hack and
becomes architecture.

---

## 2. How it maps onto doc-00's actual code

The good news: **the existing primitives compose into this with almost no new
machinery.** The loop is already reentrant-shaped and the router already takes a
per-request tier.

### 2.1 The loop recurses on itself
`runAgentToolLoop` (`agent-tools.ts:1268`) takes `messages` + an
`AgentLoopHandlers` whose only model dependency is the injected
`route: (messages, round) => Promise<R>` (`agent-tools.ts:1247`). That injection
point is the whole trick: **an explorer is just `runAgentToolLoop` called again
with (a) a fresh `convo`, (b) a read-only tool set, (c) a `route` that forces the
cheap tier.** No engine fork, no second framework — the orchestrator and the worker
run the *same* bounded ReAct loop.

### 2.2 The router already accepts a per-call tier — the loop just never sets it
Today the main loop routes with no strategy override (`agent.ts:277-284`):
```ts
return engine.routeAndStream({ messages, mode: config.contextMode, tools: toolDefinitions });
```
But `EngineRouteRequest extends Omit<RouteRequest,"messages">` (`engine.ts:146`),
and `RouteRequest` carries `strategy?: RoutingStrategy | "weighted"`, plus `model?`
and `provider?` overrides (`route.ts:234-246`). The factory honors it:
`const effStrategy = request.strategy ?? strategy;` (`factory.ts:448`). The strategy
enum is `"fastest" | "capability" | "economy" | "quality" | "balanced"`
(`config.ts:3`). **So tiering is a one-line addition per role with zero engine
change** — the writer routes `strategy:"quality"`, the explorer routes
`strategy:"economy"`. The router still picks best/cheapest *within* that tier across
all 12 providers, so the moat is fully preserved.

### 2.3 The read-only tool set already exists and is already classified
`AGENT_TOOLS` (`agent-tools.ts:1175`) tags each tool `mutating` /
`requiresConfirmation`, and `isMutatingTool()` (`agent-tools.ts:1197`) is public.
The explorer's tool set is a *filter*, not new code:
`read_file`, `list_directory`, `search_code`, `find_relevant_code` — i.e.
`AGENT_TOOLS.filter(t => !t.mutating && t.definition.name !== RUN_COMMAND_TOOL_NAME
&& t.definition.name !== UPDATE_PLAN_TOOL_NAME)`. Single-writer is enforced
**structurally** (the explorer is never *offered* a write tool), not by prompt.

### 2.4 Share the index, isolate the conversation — the key cost insight
`find_relevant_code` builds its semantic/lexical index **once per run, keyed by the
`AgentToolContext` object** (`agent-tools.ts:693`). So the explorer should **reuse
the parent `ctx.sandbox` + `ctx.semantic`** (zero index rebuild, no second Ollama
embed pass) while keeping a **separate `convo`** (the thing we actually want
isolated — the tokens, the file dumps). That split — *isolate the conversation,
share the compute* — is what makes the explorer cheap rather than a 2× index tax.
A naive "give the subagent its own everything" implementation would rebuild
embeddings on every spawn; don't.

### 2.5 MCP stays put
MCP tools run in the same loop (`agent-mcp.ts`, dispatched at `agent.ts:287-297`).
Explorers default to **file/search tools only** — MCP servers can have side effects
(GitHub writes, DB mutations) and violate the read-only contract. If a user wants an
MCP tool in exploration, it's an explicit opt-in per server, not the default.

---

## 3. Concrete design

### 3.1 The `explore` tool (offered to the writer)
```ts
// added to AGENT_TOOLS; mutating:false, requiresConfirmation:false
{
  name: "explore",
  description:
    "Spawn a READ-ONLY sub-investigator with its OWN context to answer ONE focused " +
    "sub-question about the codebase. It can search/read/map but CANNOT edit, write, " +
    "or run commands. It returns a COMPACT summary (findings + file:line pointers), " +
    "NOT raw file contents. Use it to investigate a self-contained, broad sub-question " +
    "without filling your own context with file dumps. Ask narrowly; one question per call.",
  parameters: {
    question: string,            // required, the sub-question
    hint?: string,               // optional: paths/globs to focus on
  },
}
```

### 3.2 Context + budget carried on `AgentToolContext`
The engine is injected, not imported (keeps `agent-tools.ts` engine-agnostic, mirrors
how `route` is injected into the main loop):
```ts
export interface ExplorerConfig {
  /** Route ONE explorer turn on the CHEAP tier. Injected by the CLI driver; it
   *  forces strategy:"economy" and passes the read-only tool definitions. */
  route: (messages: ChatMessage[]) => Promise<ToolLoopTurn>;
  maxRounds?: number;                       // default 6 (explorers are short-leashed)
  budget: { used: number; max: number };    // cap TOTAL spawns per run (default 3)
}
// AgentToolContext gains:  explorer?: ExplorerConfig;   // absent => `explore` is a no-op error
```

### 3.3 `runExplorer` — the worker is the same loop, recursed
```ts
async function runExplorer(question: string, hint: string | undefined, ctx: AgentToolContext) {
  if (!ctx.explorer) return err("explorer not enabled for this run (pass --explore)");
  if (ctx.explorer.budget.used >= ctx.explorer.budget.max)
    return err(`explorer budget exhausted (${ctx.explorer.budget.max} spawns)`);
  ctx.explorer.budget.used += 1;

  const childMessages: ChatMessage[] = [{
    role: "user",
    content: EXPLORER_PREAMBLE +                       // "you are read-only; return a compact
      (hint ? `\n\nFocus on: ${hint}` : "") +          //  summary + file:line pointers, no file dumps"
      `\n\nSub-question:\n${question}`,
  }];

  const { finalResult } = await runAgentToolLoop(childMessages, {
    maxRounds: ctx.explorer.maxRounds ?? 6,
    // CHEAP tier + read-only tool defs are baked into ctx.explorer.route by the driver.
    route: (messages) => ctx.explorer!.route(messages),
    // SAME sandbox + SAME semantic index (shared compute); DEFENSE-IN-DEPTH: refuse any
    // mutating call even though the model was never offered one (structural single-writer).
    execute: async (call) =>
      isMutatingTool(call.name) || call.name === RUN_COMMAND_TOOL_NAME
        ? { toolCallId: call.id, content: err("explorer is read-only"), isError: true }
        : executeAgentToolCall({ id: call.id, name: call.name, arguments: call.arguments }, ctx),
  });

  // ONLY the explorer's final summary crosses back. The child convo — every big
  // read_file / search_code dump — is dropped on the floor. THAT is the context-isolation win.
  return JSON.stringify({
    summary: finalResult.text ?? "",
    note: "read-only explorer summary — read_file the cited pointers before editing",
  });
}
```

### 3.4 The driver wires the two tiers (the whole tiering change is here)
In `agent.ts`, alongside the existing main-loop `route`:
```ts
ctx.explorer = {
  budget: { used: 0, max: 3 },
  maxRounds: 6,
  route: (messages) => engine.routeAndStream({
    messages,
    mode: config.contextMode,
    tools: READONLY_AGENT_TOOL_DEFINITIONS,   // the filtered subset
    strategy: "economy",                       // ← the CHEAP tier: the moat exploit
  }),
};
// and the MAIN writer loop gains an explicit strong tier:
route: async (messages) => engine.routeAndStream({
  messages, mode: config.contextMode, tools: toolDefinitions,
  strategy: config.routingStrategy ?? "quality",   // ← strong tier for plan/edit
}),
```
That's it. Two `strategy:` fields. The router does the rest across 12 providers.

### 3.5 The tier policy (honest defaults)
| Role | Strategy | Why |
|---|---|---|
| Writer / planner / editor (main loop) | `quality` (or user's configured strategy) | edits are the high-stakes, interdependent decision — give it the best |
| Explorer subagent (search/read/map/triage) | `economy` | read-heavy, parallelizable, low blast radius — the cheap-model sweet spot |
| (future) compaction summarizer | `economy` | A's idea #1, router-powered — the *other* clean tiering seam |

**Honesty guardrails:** tiering must never override a user who explicitly forced a
`provider`/`model` (`route.ts:234-235`) or set a global strategy they meant for
everything; the explorer tier is a *default for a new opt-in capability*, surfaced in
the route-reason line the engine already emits (`engine.ts:167`), and overridable.

---

## 4. Weaknesses, costs, and where this HURTS (no spin)

1. **Latency.** An explorer is a *whole nested loop* — up to `maxRounds` model
   calls. A single `explore` can add seconds to a minute. And the current executor
   runs tool calls **sequentially** (`agent-tools.ts:1302`), so two `explore` calls
   in one round do **not** run in parallel in the minimal slice. The headline
   Anthropic win is *parallel* exploration; we don't get it until the executor
   `Promise.all`s independent read-only calls (see §6 v2). Until then the benefit is
   purely **context isolation**, not speed.

2. **Cost / the 15× tax.** Even on the cheap tier, a 6-round explorer is 6 model
   calls plus tool execs. Anthropic measured multi-agent at **~15× tokens**. The
   cheap tier shrinks the *price per token*, not the *token count*. So this **only
   pays off above a complexity threshold** — Anthropic's own guidance: 1 agent for
   fact-finding, 2–4 for comparison, 10+ for research. For a one-file bug fix the
   writer should just `grep`; spawning an explorer there is pure waste. Mitigations:
   a hard spawn budget (default 3), a short leash (6 rounds), and a preamble that
   tells the writer explorers are for *broad, self-contained* sub-questions only.

3. **Lossy summaries — the real failure mode.** The explorer returns prose; it can
   drop the exact identifier or line the writer needed, sending the writer to edit
   blind or re-explore. This is the inherent risk of "return only a summary."
   Mitigation: the summary contract **must** carry structured `file:line` pointers,
   and the writer is instructed to `read_file` those pointers before editing — the
   summary is a **map, not a substitute** for reading the file it points at. This
   partly *gives back* the token savings (the writer re-reads), which is the honest
   tension at the heart of context isolation.

4. **Tiering misroute.** A cheap model triaging is a weaker tool-caller: it can
   mis-rank, hallucinate a confident-wrong summary, or fumble tool syntax. The blast
   radius is **bounded by design** — an explorer cannot write or run commands, so the
   worst case is a wasted spawn + a misleading summary the writer must catch.
   Mitigations: use `economy`, not `fastest`; because the explorer *requires* tools,
   the router **hard-errors rather than silently downgrading** to a non-tool model
   (`route.ts:251-254`); allow a per-call tier bump for hard sub-questions.

5. **Coordination / shared-context loss.** Two explorers can't see each other's
   findings (that's the point of isolation), so **interdependent** sub-questions will
   produce conflicting or redundant maps — *exactly* Cognition's warning. Rule:
   explorers are for **independent** read-only fan-out only. The moment sub-questions
   depend on each other, that's writer-loop work, not explorer work.

6. **It rides on context management it doesn't provide.** The explorer keeps big file
   dumps *out of the main convo*, but the writer's own reads still grow `convo`
   unboundedly (gap #1). Subagents reduce the *marginal* growth from exploration;
   they do **not** raise the ceiling. Without compaction, a long writer session still
   dies — my explorer summaries just land in a doomed unbounded buffer.

---

## 5. What Advocate A gets right (concessions)

- **Context management is the prerequisite, and it should ship first.** The audit
  names unbounded `convo` (`agent-tools.ts:1276`) as the hard ceiling
  (`00-current-architecture.md` gap #1; `01-research-sota.md` §3 #1). My explorer
  *complements* compaction (it keeps file dumps out of the main thread) but is **not
  a substitute** for it. Build A's compactor first; my work makes no sense on top of
  a buffer that's already overflowing.
- **For the majority of tasks, the hardened single loop wins.** Small, single-file,
  interdependent edits have no parallelism to exploit and pay the full coordination
  tax for nothing. The Agentless / mini-SWE-agent evidence (`01-research-sota.md`
  §2.2, §2.8) is decisive: a single strong agent + good tools beats orchestration for
  the *edit itself*. My thesis is an **above-threshold** capability, not the default.
- **The verify→revise controller (A's #2) is the cheaper reliability win.** Test-gated
  revision (`01-research-sota.md` §2.6) buys more correctness per dollar than any
  subagent. If forced to pick one, ship that before this.
- **Minimalism is a feature.** SWE-agent's ACI and mini-SWE-agent prove interface
  quality beats agent count. Subagents must justify their complexity at every step or
  be cut.

My claim is narrow and honest: **once A's context + verify foundation exists, the
explorer-subagent + cheap-tier pipeline is the highest-*ceiling* addition** — the one
that turns the router from a cost-saver into a *capability* competitors can't copy.

---

## 6. Minimal first slice (and the v2 it unlocks)

**Slice 1 — ship behind `--explore` (off by default; honesty: a new capability is opt-in):**
1. Export `READONLY_AGENT_TOOL_DEFINITIONS` = `AGENT_TOOL_DEFINITIONS` filtered to
   non-mutating, non-run, non-plan tools. (pure filter; `agent-tools.ts`)
2. Add the `explore` tool + `ExplorerConfig` on `AgentToolContext` + `runExplorer`
   (§3.2–3.3). Recurses `runAgentToolLoop`; shares `sandbox`+`semantic`; isolates
   `convo`; structural write-refusal; budget `max:3`, `maxRounds:6`.
3. Wire `ctx.explorer.route` with `strategy:"economy"` and the writer loop with
   `strategy:"quality"` in `agent.ts` (§3.4). **This is the entire tiering change.**
4. Summary contract: explorer returns `{ summary, pointers:[{file,startLine,endLine,why}] }`;
   writer preamble: "read_file the pointers before editing."
5. Tests (mirroring `agent-loop.integration.test.ts`): (a) an explorer write call is
   refused; (b) the child's file-dump tool_results never appear in the parent convo,
   only the summary does; (c) spawn budget enforced; (d) explorer route receives
   `strategy:"economy"` and the writer route `"quality"` (assert on a fake engine).

**v2 (the real Anthropic win):** make the main executor `Promise.all` *independent
read-only* tool calls within a round (writes still sequential), so multiple `explore`
calls actually run **in parallel**. That converts the slice-1 *context-isolation*
benefit into the *speed* benefit, at which point the moat exploit (cheap parallel
explorers) is fully realized — and still single-writer.

---

## Summary (6 lines)

1. The multi-agent evidence converges on ONE shape — single writer + read-only
   explorers in isolated contexts returning summaries — and Zintus has that exact gap
   (#3) open; this is the *converged*, not exotic, design.
2. The differentiated, un-copyable win is per-call **model tiering via the router**
   (`route.ts:246`/`factory.ts:448`): writer on `quality`, explorers on `economy`,
   best/cheapest still chosen across 12 providers — native here, impossible for
   single-vendor agents.
3. It composes from existing primitives: an explorer is just `runAgentToolLoop`
   (`agent-tools.ts:1268`) recursed with a filtered read-only tool set and a cheap
   `strategy:` — share the `ctx` index (`agent-tools.ts:693`), isolate the `convo`.
4. Honest costs: latency, the ~15× token tax (only pays above a complexity
   threshold), lossy summaries (mitigated by file:line pointers), cheap-model
   misroute (bounded — explorers can't write), and no parallelism until v2.
5. Concession: Advocate A's **context compaction is a hard prerequisite** and the
   verify→revise controller is the cheaper reliability win — both should ship first;
   the single loop wins the *majority* of tasks.
6. Minimal slice: `--explore` flag, recursive read-only subagent (budget 3, 6
   rounds, structural write-refusal), two `strategy:` fields for tiering, four tests;
   v2 parallelizes independent explorers for the full router-moat payoff.
