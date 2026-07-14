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
| Backend | Bun HTTP gateway; Hono Cloudflare relay | Add authenticated `/v1/engineer` gateway routes in later phases |
| Package manager | Bun workspaces and `bun.lock` | Add a workspace package and use existing scripts |
| Database | Machine-local `bun:sqlite`; Drizzle-backed stores; Cloudflare D1/KV for cloud | Use owner-only SQLite/WAL for the local phase-1 ledger; keep a storage interface suitable for a later D1/Postgres adapter |
| Authentication | Gateway bearer token; relay email/Google sessions and scoped gateway credentials | Reuse the gateway boundary; persist the authenticated user ID on every run |
| Model routing | `@zintus/router` with capability, quota, failover, and structured-output routing | Add centrally enforced Engineer role-to-tier routing in a later phase; agents never pick their tier |
| Streaming | Existing SSE chat, research, and agent event streams; relay WebSocket | Reuse SSE for run timelines and the relay for remote clients |
| Queue/workers | No durable general-purpose queue; gateway agent tasks are in-process with persisted checkpoints | Phase 1 is synchronous application logic; add a durable worker queue before remote autonomous execution |
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

### Phase 1 — foundation (this increment)

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

Add authenticated gateway run endpoints, durable work dispatch, sandbox claim/cold
fallback, exact-base Git workspaces, trusted command execution, artifact capture,
provider resolution for the fixed role tiers, and Codex Builder integration. Builder credentials
have no push, PR, merge, deployment, or branch-protection authority.

### Phase 3 — verification

Add independent test/security execution, fresh isolated Reviewer sessions,
sentinel isolation tests, Reviewer-triggered bounded repair loops, claim-to-evidence
mapping, and hash-bound evidence bundles.

### Phase 4 — human control and publication

Add risk-aware approval deadlines, cancellation/recovery, retry exhaustion,
supervisor-only Git service and PR preflight/idempotency, stale-base re-verification,
and explicit failure presentation.

### Phase 5 — Zintus experience

Add plan review, live timeline, diff/evidence panels, human gate, and final result
inside existing Zintus clients. The primary experience is a workflow, not chat.

### Phase 6 — hardening and demo

Add prompt-injection, sandbox, loop, flaky, concurrency, artifact-tamper, and
cross-run isolation fixtures; observability; the sample repository; README; and
three-minute demo assets.

## Commit strategy

Each phase is one or more reviewable `feat(engineer): ...` commits. A later phase
may not weaken a phase-1 invariant. Schema changes are additive migrations; frozen
manifest versions and ledger events are never rewritten.
