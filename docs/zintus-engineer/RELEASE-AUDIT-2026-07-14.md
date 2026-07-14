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

## Post-audit Phase 2 closure

The later Phase 2 closure batch removed blocking Git/Docker/test processes from
the authoritative worker path, added immutable offline dependency provisioning,
and added clean exact-base watchdog recovery for every Phase 2 active state.
Automated fault-injection and typecheck evidence now covers those boundaries.
The release verdict remains fail-closed because this host has no Docker runtime;
the strengthened `bun run doctor:engineer` requires a real hardened container and
currently returns `ok: false` rather than accepting simulated activation evidence.

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
3. Implement restart recovery for every active state, publication resume,
   stale-base re-verification, `FIX_REQUESTED`, and `PR_CREATION_FAILED`.
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

1. Invoke LUNA for request, risk-feature, and failure classification. The LUNA role
   mappings currently have no production call sites.
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

## Experience and observability gaps

- SSE has no resume cursor and still refreshes the evidence surface after a
  coalesced event burst rather than consuming event deltas.
- Reload restores the locally active run, but there is no server-side run list or
  shareable run URL for reopening other durable runs.
- There is no dedicated Engineer observability page.
- Mobile has no Engineer workflow.
- The secure `GATEWAY_TOKEN` operator mode is not usable by the browser UI because
  it intentionally sends no bearer token. Authentication-disabled loopback mode is
  not a sufficient identity boundary for approval or publication.

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

- Engineer plus gateway focused suite: 129 passed, 0 failed.
- Root typecheck: passed for core, gateway, web, desktop, and mobile.
- Root test command: 1,229 passed and 5 failed. All five failures are the existing
  gateway MCP stdio bridge integration file. The lower-level MCP stdio integration
  tests pass, and the same gateway registry succeeds outside Bun's test runner.
- Real Docker, live OpenAI SOL/TERRA/LUNA calls, restart recovery, authenticated
  approval, and GitHub publication remain unverified.

## Architecture conformance summary

| Architecture area | Status |
| --- | --- |
| Durable Supervisor/state ledger | Partial: strong transition core; recovery/watchdogs incomplete |
| Frozen manifest and evidence binding | Implemented, with audit hardening |
| SOL Builder and isolated SOL Reviewer | Implemented in code, including bounded failed-test and review repair; live model proof missing |
| TERRA planning/testing/security | Partial: runtime calls exist; planning lacks repository context |
| LUNA classification roles | Partial: deterministic durable failure taxonomy exists; LUNA model roles have no production call sites |
| Offline Docker sandbox | Partial: policy exists; dependencies and live Docker proof missing |
| Independent verification and claim evidence | Partial: executable gates exist; full evaluation matrix missing |
| Human approval and Supervisor publication | Partial: hash binding exists; actor identity and live Git proof missing |
| Risk, retries, and budgets | Partial: deterministic rules exist; final reassessment and enforcement missing |
| Web/desktop workflow | Partial: main workflow, local recovery, resume, retry, and error paths exist; run list/cursor/operations views missing |
| Mobile, observability, operations | Incomplete |
