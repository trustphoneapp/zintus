# Current Zintus Agent Architecture (ground truth, 2026-06-29)

Read from code on `feat/zintus-10-10`. This is the baseline the deep-research +
debate judge a replacement against.

## Shape: single-agent bounded ReAct loop
`apps/cli/src/lib/agent-tools.ts` `runAgentToolLoop` (line 1268):
- One LLM "agent" in one conversation. Per round: `route()` streams text +
  `tool_calls` from the best/cheapest provider (the Zintus router — the moat);
  ALL tool calls in the round execute (sequentially), each `tool_result` is fed
  back; loop repeats until a round has no tool calls (final answer) or `maxRounds`.
- Bounded: `DEFAULT_AGENT_ROUNDS = 15`, `MAX_AGENT_ROUNDS_CAP = 40`.
- Driver/wiring: `apps/cli/src/commands/agent.ts` `runAgent`.

## Tools (`AGENT_TOOLS`)
- Read-only: `read_file`, `list_directory`, `search_code` (literal grep),
  `find_relevant_code` (semantic via embeddings when Ollama configured, else a
  key-free lexical ranking over a `@zintus/codebase-indexer` `CodeIndex`).
- Mutating (confirmation-gated): `write_file`, `apply_edit` (exact-unique
  old_string surgical edit, unified-diff preview).
- `run_command` (opt-in `--allow-run`): ONE allowlisted verify command
  (`bun run test/typecheck/lint/build`, `bun test <path>`) — argv-only, no shell,
  confirm-gated, run-budget 10, 120s timeout, 16KiB output cap, exit code fed back.
- `update_plan` (model-driven advisory plan: steps + status, rendered to user).
- MCP tools (`agent-mcp.ts`): user's own MCP servers hosted in-process, namespaced
  `mcp__<server>__<tool>`, executed in the SAME loop.

## Safety / bounds
- `createSandbox`: rejects path traversal, absolute-outside, symlink-escape (file
  AND dir), NUL bytes; `MAX_FILE_BYTES = 1MiB`; relative-path display.
- Mutation budget `DEFAULT_MUTATION_BUDGET = 50`; run budget 10; per-write confirm
  (default NO; `--yes` bypasses with a loud warning).
- End-of-run change summary (only writes that hit disk) + final verify PASS/FAIL.

## What it deliberately is NOT (the candidate gaps)
1. **No context management / compaction.** `convo` grows unbounded (preamble+task,
   then every assistant turn + every tool_result appended). A long task or large
   file reads will hit the provider context limit; there is no summarization,
   truncation-with-pointer, or tool-result eviction.
2. **No reflection / verify→revise sub-loop.** The only "verify" is the model
   choosing to call `run_command`; there is no structured self-critique of a diff,
   no automatic "tests failed → revise" controller — it's all left to the model.
3. **No subagents / context isolation.** One agent, one context. No Claude-Code-
   style `Task` subagent that explores or executes a subtask in a SEPARATE context
   and returns only a summary (keeps the main context lean; parallelizable).
4. **No persistent repo-map.** No Aider-style ranked repo map of symbols in the
   system prompt; the model must discover structure via tools each run.
5. **No edit-failure recovery strategy.** If `apply_edit`'s old_string isn't a
   unique match it errors back to the model; no diff-format fallback or retry
   policy beyond the model trying again.
6. **No persistent memory across runs** for the agent (each run cold-starts).

## The Zintus-specific constraints any new architecture MUST honor
- **Local-first, no custody, BYOK** — runs on the user's machine against their keys.
- **The router moat** — every model call should be able to route to the
  best/cheapest of 12 providers; an architecture that hardcodes one model loses it.
- **Honesty bar** — no claimed capability without a real, tested path; bounded +
  confirm-gated by default; never a hidden shell.
- **Bun CLI** surface today (no IDE); cross-surface truths.
- Multi-model is a STRENGTH to exploit: cheap model for search/triage, strong
  model for editing/planning (model-tiering is nearly free here, unlike single-
  vendor agents).
