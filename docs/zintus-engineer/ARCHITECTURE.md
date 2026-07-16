# Zintus Engineer architecture

## Boundary

Zintus Engineer is a vertical feature inside Zintus:

```text
Zintus web / desktop / mobile
          |
          | authenticated /v1/engineer + SSE
          v
Existing Zintus gateway
          |
          +--> @zintus/engineer (authoritative supervisor + ledger)
          +--> @zintus/router (central model resolution)
          +--> OpenAI Responses API (SOL Builder/Reviewer; TERRA Tester/Security)
          +--> context/index packages (untrusted repository data)
          +--> exact-base Git worktree + Docker trusted executor + artifact store
          +--> hash-bound claims and evidence bundles
          +--> publication Git service (phase 4)
```

The existing generic agent remains available, but an Engineer run cannot be
implemented by relabeling an agent conversation. Engineer has a frozen manifest,
authoritative state, trusted executor evidence, isolated review, bounded repair,
and supervisor-controlled publication.

## Trust domains

1. **User/client:** supplies intent and human decisions. Authentication establishes
   ownership, not correctness.
2. **Supervisor:** deterministic application code. It alone promotes state,
   consumes budgets, evaluates gates, and commands publication.
3. **Builder:** Codex in a single-writer sandbox. It can propose a patch but cannot
   certify it, publish it, or mutate authoritative state.
4. **Trusted executor:** runs policy-approved commands and records exit code,
   output artifacts, environment digest, sandbox identity, and commit SHA.
5. **Tester/Security:** independent roles that request executor actions and produce
   structured findings. Their prose is not executor evidence.
6. **Reviewer:** a fresh SOL session per attempt with only the frozen manifest,
   final diff, and filtered trusted executor evidence. No Builder narrative,
   memory, repo map, or previous review context crosses the boundary.
7. **Git service:** a narrow publication capability callable only by an
   authenticated Supervisor command after preflight.

## Foundation and execution package

`@zintus/engineer` is a shared, UI-agnostic package. Its public entry point exposes
validated types, pure policy functions, a read API, and the deterministic
Supervisor. The raw ledger implementation is intentionally not exported from the
package entry point, preventing agents or API handlers from bypassing transition
validation through the supported module surface.

The local implementation uses `bun:sqlite`, WAL mode, foreign keys, transactions,
owner-only file permissions, unique `(run_id, sequence)` and `(run_id,
idempotency_key)` constraints, and compare-and-swap updates on `state_version`.
This matches existing Zintus local stores. The Supervisor contract is kept free of
SQLite-specific result types so a cloud adapter can be added later.

The same package fixes the logical model tier for every role: SOL is reserved for
Builder and Reviewer, TERRA serves planning/testing/security/architecture, and
LUNA serves classification/risk-feature/docs/formatting work. Phase 2 resolves
those logical tiers to the current official OpenAI model IDs. Resolution may fail
explicitly but may not silently change a role's tier.

Phase 2 adds the execution boundary inside the same UI-agnostic package. A durable
`QUEUED` event is committed before the gateway acknowledges `/start`; committed
queued work is reclaimed after restart. The worker claims and validates a warm
workspace or provisions an exact-base cold worktree, records the sandbox identity,
then gives Codex only strict manifest-scoped file and command-request functions.
No shell, Git mutation, PR, merge, deployment, secret, or generic state-transition
capability is exposed to the model.

Reasoning-heavy Builder transport uses the official SDK's ten-minute request
bound while the outer workflow remains subject to Zintus stage, run, cost, token,
and cancellation limits. A provider timeout is not replayed automatically because
the remote request may still be running. The run enters
`MODEL_PROVIDER_RETRY_PENDING`, retains its frozen manifest, original trusted test
baseline, and workspace checkpoint, and exposes a bounded human-authorized retry.
Other transient provider failures use capped exponential backoff with full jitter
under the durable retry policy.

The command executor independently checks the frozen command allowlist and a narrow
package-runner policy, spawns argv with `shell:false`, executes inside a pinned
offline Docker image, and stores stdout/stderr as immutable trusted artifacts. A
Builder summary and diff remain untrusted model output. Phase 2 ends at
`FAST_CHECKS`; Phase 3 independently reruns the frozen test plan and security
checks, captures TERRA advisories without granting them authority, then constructs
a hash-bound Reviewer input from the manifest, exact result commit/diff, and
filtered trusted evidence.

Every Reviewer attempt is a fresh SOL request with no previous response, memory,
repository map, Builder narrative, or file/command tools. Strict structured output
is bound to the reviewed diff, evidence hash, and fixed review policy. A requested
repair consumes a Supervisor-owned retry, gives a restricted Builder only
structured findings, and requires full re-verification plus another fresh review.
Verified claims must reference trusted evidence owned by the run. The resulting
bundle is immutable and available through the authenticated gateway read API.
Phase 3 stops at `REVIEW_APPROVED`; only Phase 4 may publish.

Phase 4 creates a hash-bound approval request for work that cannot use the
explicit low-risk bypass. Human decisions are durable records, and approval is
valid only while its manifest, diff, evidence bundle, deadline, and result commit
still match. A gateway sweep converts expired requests into a fail-closed terminal
state. Cancellation passes through `CANCELLATION_PENDING`, destroys the retained
single-use sandbox, and records cleanup failure separately from code failure.

Publication is owned by `EngineerPublicationManager` and a narrow `GitService`.
The Supervisor signs the exact PR command with an internal HMAC key, persists it
as trusted evidence, checks the remote base before mutation, and records every
inspect/branch/push/PR operation under an idempotency key. PR text is synthesized
from the normalized request, frozen criteria, exact diff, claims, risk, and
evidence bundle. The base must enforce reviews, fresh approval, strict status
checks, admin coverage, and immutable protected history. A stale base cannot
publish. Controlled recovery synchronizes the credentialed current base and
creates a replacement immutable run; the old hash-bound approval is superseded.
Restart recovery replays durable publication states, re-inspects the base, and
finds the deterministic head/base PR before attempting creation.

Phase 5 adds a structured TERRA planner ahead of manifest freeze. The model proposes
criteria, test commands, and scope through one strict forced function call; the
Supervisor independently computes risk, adds non-negotiable denials, persists the
proposal, and advances the durable state. Web and desktop consume the same
authenticated workflow API for plan review, timeline replay, exact diff, evidence,
security, human decisions, cancellation, and final outcomes. All three clients
discover the canonical repository and durable run history; mobile presents
required choices and the final human gate. UI labels are derived from ledger truth
and never manufacture progress or success.

Phase 6 adds operational hardening around those boundaries. The planner now rejects
commands that the trusted argv policy cannot execute. Failed correctness checks are
confirmed three times at the same result commit and environment; mixed results are
classified as flaky, quarantined, and remain non-authoritative. The filesystem warm
pool performs periodic invalid/expired/capacity sweeps and bounded minimum
replenishment without ever returning a claimed workspace. Owner-only local
storage rejects symlink substitution. Cached token classes are durable cost
evidence. An authenticated observability snapshot and operations page aggregate
only durable run, approval, retry, token, cost, risk, evidence, and failure records.

## Core invariants

- Model text is data and never directly mutates workflow state.
- A manifest is canonicalized, SHA-256 hashed, versioned, and immutable.
- Events are append-only and ordered. Duplicate idempotency keys replay the exact
  prior result; semantic reuse of a key is rejected.
- Every transition compares the caller's expected state version.
- Every post-freeze event is bound to the current manifest hash.
- Terminal states reject all later execution transitions.
- Provider-timeout recovery is non-terminal, bounded, and reuses the original
  test-integrity baseline; it cannot silently create a fresh baseline over
  partially modified files.
- Risk tier and retry permission are deterministic rule results.
- Reviewer approval, human approval, and PR creation require evidence IDs and
  role-specific guards.
- Medium, high, and critical work can never use the low-risk PR bypass.
- The Builder never receives remote mutation credentials.

## Data model

Phase 1 creates the complete table namespace early so later phases can add behavior
without weakening referential integrity: users, repository connections, Engineer
runs, manifest versions, state events, acceptance criteria, agent/model/sandbox/
command/test records, artifacts and bundles, claims, security and review findings,
Reviewer sessions, risk, approvals, retries, failures, costs, audit events, Git
operations, routing decisions, and warm sandboxes.

Large stdout, diffs, reports, and screenshots belong in the future artifact store;
database rows contain metadata, hashes, and references. Agent-authored annotations
are marked by producer and filtered before Reviewer input construction.

## Existing infrastructure reuse

- Gateway bearer auth and relay ownership checks protect future routes.
- Gateway SSE supplies ordered timeline updates; clients reconnect using durable
  sequence numbers rather than relying on an in-memory stream.
- `@zintus/context-compiler` already fences repository text as untrusted user-role
  data; Engineer will add source/trust manifests and narrower retrieval.
- `@zintus/agent` supplies path containment, symlink defense, bounded writes,
  argv-only commands, allowlists, and optional hardened Docker execution.
- `@zintus/router` supplies provider/capability routing, while a new Engineer model
  router enforces fixed role tiers before calling it.
- Existing Zintus tokens, cards, badges, buttons, and themes supply the UI language.

## Deferred integrations

Organization-scale multi-repository RBAC, distributed workers, hosted artifact
storage, and external activation remain deferred. The Builder and Reviewer have
no credentials for publication operations.
