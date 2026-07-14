# Zintus Engineer — 16-task implementation batch

Date: 2026-07-14

This batch implements the first context-and-decision slice as one set of sixteen tasks. A task is marked `PASS` only when its local implementation and automated checks pass. External capability checks remain fail-closed.

| # | Deliverable | Result |
|---:|---|---|
| 1 | Server-derived install identity, owner, reviewer, session, and safety identity | PASS |
| 2 | Mandatory model, Docker, immutable-image, repository, and publication preflight | PASS |
| 3 | Context contracts and durable schema | PASS |
| 4 | Exact-base, hook-free, bounded Git-object context scanner | PASS |
| 5 | Context artifact persistence and PLAN_READY proposal binding | PASS |
| 6 | Context adversarial fixtures and regression tests | PASS |
| 7 | Judge fixture and fail-closed Engineer doctor | PASS (local machine reports missing configuration and Docker) |
| 8 | Integrated D1 regression/typecheck gate | PASS |
| 9 | Decision, evidence, and resolution contracts/tables | PASS |
| 10 | Deterministic ASK_NOW, DEFER, and AUTO policy/lifecycle | PASS |
| 11 | Owner-bound decision read/resolve gateway API | PASS |
| 12 | Planner architecture, assumptions, unresolved questions, and touched-file estimates | PASS |
| 13 | Deterministic ambiguity/risk feature extraction | PASS |
| 14 | Decision inbox, safe options, and end-of-run deferred task summary | PASS |
| 15 | Durable operational failure policy and coverage | PASS |
| 16 | Durable fenced worker leases, heartbeats, watchdog recovery, and execution integration | PASS |

## Safety invariants added

- Repository context is read from immutable Git objects. No checkout or repository hook runs during context construction.
- Git command output, source count, file size, excerpt size, detected paths, and detected commands are bounded.
- Repository content is untrusted and cannot authorize commands, lower deterministic risk, or grant AUTO authority.
- PLAN_READY requires matching persisted context and proposal artifacts; replanning requires a newly hash-bound proposal.
- AUTO requires a reversible LOW-risk recommended choice plus trusted installed-policy evidence.
- Open ASK_NOW/AUTO decisions block progression; unresolved DEFER items block silent completion and are presented as final human tasks.
- Gateway decision writes use the server-owned principal. Client actor IDs do not choose authority.
- Execution workers require an active HMAC capability and monotonic fencing token before worker-owned transitions.
- Expired worker leases are recovered by a durable, concurrency-bounded watchdog and stale workers remain fenced.

## Verification evidence

- Final Engineer, gateway, OpenAPI, and decision-web gate: 377 tests passed, 0 failed, with 3,490 assertions.
- Monorepo TypeScript build/typecheck: passed.
- `git diff --check`: passed.
- Judge fixture: intentionally starts with one reproducible failing test (`Ada-Lovelace` versus `ada-lovelace`) so the demo has a bounded repair target.
- Engineer doctor: correctly failed on this host because canonical Engineer environment variables and Docker are unavailable. It did not downgrade or skip those requirements.

## External activation required

The code is integrated, but a real judge run cannot be claimed on this host until the canonical repository variables, exact base SHA, immutable Docker image digest, Docker daemon, OpenAI BYOK/model capabilities, and (when enabled) GitHub PR-write canary all pass the startup preflight.
