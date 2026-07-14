# Zintus Engineer implementation plan

> AI writes the code. Zintus proves whether it works.

Zintus Engineer is a feature of Zintus. It extends the existing monorepo, gateway,
clients, router, and agent runtime; it is not a separate chatbot or standalone
product.

## Repository inspection

The inspected baseline is commit `a29a71e8f2f6c7961f54722cb1799f8cee113fa4` on
`feat/mobile-ios-polish`. The worktree already contains unrelated mobile, root
package, lockfile, and generated Next.js changes. Engineer work must not overwrite
or reformat those changes.

| Concern | Existing Zintus implementation | Engineer decision |
| --- | --- | --- |
| Frontend | Next.js 16/React 19 web and desktop; Expo/React Native mobile | Add Engineer screens to the existing shells in phase 5 |
| Backend | Bun HTTP gateway; Hono Cloudflare relay | Authenticated `/v1/engineer` intake, read, freeze, start, events, and artifact routes landed in phase 2 |
| Package manager | Bun workspaces and `bun.lock` | Add a workspace package and use existing scripts |
| Database | Machine-local `bun:sqlite`; Drizzle-backed stores; Cloudflare D1/KV for cloud | Use owner-only SQLite/WAL for the local phase-1 ledger; keep a storage interface suitable for a later D1/Postgres adapter |
| Authentication | Gateway bearer token; relay email/Google sessions and scoped gateway credentials | Reuse the gateway boundary; persist the authenticated user ID on every run |
| Model routing | `@zintus/router` with capability, quota, failover, and structured-output routing | Centrally enforce Engineer role-to-tier routing; agents never pick their tier |
| Streaming | Existing SSE chat, research, and agent event streams; relay WebSocket | Reuse SSE for run timelines and the relay for remote clients |
| Queue/workers | No external general-purpose queue; gateway agent tasks are in-process with persisted checkpoints | Engineer uses the authoritative `QUEUED` ledger state as the durable local dispatch record, acknowledges only after commit, and reclaims queued work after restart |
| Repository integration | Local repository map, sandboxed file tools, Docker command runner; no narrow PR service | Reuse read/write sandbox primitives; build a supervisor-only Git service in phase 2/4 |
| Design system | Shared Zintus tokens plus app-level cards, badges, buttons, inputs, typography, themes | Reuse components and tokens; Engineer is a workflow UI, not a chat window |
| Tests | `bun:test`, Vitest, TypeScript build references, CI security/build/smoke jobs | Add deterministic package tests and include them in the root suite |
| Deployment | Gateway Docker image, Vercel web, Cloudflare workers, desktop/mobile release workflows | No deployment changes in phase 1 |
| Agent abstractions | `@zintus/agent` tool loop, path confinement, mutation/run budgets, verification allowlist, optional hardened Docker | Reuse in phase 2 behind a frozen manifest and supervisor-owned lifecycle |
| Context/memory | Repository indexing, context compiler with untrusted-content fencing, tokzen CCR, memory stores | Reuse repository mapping and context compilation; Reviewer receives neither general memory nor repository map |

### Reusable components

- `@zintus/agent`: sandbox path checks, approval gates, bounded tool loop, command
  allowlist, Docker hardening, repo map, and verify/revise primitives.
- `@zintus/context-compiler` and `@zintus/codebase-indexer`: relevant-context
  selection and explicit treatment of repository text as untrusted data.
- `@zintus/router`, `@zintus/providers`, and `@zintus/schemas`: capability-aware
  routing and validated structured model output.
- Gateway bearer authentication, relay user ownership checks, SSE streaming, and
  persisted agent records.
- Zintus UI tokens/components and existing deployment/test infrastructure.

### Missing components

- An authoritative Engineer run model and append-only event ledger.
- A deterministic state machine, supervisor, risk engine, and retry controller.
- Immutable task manifests and hash-bound evidence records.
- Durable queue/worker orchestration, sandbox lifecycle, and trusted executor.
- Strictly fresh Reviewer sessions and Reviewer input filtering.
- A supervisor-only Git/PR service.
- Engineer API routes, clients, workflow screens, evidence bundle, and evaluation
  fixtures.

### Risky assumptions and blockers

- GPT-5.6 logical tiers SOL/TERRA/LUNA require an explicit provider mapping; no
  silent substitution is allowed. Availability is a phase-2 startup preflight.
- Current agent persistence is not a durable queue and cannot provide exactly-once
  worker semantics. It will not be presented as such.
- Local SQLite is appropriate for the local-first hackathon slice but is not a
  multi-region control-plane database. The ledger API must remain storage-neutral.
- The current Docker runner creates a container per command rather than a claimed
  single-use warm workspace. Phase 2 must add lifecycle ownership and evidence.
- GitHub push/PR credentials are not currently isolated behind a narrow service.
  The Builder must not receive them.
- The attached spec names version-sensitive OpenAI models/APIs. Integration work
  will verify current official OpenAI documentation before selecting an API.

## Delivery phases

### Phase 1 — foundation (complete)

Objective: make workflow authority deterministic and durable before any model is
allowed to build.

Files are limited to `docs/zintus-engineer/**`, `packages/engineer/**`, the root
TypeScript build graph, and root test wiring.

Deliverables:

1. Runtime-validated Engineer contracts (including isolated Reviewer input/output,
   repair context, evidence bundle, claims, routing decisions, and Supervisor PR
   commands) and canonical SHA-256 hashing.
2. SQLite schema for runs, manifest versions, state events, evidence-era records,
   mandatory correction records, risks, retries, failures, and audit events.
3. Optimistic concurrency and idempotent, append-only state transitions.
4. Explicit state graph including Reviewer repair, human approval, PR ownership,
   stale-base, cancellation, and terminal states.
5. A deterministic Supervisor as the only exported mutation surface.
6. Deterministic risk tiers and bounded retry/no-progress rules.
7. Fixed role-to-SOL/TERRA/LUNA policy; provider-model resolution remains a phase-2
   startup preflight and cannot silently substitute a tier.
8. Tests for immutable manifests, transition legality, stale writers, duplicate
   events, terminal behavior, human gates, risk, retries, and terminal reachability.

Exit criteria: package typecheck and tests pass; no existing feature behavior is
changed; no model, sandbox, command, PR, or UI result is mocked as complete.

### Phase 2 — execution

Status: partial for the local single-repository execution slice. The implemented
boundary is useful, but live Docker proof, offline dependency provisioning,
non-blocking workers, complete recovery, and watchdogs remain release blockers.

Delivered:

1. Authenticated `/v1/engineer/runs` intake/read/freeze/start/events/artifact routes.
2. Durable `QUEUED` dispatch acknowledgment and queued-run recovery on gateway restart.
3. Exact-base, per-run Git worktrees and unique local run branches.
4. Pinned-digest Docker execution with no network, read-only rootfs, non-root UID,
   dropped capabilities, no-new-privileges, CPU/memory/PID limits, and bounded output/time.
5. Atomic warm-pool reservation, exact base/origin/lockfile/image/toolchain validation,
   quarantine on failure, cold fallback, and one-time destruction after claim.
6. Frozen-manifest path/command enforcement, symlink and `.git` denial, argv-only
   command execution, and no Builder Git/PR/deployment tools or credentials.
7. Content-addressed immutable artifacts with size limits and read-time hash verification.
8. Current fixed OpenAI tier resolution (`gpt-5.6-sol`, `gpt-5.6-terra`,
   `gpt-5.6-luna`) and a `store:false` Responses API Codex Builder loop with strict
   function tools, bounded rounds/mutations, model-call metadata, and real Git diff output.
9. Supervisor-owned persistence of sandboxes, agent executions, model routing/model
   calls, command executions, stdout/stderr artifacts, and Builder result metadata.

The worker deliberately stops at `FAST_CHECKS`. Builder-requested commands are recorded,
but they do not satisfy Phase-3 independent verification gates.

### Phase 3 — verification

Status: partial for the local single-repository verification slice. Independent
evidence and Reviewer isolation exist; failed-test Builder repair, complete
failure classification, and the mandatory evaluation matrix remain incomplete.

Delivered:

1. Independent execution of every frozen test-plan command through the trusted
   executor, with ordered fast, unit, integration/migration/regression, optional
   E2E, and security gates.
2. Deterministic diff security checks plus a separate TERRA Security advisory;
   only trusted executor/system evidence can satisfy a correctness gate.
3. TERRA Tester and Security calls with strict structured tools and no workflow
   mutation authority.
4. A fresh SOL Reviewer request per attempt using `store:false`, no previous
   response, no repository map or Builder narrative, and only the manifest,
   exact final diff, and filtered trusted evidence.
5. Hash binding across the manifest, result commit, diff, and Reviewer evidence;
   tampering invalidates the Reviewer input before a decision can be accepted.
6. Structured Reviewer decisions and normalized findings persisted in the ledger.
7. Bounded `REQUEST_CHANGES` repair loops that pass only structured findings to a
   restricted Builder, then rerun all verification and start a new Reviewer session.
8. Acceptance claims that default to `UNVERIFIED` when evidence is missing or
   untrusted, plus immutable hash-bound evidence bundles.
9. Gateway orchestration through the `REVIEW_APPROVED` phase boundary and
   authenticated claims/evidence read endpoints.

Exit criteria: package and gateway typechecks, isolation/tamper tests, approval,
and repair-loop tests pass; publication remains unavailable.

### Phase 4 — human control and publication

Status: partial for the configured GitHub publication slice. Publication contracts
and hash gates exist, but authenticated actor ownership, assigned-reviewer
enforcement, token-backed Git transport, and a live private-repository proof are
still required.

Delivered:

1. Hash-bound approval requests with assigned reviewer, risk tier, reminders,
   deadline, timeout action, and exact manifest/diff/evidence hashes.
2. Human approve, request-changes, reject, deadline-extension, and cancellation
   APIs. Expired approvals fail closed as `HUMAN_REVIEW_REQUIRED`.
3. Periodic gateway recovery/sweeping of overdue approval requests.
4. Cancellation evidence, sandbox cleanup, and terminal cancellation/failure paths.
5. A narrow `GitService` interface unavailable to agents, plus a GitHub adapter
   whose credential remains inside the gateway publication boundary.
6. HMAC-authenticated Supervisor PR commands, trusted command artifacts, and
   immutable Git-operation records.
7. Preflight checks for fresh isolated review, exact current diff, passing tests,
   no open critical security findings, complete evidence, human approval when
   required, result commit, and current base branch.
8. Idempotent branch/push/PR operations and trusted-record PR descriptions that
   exclude Builder narrative.
9. Stale-base blocking before remote mutation, with an explicit transition into
   mandatory re-verification.
10. Authenticated approval, diff, tests, security, failures, and control routes.

Live publication is enabled only when the gateway receives an explicit GitHub
credential and a stable publication-command signing secret.

### Phase 5 — Zintus experience

Status: partial for the web and desktop clients. The primary workflow exists;
durable run resume, retry/recovery UX, secure gateway authentication, efficient SSE
replay, and complete error visibility remain incomplete.

Delivered:

1. A TERRA planner using the Responses API with a forced strict structured tool,
   `store:false`, fixed model routing, persisted model-call metadata, and no
   workflow mutation authority beyond the Supervisor facade.
2. Deterministic post-plan risk assignment, fixed prohibited commands, immutable
   proposal artifacts, and a durable `plan_proposals` schema migration.
3. Authenticated plan generation/read routes and an OpenAPI 3.1 contract.
4. A new-run flow that binds the task to an exact base commit rather than a mutable
   branch tip.
5. Structured plan review for acceptance criteria, tests, scope, commands, risk,
   human-gate policy, and the final freeze/start action.
6. Live durable timeline, verification summary, hash-bound diff, acceptance
   evidence, security findings, human decisions, cancellation, and explicit final
   or safe-failure outcomes.
7. Engineer navigation and command-palette entries in the existing responsive web
   and desktop Zintus shells, using their current design tokens and reduced-motion
   behavior.

The experience remains intentionally workflow-shaped rather than chat-shaped.

### Phase 6 — hardening and demo

Status: validation scaffolding implemented; **not a release candidate**. The audit
fixtures cover several invariants, but end-to-end OpenAI/Docker/GitHub execution,
restart recovery, budgets, LUNA runtime roles, and the full architecture evaluation
suite have not passed.

Delivered:

1. Executed fixtures for prompt-injection command attempts, sandbox timeouts,
   infinite repair loops, flaky tests, concurrent Supervisor writers, artifact
   tampering/cross-run references, and poisoned warm-pool entries.
2. Planner-time command-policy rejection in addition to the executor's frozen
   allowlist, argv-only parsing, and no-shell enforcement.
3. Fail-closed flaky-test confirmation: a failed non-security test is repeated at
   the same commit/environment; mixed or incomparable evidence is quarantined and
   cannot satisfy a correctness gate.
4. Periodic warm-pool health sweeping with invalid, expired, and over-capacity
   quarantine. Claimed workspaces remain one-use and are never returned.
5. An authenticated durable observability snapshot for run states, risk tiers,
   pending approvals, and failure classes.
6. A deliberately failing password-reset demo repository, operator README,
   recording checklist, and safe-failure alternate.

Exit criteria: 51 Engineer package tests, 81 gateway/OpenAPI tests, package,
gateway, web, and desktop typechecks pass. The demo fixture's one intentional
single-use-token failure is separately confirmed.

## Commit strategy

Each phase is one or more reviewable `feat(engineer): ...` commits. A later phase
may not weaken a phase-1 invariant. Schema changes are additive migrations; frozen
manifest versions and ledger events are never rewritten.
