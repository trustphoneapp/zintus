# Debate Agent 3 — Depth (Agentic vs Cursor · Research vs Perplexity)

Branch: `feat/zintus-10-10`. Verified in code, not docs/commits. Honesty bar:
no ✅ without a code+test path; over-claims flagged.

## Scores (vs the literal 10/10 bar)

- **Agentic: 5 / 10** (Cursor = 10)
- **Research: 6 / 10** (Perplexity = 10)

Both axes are *genuinely real and tested* — not mocks or prompt theater. That
earns the mid-band. Neither is close to its benchmark because of concrete,
namable capability chasms below.

---

## AGENTIC (vs Cursor) — 5/10

### What is REAL (code + test verified)
- A sandboxed coding toolset that actually executes: `read_file`,
  `list_directory`, `search_code`, `write_file`, `apply_edit`
  (`apps/cli/src/lib/agent-tools.ts:265-490`).
- The sandbox is **load-bearing and genuinely enforced**, not cosmetic:
  - lexical containment + symlink realpath check, fail-closed
    (`agent-tools.ts:79-118`);
  - NUL-byte rejection (`agent-tools.ts:84`);
  - size cap + per-run mutation budget (`agent-tools.ts:42-45,232-242`);
  - write gate builds a diff and requires an injectable `confirm()`
    (`agent-tools.ts:225-263`).
  - Tests prove escapes are rejected and **no file is touched**: `../../`
    traversal, `../` write, absolute-outside, symlinked file, symlinked
    *directory* write, NUL byte (`agent-tools.test.ts:90-150`), plus
    decline/budget/size/match-uniqueness cases (`:152-261`) and
    `search_code` not following symlinks out (`:277`).
- A **bounded** route→execute→feed-back loop (`runAgentToolLoop`,
  `agent-tools.ts:565-626`), tested for happy path, runaway stop at
  `maxRounds`, and hard-cap clamp (`agent-tools.test.ts:327-383`).
- **MCP in-process**: the Bun CLI hosts the MCP SDK directly, connects each
  configured server, namespaces tools `mcp__<server>__<tool>`, and dispatches
  them in the SAME bounded loop as file tools, with honest connect-failure
  skip and guaranteed disconnect (`agent-mcp.ts:157-267`). Secret-safe logging
  (arg names only) in the command (`agent.ts:217-238`).
- Fully wired into a real command: `zintus agent` builds the sandbox, system
  preamble, interactive y/N gate (default NO), `--yes` bypass with a loud
  warning, MCP selection, and the loop (`apps/cli/src/commands/agent.ts`).

This is a legitimately well-engineered, safe terminal coding agent — roughly
Claude-Code-*minus-bash* level. The safety model is arguably cleaner than
Cursor's. That is worth real points.

### The chasm to Cursor (still wide)
1. **No command execution / verification loop.** "There is deliberately NO
   shell / run_command tool in v1" (`agent-tools.ts:38`; confirmed — no
   `child_process`/`spawn`/`exec` anywhere in the agent path). The agent
   writes a diff and stops; it **cannot run tests, build, lint, or iterate on
   failures**. Cursor's defining loop is edit→run→read-failure→fix. Zintus
   cannot close that loop at all. This is the single biggest agentic gap.
2. **No semantic code retrieval.** `search_code` is literal-substring grep,
   capped 200 matches / 5000 files (`agent-tools.ts:322-413`). No embeddings /
   codebase index. Cursor's retrieval is semantic. On a large repo the model
   is navigating blind-ish.
3. **No IDE integration of any kind** — no LSP, no VS Code extension, no inline
   editor diffs, no cursor-position/selection context. It is a terminal CLI.
   (Grep for lsp/vscode/extension/language-server: nothing.)
4. **No multi-file plan / todo / task graph.** The loop is reactive turn-by-turn;
   no explicit planning artifact. `apply_edit` is single exact-unique-match only
   (no multi-edit, no fuzzy) (`agent-tools.ts:441-482`).
5. Every write needs an interactive confirm or a blanket `--yes` — no
   per-session scoped allow.

Net: real, safe, bounded, MCP-capable — but a no-shell, no-IDE, grep-only
agent is structurally a notch below Cursor. **5/10.**

---

## RESEARCH (vs Perplexity) — 6/10

### What is REAL (code + test verified)
- True multi-step orchestration: decompose → parallel sub-search → cited
  synthesis → **bounded cross-verification** (`deep-research.ts:337-458`).
- Verification passes are real and depth-tiered: quick 0 / standard 1 / deep 2,
  clamped to a cap, configurable (`verificationPassCount`, `:39-47`;
  `MAX_VERIFICATION_PASSES=3`). A pass derives corroboration sub-queries from
  the **weakly-backed** claims and re-searches (`deriveVerifyQueries`,
  `:300-322`; loop `:396-436`). Stops early when nothing weak remains (`:400`).
- **Citations structurally bound during assembly, not prompt-instructed**:
  `bindCitations` parses `[n]` markers out of the synthesized answer and
  resolves them to concrete `ResearchSource` objects by id; a claim with no
  resolvable marker is `uncited` and is **never given a fabricated source**;
  out-of-range markers don't fabricate (`:259-280`,
  test `deep-research.test.ts:111-149`).
- Source dedup (normalized URL, keep highest score, drop urless) + ranking
  (score desc, recency tiebreak) with stable `s${n}` ids
  (`:179-217`), all unit-tested (`:70-109`).
- Corroboration status is honest and surfaced: `corroborated` (≥2 distinct
  domains) / `single-source` / `uncited`, with a `VerificationSummary`
  (`:73-98,282-292`).
- **Actually executed**, not key-gated-into-oblivion: the gateway wires
  `decompose`/`search`/`synthesize` to the real engine + Tavily→Serper
  fallback (`handler.ts:2070-2123`), with idle/start watchdogs threading abort
  into every upstream call. End-to-end SSE relay (queries→search_complete→
  synthesizing→answer_chunk→done→[DONE]) is gateway-tested
  (`handler.research.test.ts:195-224`), and the full verification/citation
  pipeline is unit-tested including extractClaims, cap, dedup, and event
  contract (`deep-research.test.ts:151-360`).

This is meaningfully stronger relative to its benchmark than the agent is.

### The chasm to Perplexity
1. **"Verification" is structural, not evidential.** `corroboration` =
   "the model cited ≥2 distinct domains," counted from `[n]` markers
   (`:271-277`). There is **no entailment / support check** that the cited
   source content actually backs the claim. A model that cites two URLs it
   never read is scored "corroborated." Perplexity-grade faithfulness checks
   support. This is the deepest research gap.
2. **No conflict / contradiction detection.** Sources are only counted for
   agreement; there is no event or path that flags sources that *disagree*
   (no `conflict` in `DeepResearchEvent`, `:121-146`). The prompt's
   "conflict flagging" goal is **not met**.
3. **Snippets only, no page reading.** `search` runs at depth `"basic"`,
   `maxResults: 5`, and synthesizes over the search-result `content` snippet
   (`handler.ts:2094-2101`, `formatContext` `:227-234`). Perplexity fetches and
   reads full pages.
4. **OVER-CLAIM (minor):** `extractClaims` (LLM-extracted claims to drive
   sharper corroboration) exists and is tested (`deep-research.ts:118,306-308`;
   test `:339-360`) but is **NOT wired in the gateway deps** (`handler.ts:2070`
   only sets decompose/search/synthesize). Production corroboration therefore
   falls back to splitting the answer's own sentences — the documented
   fallback, but the better capability never runs in the real path.
5. Gateway exposes only `depth`; `verification.passes` and `maxSources` are not
   surfaced to API callers (`deepResearch(query, { depth }, deps)`,
   `handler.ts:2139`).

Net: real multi-pass, real structural citations, real dedup/ranking, actually
executed and well-tested — but verification that counts citations instead of
checking evidence, plus no conflict detection and snippet-only reading, keep it
well short of Perplexity. **6/10.**

---

## Top 3 codeable gaps (ranked by 10/10 leverage)

1. **[AGENTIC] Add a sandboxed `run_command`/verify step to close the
   edit→run→fix loop.** Bounded, allow-listed (test/build/lint), output fed
   back into `runAgentToolLoop`. This is the largest single lever — it is the
   difference between "writes diffs" and "agent." Highest leverage on the
   agentic score.
2. **[RESEARCH] Make verification evidential, not citation-counting.** Add a
   per-claim support check (fetch/read the cited source content and test
   entailment) and a `conflict` event when ranked sources disagree. Converts
   the honest-but-shallow `corroborated` label into real corroboration and
   delivers the missing conflict-flagging.
3. **[AGENTIC] Semantic code retrieval** (embed + index the repo; a
   `find_relevant` tool) to replace literal-grep-only navigation, plus wire
   `extractClaims` into the gateway research deps (cheap, already built —
   removes the over-claim). Two smaller, high-confidence lifts.

## [HUMAN] / live-run gates (cannot be settled in code)
- **Agentic quality on a real repo** — does a live keyed LLM actually navigate,
  produce correct unique-match diffs, and recover from errors? No automated
  eval exists; needs a live keyed model run.
- **Research answer quality + citation faithfulness vs Perplexity** — needs a
  live keyed Tavily/Serper + LLM run; the structural pipeline can't self-grade
  whether the answers are *correct* or the citations *truthful*.
- **The "best/cheapest across 12 providers" routing claim** underpinning both
  agent and research synthesis — a live multi-provider run with keys.
- End-to-end MCP against real third-party servers (GitHub/Postgres) — only an
  injected fake client is tested; live behavior is a [HUMAN] gate.
