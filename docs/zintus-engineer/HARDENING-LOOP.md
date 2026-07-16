# Zintus Engineer hardening loop

Updated: 2026-07-16

This file is the durable implementation record for the cost, recovery,
permission, and user-experience hardening work. A task is complete only after
its focused regression tests and the wider Engineer test suite pass.

## Operating rules

- Preserve the current paused run and its workspace as failure evidence.
- Never spend automatically after an ambiguous provider timeout or a hard
  budget admission failure.
- Use Luna for deterministic classification and routine summaries, Terra for
  normal planning/building/security work, and Sol only for explicitly
  high-complexity or high-risk decisions and final escalation.
- Ask mandatory questions at the point they block safe work. Collect all other
  human questions into one end-of-run inbox before any remote side effect.
- Every model/tool loop needs a durable budget boundary, a semantic progress
  signal, and a bounded stop condition.
- Read, create, overwrite, delete, execute, network, secrets, local Git, and
  remote Git are distinct capabilities. A frozen plan must not imply one from
  another.

## Current failure evidence

- Run `corrected-03735f0da2a4afa79ba54414da364923` is preserved in
  `PAUSED_BUDGET` and must not be resumed during this hardening pass.
- Settled usage: about $2.2173 and 708,500 tokens. One stale $0.3743 / 34,867
  token reservation remains from a prior paused Builder execution.
- The targeted test passed, while repository typecheck repeatedly failed with
  the same `TS2339` diagnostic. Workspace mutations let that repeated failure
  evade the existing same-command/no-mutation guard.
- The Builder used Sol for routine repair turns and repeatedly resent a growing
  transcript. Prompt caching helped, but previous-response chaining would not
  remove billed input; bounded context/compaction is still required.

## Work queue

| Priority | Work item | Status |
| --- | --- | --- |
| P0 | Exclude/redact secret-bearing repository context before planner reads | Implemented; focused tests pass |
| P0 | Block all publication while deferred human decisions remain | Implemented; publication and gateway tests pass |
| P0 | General semantic no-progress and tool-call limits | Implemented; focused tests pass |
| P0 | Cheap-first Builder routing with explicit Sol escalation | Terra-first implemented; Sol remains isolated Reviewer authority |
| P0 | Reconcile/release stale model reservations without hiding ambiguous billing | Ambiguous lifecycle implemented; reconciliation pending |
| P0 | Bounded Builder context, explicit caching, compaction, and smaller outputs | Implemented, including 96 KiB tool views and durable transcript continuation |
| P0 | Preserve resumable workspaces/checkpoints across graceful restart | Implemented; budget/provider pause restart tests pass |
| P1 | Truthful live/reviewed diff and security UI provenance | Implemented; focused tests pass |
| P1 | Separate read/create/overwrite/delete/execute permissions in plan and UI | Implemented as a truthful frozen capability projection |
| P1 | Stop repeated policy/path denials with a structured permission-needed result | Bounded adaptive feedback and two-round semantic stop implemented |
| P1 | Durable command claims and command-mutation containment | Mutation checkpoint/rollback implemented; durable pre-command claim remains |
| P1 | Finalize orphan RUNNING agents during recovery | Implemented idempotently for execution and verification recovery |
| P1 | General state deadline watchdog and surfaced recovery failures | Planning/model steps capped at 2 min; worker leases/watchdog active; passive human states excluded |
| P1 | Paid verification-stage operation checkpoints | Stable-test and Reviewer repair recovery implemented; advisor/reviewer stage reuse remains |
| P1 | Accurate settled/reserved/ambiguous cost and live activity UI | Implemented; ambiguous provider usage is separately fenced and labeled |
| P1 | UI action locks and bounded browser-folder inventory | Implemented; inventory caps files, entries, depth, and skips dependency/Git internals |
| P2 | Stop execution-time budget while paused or awaiting a human | Implemented for budget, provider retry, clarification, approval, review, stale-base, and terminal waits |
| P2 | Optional consented, provenance-bound production-knowledge attachments | Pending |

## Research decisions

- Keep stable instructions/tools at the front of the request and dynamic
  content at the end. Use explicit prompt-cache boundaries where supported.
- Keep the tool schema stable for caching, but restrict the currently available
  subset with allowed tools and allow at most one tool call at a time.
- Compact or summarize old tool traffic; do not assume `previous_response_id`
  reduces billed input, because prior input remains billable.
- Prefer deterministic code/executor evidence over additional model calls.
- Provider timeouts are ambiguous and require a human retry decision; local
  policy denials and deterministic compiler failures are not transient retries.

Primary references checked on 2026-07-16:

- OpenAI model catalog and pricing: <https://developers.openai.com/api/docs/models>
- GPT-5.6 Sol: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- GPT-5.6 Terra: <https://developers.openai.com/api/docs/models/gpt-5.6-terra>
- Prompt caching: <https://developers.openai.com/api/docs/guides/prompt-caching>
- Conversation state and compaction: <https://developers.openai.com/api/docs/guides/conversation-state>
  and <https://developers.openai.com/api/docs/guides/compaction>
- Tool restrictions and safety: <https://developers.openai.com/api/docs/guides/function-calling>
  and <https://developers.openai.com/api/docs/guides/safety-best-practices>

## Completed failure-path controls

- Builder execution resumes from a hash-bound transcript/workspace checkpoint,
  so a budget pause or restart does not repay completed model rounds.
- Stable required-test repair persists its trusted repair context and does not
  repeat the three-execution failure probe after restart.
- Verification and execution recovery finalize orphaned `RUNNING` agents once.
- Planner repository excerpts default to 12 files / 24,000 characters while
  older 20-file / 48,000-character context artifacts remain readable.
- Same-tick UI actions share a synchronous lock, preventing repeated top-ups,
  starts, approvals, retries, and recovery requests.

## Verification gates

1. Focused tests for each pair of changes.
2. Engineer package typecheck and complete package tests.
3. Gateway and web focused tests for changed surfaces.
4. Full repository typecheck/test/build checks that are available offline.
5. Independent adversarial review of authorization, accounting, restart, and
   publication paths before restarting the local gateway.
