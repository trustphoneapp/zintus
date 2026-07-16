# Zintus Engineer failure-mode and recovery audit

Date: 2026-07-16

## Scope and method

This is a failure-mode-and-effects analysis (FMEA) across the complete local
Engineer vertical: browser, gateway, durable Supervisor, model transport, budget
authority, workspace and sandbox, command execution, verification, review,
approval, and publication. “Complete” means every known boundary and state class
is represented. It cannot mean every unknown future defect; probability must be
calibrated from production telemetry rather than invented.

Likelihood bands are operational priorities:

- **Likely:** expected during normal use or already observed.
- **Occasional:** expected under degraded dependencies, restarts, or unusual repos.
- **Rare:** requires corruption, adversarial input, or multiple simultaneous faults.

Primary references:

- [OpenAI Node SDK: timeouts, retries, request IDs](https://github.com/openai/openai-node)
- [OpenAI Responses background processing and retention](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [AWS: control and limit retries](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html)
- [AWS: client timeouts and circuit breakers](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_client_timeouts.html)
- [SQLite: atomic commit](https://www.sqlite.org/atomiccommit.html)
- [Git: worktree isolation](https://git-scm.com/docs/git-worktree)

## Failure matrix

| Boundary | Failure | Likelihood | Required behavior | Detection and automation | Status |
|---|---|---:|---|---|---|
| Intake | Missing/forged local authority | Occasional | Reject before ledger mutation | Gateway auth, origin, forged-principal tests | Covered |
| Intake | Duplicate submit or stale UI version | Likely | Idempotent replay or version conflict | Unique keys + CAS state-version tests | Covered |
| Repository | Path, base SHA, or origin mismatch | Likely | Fail preflight without model spend | Doctor/preflight contract tests | Covered |
| Repository | Base advances during work | Occasional | Block publication; create fresh immutable recovery run | Stale-base integration tests | Covered |
| Context | Huge/binary/symlink/path-escape input | Occasional | Bound, exclude, or reject safely | Context/path/symlink tests | Covered |
| Planning | Invalid structured output | Occasional | Record exact error; bounded replan | Planner schema and retry tests | Covered |
| Planning | Planning exceeds deadline | Occasional | Abort, persist `lastError`, terminate accurately | Planning-timeout gateway test | Covered |
| Human input | Mandatory question unanswered | Likely | Pause only at `CLARIFICATION_REQUIRED` | Decision-policy/state tests | Covered |
| Budget | Call would exceed cost/token/time cap | Likely | Reject before transport; pause with checkpoint | Reservation and pause/resume tests | Covered |
| Budget | Reservation presented as actual spend | Likely | Separate settled usage from unsettled maximum | Ledger regression in execution test | Fixed in this change |
| Model | 408/429/5xx/network reset | Occasional | Retry only idempotent calls with bounded policy | Retry ledger/fingerprint tests | Covered |
| Model | Ambiguous client timeout | Likely | Do not replay automatically; preserve workspace and ask once | Provider-timeout recovery integration test | Fixed in this change |
| Model | Remote request finishes after local timeout | Occasional | Keep conservative unsettled reservation | Budget projection test; provider reconciliation canary | Partial: external reconciliation pending |
| Model | Repeated tool loop/no progress | Occasional | Stop at round, mutation, argument, retry, and total-run limits | Builder boundary tests | Covered |
| Model | Tool policy rejection | Likely | Feed safe corrective feedback to model; never weaken policy | Command-policy tests | Covered |
| Worker | Gateway/process dies mid-run | Occasional | Lease expires; recover/requeue from durable checkpoint | Worker lease/restart tests | Covered |
| Worker | Retry recalculates integrity baseline over partial work | Rare/Critical | Load original trusted baseline | Partial-timeout checkpoint regression test | Fixed in this change |
| Sandbox | Docker unavailable/image digest wrong | Occasional | Fail closed before model execution | Doctor and preflight tests | Covered |
| Sandbox | Warm workspace stale/dirty/expired | Occasional | Quarantine and cold fallback | Warm-pool claim/sweep tests | Covered |
| Sandbox | Dependency bundle missing or mismatched | Likely | Block offline execution; never install from network | Offline bundle tests | Covered |
| Filesystem | Traversal, symlink escape, `.git` mutation | Rare/Critical | Reject before read/write | Manifest boundary tests | Covered |
| Filesystem | Disk full or permission loss | Rare | Preserve prior transaction; surface environment failure | SQLite transaction behavior; disk fault injection | Partial: automated disk-full campaign pending |
| Command | Hang, output flood, or process leak | Occasional | Kill at timeout; cap bytes; clear timers | Async-process/executor tests | Covered |
| Command | Shell injection or unapproved command | Rare/Critical | Reject; execute argv with `shell:false` | Trusted-executor tests | Covered |
| Cancellation | Cancel races with model/tool/state transition | Occasional | Abort active work; one durable cleanup path | Planning/execution cancellation tests | Covered |
| Verification | Test mutation or baseline tampering | Rare/Critical | Security escalation; no evidence promotion | Test-integrity tests | Covered |
| Verification | Stable failure vs flake | Likely | Confirm, quarantine mixed outcomes, never claim pass | Verification/flake tests | Covered |
| Verification | Empty diff/new files only | Occasional | Include untracked files and checkpoint them | Git-workspace regression tests | Covered |
| Review | Reviewer context contamination | Rare/Critical | Fresh isolated review over hash-bound inputs | Reviewer isolation tests | Covered |
| Review | Advisory prose conflicts with deterministic evidence | Occasional | Deterministic executor remains authoritative | Verification-manager tests | Covered |
| Approval | Expired or mismatched approval | Occasional | Refuse publication and record durable reason | Approval deadline/hash tests | Covered |
| Publication | GitHub unavailable/credentials revoked | Occasional | Record retryable operation; do not claim success | Git service and publication tests | Covered locally; live canary required |
| Publication | Partial push/PR then gateway restart | Rare/Critical | Discover idempotent remote result before retry | Publication recovery tests | Covered at service boundary |
| UI/SSE | Browser disconnect, duplicate/gapped events | Likely | Reconnect from durable sequence and reject gaps | SSE parser/replay tests | Covered |
| UI/SSE | Stream close/cancel race | Occasional | Close once; clear heartbeat/poll timers | Terminal stream test + close guard | Fixed in this change |
| UI | Stage panel shown before evidence exists | Likely | Render only after durable stage evidence | Stage-aware snapshot/UI logic | Covered |
| History | Tab closes or token disappears | Likely | History stays server-side and reopens after auth | Durable history/pagination tests | Covered |
| Secrets | Key/body leaks in errors or logs | Rare/Critical | Redact and never persist credentials in prompts | Redaction/transport tests | Covered |
| Storage | SQLite corruption or unrecoverable host loss | Rare/Critical | Stop writes; restore from protected backup | Integrity check + restore drill | Operational drill pending |
| Cloud | Cloud sandbox/control plane outage | Future | Provider-specific blocked state and failover policy | Contract suite for `ISandbox` adapter | Deferred with cloud sandbox |

## Automated reliability program

### Every change

1. Type-check Engineer, gateway, web, and desktop consumers.
2. Run the full Engineer unit/integration suite.
3. Run gateway route, identity, SSE, cancellation, and readiness suites.
4. Assert every non-terminal state has a bounded path to a terminal state.
5. Assert no successful model call exists without an admitted reservation.
6. Assert verification and publication cannot run without hash-bound evidence.

### Nightly local fault injection

Run a seeded matrix that kills or degrades one boundary at a time:

- kill the gateway once in every active state, then restart and reconcile;
- abort the model transport before headers, after headers, and after a tool round;
- return 408, 409, 429, 500, 502, 503, malformed JSON, and truncated streams;
- stop Docker, remove the pinned image, corrupt a warm claim, and mismatch a lockfile;
- fill a bounded test volume, revoke directory permissions, and force SQLite busy;
- cancel concurrently with planning, a tool call, verification, and human approval;
- disconnect SSE before, during, and after terminal drain;
- make GitHub create the branch but time out before returning the PR result.

Each scenario must assert: exact final/recoverable state, one safe user action,
bounded attempts, no unauthorized mutation, no false success, durable `lastError`,
and no timer/process/lease leak.

### Scheduled live canaries

Use a private disposable repository and a tiny deterministic task:

- daily: plan/build/verify without publication;
- weekly: human approval plus draft PR creation and cleanup;
- on model/SDK change: timeout, rate-limit, usage accounting, and request-ID checks;
- monthly: backup/restore and provider-timeout billing reconciliation drill.

Canaries need separate hard budgets and must never use production repositories.

## Current residual risk

The local vertical is substantially hardened, but the repository's declared
release status remains **not production-ready** until the pending disk/storage
fault campaign, real provider reconciliation, real GitHub canary, and backup/
restore drill produce evidence. New bugs appeared during interactive testing
because earlier work emphasized happy-path breadth; this program changes the gate
from “feature exists” to “each boundary has a fault test and a recovery proof.”
