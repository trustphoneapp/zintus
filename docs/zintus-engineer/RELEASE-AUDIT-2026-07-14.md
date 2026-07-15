# Zintus Engineer release audit — 2026-07-14

## Verdict

The six-phase implementation contains the intended vertical skeleton, but it is
not yet an activated or production-ready implementation of the complete
architecture. The Supervisor, durable ledger, frozen manifest, sandbox boundary,
independent verification, isolated Reviewer, human approval, publication facade,
and web/desktop workflow all exist. Several mandatory authority, recovery,
identity, budget, context, and operational paths remain incomplete.

Do not enable real repository mutation or GitHub publication until every release
blocker below is closed and the end-to-end Docker/OpenAI/GitHub evaluation passes.

## Phase 4 completion update

The local single-owner Phase 4 implementation is complete. Server-owned install
identity controls ownership and assigned review; client actor fields have no
authority. GitHub transport now uses an ephemeral askpass credential, the current
versioned REST API, enforced branch-protection evidence, deterministic PR
discovery, and durable restart recovery. A hash-bound 12-scenario adversarial
matrix covers authority, approval, cancellation, publication, security, and
recovery. The remaining Phase 4 release gate is external activation against an
authorized private repository; organization-scale multi-user RBAC is a later
product capability.

## Post-audit Phase 2 closure

The later Phase 2 closure batch removed blocking Git/Docker/test processes from
the authoritative worker path, added immutable offline dependency provisioning,
and added clean exact-base watchdog recovery for every Phase 2 active state.
Automated fault-injection and typecheck evidence now covers those boundaries.
The release verdict remains fail-closed because this host has no Docker runtime;
the strengthened `bun run doctor:engineer` requires a real hardened container and
currently returns `ok: false` rather than accepting simulated activation evidence.

## Post-audit Phase 3 closure

The later Phase 3 closure batch added the missing hash-bound criterion/test and
16-scenario adversarial matrices, complete verification failure reasons, mandatory
HIGH/CRITICAL security gates, criterion-bound claim evidence, bounded LUNA failure
triage, stale Reviewer-decision detection, and restart recovery for every active
verification/repair state. The Engineer plus gateway source suite now passes in
full. This closes the Phase 3 source blockers identified below; live Docker and
OpenAI proof remains unavailable on this host and is not represented as passed.

## Post-audit Phase 5/6 closure

The local single-owner source scope now includes authenticated canonical
repository discovery, server-side run reopening, controlled stale-base replacement
runs, durable Git-operation visibility, bounded warm-pool replenishment,
owner-only/symlink-resistant storage, cached-token cost evidence, an operations
dashboard, and web/desktop/mobile workflows. A hash-bound 17-scenario Phase 5/6
matrix maps these hardening claims to executable tests. Publication additionally
requires gateway bearer authentication; browser operator authority is memory-only.

This closes the source gaps previously listed under experience and operations.
It does not manufacture external activation evidence: live Docker, OpenAI, and an
authorized GitHub private repository are still required before production use.

## Fixed during this audit

- A client can no longer downgrade Supervisor risk or remove a human gate while
  freezing a plan. Freeze is bound to both the authoritative risk decision and
  the persisted proposal hash.
- Executable `SECURITY` test-plan items can now persist evidence in
  `SECURITY_REVIEW`.
- Invalid intake is validated before the SQLite transaction, preventing an
  oversized request or identifier from poisoning all subsequent ledger reads.
- Reviewer `APPROVE` is rejected unless every MUST criterion has trusted evidence;
  approvals with unsupported claims or open HIGH/CRITICAL findings are invalid.
- Cancellation now reaches `CANCELLED` even when publication is disabled.
- Docker command runtime variables are explicitly passed into the container,
  while Docker client environment remains host-side.
- The provisional MEDIUM intake tier can become LOW before freeze only when the
  deterministic low-risk eligibility rules pass. HIGH/CRITICAL and post-freeze
  floors remain monotonic.
- Engineer mutation endpoints now share gateway rate limiting and redact secrets
  from returned errors.
- Stable failures of frozen MUST checks now enter a bounded SOL Builder repair
  loop. Each attempt consumes the authoritative retry budget, rejects identical
  or no-progress patches, and restarts independent verification from FAST_CHECKS.
- Planning and independent-verification failures now produce durable categorized
  `FailureRecord` entries, including malformed model output, unsafe proposed
  commands, flaky tests, blocked sandbox commands, stable required-test failures,
  failed security checks, and critical findings.
- Human decisions are restricted to the assigned reviewer and cancellation is
  restricted to the run owner. This is defense in depth until gateway actors are
  derived from authenticated server-side identity rather than request fields.
- Web and desktop can restore the active run after reload, retry a failed planning
  call, resume a frozen run, display manager errors, avoid stale SSE refreshes,
  and render progress from durable workflow state rather than event count.

## Release blockers

### TERRA lane — architecture and orchestration

1. Add a real Context Engine. Planning currently receives only repository metadata
   and the request, so allowed paths, commands, and tests are guesses rather than
   repository-grounded decisions.
2. Move blocking Git, Docker, and test execution out of the gateway event loop into
   supervised workers with leases, heartbeats, cancellation, and bounded
   concurrency.
3. Phase 3 restart recovery is complete. Publication resume, stale-base worker
   completion, `FIX_REQUESTED`, and `PR_CREATION_FAILED` remain Phase 4 work.
4. Enforce manifest time, token, and cost budgets and every retry budget at the
   authoritative worker boundary.
5. Recompute risk after the actual diff, tests, coverage, retries, changed paths,
   dependencies, schema changes, and security findings. Planning-time model
   features must not be the final authority.
6. Make base-branch inspection and publication an atomic stale-base decision;
   enforce branch protection rather than merely recording it.
7. Provide offline dependencies or a content-addressed cache in the network-denied
   sandbox. A stock Bun image plus an ignored `node_modules` worktree cannot run
   dependency-bearing projects.

### LUNA lane — classification, safety, and recovery

1. LUNA now has a bounded production failure-triage call site. Request and
   risk-feature classification remain deterministic/Phase-5 follow-up work.
2. Add deterministic request/path/diff feature floors so a model cannot conceal
   authentication, authorization, payment, secret, migration, or infrastructure
   risk.
3. Complete durable `FailureRecord` coverage for execution, dependency, Git,
   publication, timeout, and cancellation failures. Planning and verification
   failures are now categorized, persisted, and used by the repair policy.
4. Add timeout and heartbeat watchdogs using the existing runtime-policy and
   heartbeat schema, then prove recovery after process termination.
5. Fail startup when required models, model capabilities, Docker, the pinned image,
   repository access, or publication credentials are unavailable.
6. Bind run ownership and approval actors to authenticated server-side identity.
   Assigned-reviewer and owner comparisons are enforced, but client-supplied
   `userId` and `actorId` remain spoofable request fields.
7. Route private-repository Git operations through the configured credential
   boundary; REST uses the GitHub token while `git push` currently depends on
   ambient Git credentials.

## Remaining product-scale gaps

- The gateway represents one authenticated local owner and one canonical
  repository. Organization RBAC, reviewer assignment, and multi-repository
  connection management remain outside the local scope.
- Mobile uses bounded polling rather than the web/desktop durable SSE cursor.
- Distributed workers, hosted artifact retention, and fleet-scale alert delivery
  remain future operational work.

## Activation evidence on this machine

- Source gateway health, observability, intake, safe planning failure, cancellation,
  and durable terminal counts were exercised successfully.
- Planning correctly refused to run without an OpenAI BYOK key.
- End-to-end execution could not be activated: Docker is absent and all required
  `ZINTUS_ENGINEER_*` execution/publication variables are unset.
- The installed Zintus application process predates the later phases and does not
  expose the Engineer observability endpoint.
- Next.js starts under the installed Node 24 runtime but crashes in a native async
  callback; running Next under Bun listens but does not serve the route. Browser UI
  validation is therefore blocked by the local runtime, not counted as passed.

## Validation results

- Engineer package suite: 123 passed, 0 failed across 23 files.
- Root typecheck: passed for core, gateway, web, desktop, and mobile.
- Root test command: passed every command group with zero failures and includes
  the Phase 3, Phase 4, and Phase 5/6 mandatory evaluation matrices.
- Real Docker, live OpenAI SOL/TERRA/LUNA calls, live process-kill recovery,
  authenticated approval, and GitHub publication remain unverified externally.

## Architecture conformance summary

| Architecture area | Status |
| --- | --- |
| Durable Supervisor/state ledger | Implemented for execution, verification, approval, publication, and stale-base replacement recovery |
| Frozen manifest and evidence binding | Implemented, with audit hardening |
| SOL Builder and isolated SOL Reviewer | Implemented in code, including bounded failed-test and review repair; live model proof missing |
| TERRA planning/testing/security | Implemented with exact-base Context Engine input; outputs remain advisory outside structured planning |
| LUNA classification roles | Partial: deterministic taxonomy plus advisory failure-triage call site; request/risk model calls remain optional |
| Offline Docker sandbox | Implemented in source with immutable dependency bundles and warm replenishment; live Docker proof missing |
| Independent verification and claim evidence | Implemented in source with criterion binding and a 16-scenario mandatory matrix; live activation proof missing |
| Human approval and Supervisor publication | Implemented for the authenticated local owner; live Git proof and organization RBAC remain |
| Risk, retries, and budgets | Implemented with deterministic reassessment, bounded retries, reservations, and measured cache-aware cost |
| Web/desktop workflow | Implemented with durable history, cursor replay, evidence export, publication operations, and recovery |
| Mobile, observability, operations | Implemented for local scope; mobile uses bounded polling and fleet alerting remains deferred |
