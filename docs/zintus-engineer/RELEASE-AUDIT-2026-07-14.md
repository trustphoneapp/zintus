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

## Release blockers

### TERRA lane — architecture and orchestration

1. Implement the Builder repair loop after failed verification. A failing required
   test currently ends at `VERIFICATION_INCOMPLETE`; the demo cannot repair its
   intentionally failing token-reuse test.
2. Add a real Context Engine. Planning currently receives only repository metadata
   and the request, so allowed paths, commands, and tests are guesses rather than
   repository-grounded decisions.
3. Move blocking Git, Docker, and test execution out of the gateway event loop into
   supervised workers with leases, heartbeats, cancellation, and bounded
   concurrency.
4. Implement restart recovery for every active state, publication resume,
   stale-base re-verification, `FIX_REQUESTED`, and `PR_CREATION_FAILED`.
5. Enforce manifest time, token, and cost budgets and every retry budget at the
   authoritative worker boundary.
6. Recompute risk after the actual diff, tests, coverage, retries, changed paths,
   dependencies, schema changes, and security findings. Planning-time model
   features must not be the final authority.
7. Make base-branch inspection and publication an atomic stale-base decision;
   enforce branch protection rather than merely recording it.
8. Provide offline dependencies or a content-addressed cache in the network-denied
   sandbox. A stock Bun image plus an ignored `node_modules` worktree cannot run
   dependency-bearing projects.

### LUNA lane — classification, safety, and recovery

1. Invoke LUNA for request, risk-feature, and failure classification. The LUNA role
   mappings currently have no production call sites.
2. Add deterministic request/path/diff feature floors so a model cannot conceal
   authentication, authorization, payment, secret, migration, or infrastructure
   risk.
3. Persist a `FailureRecord` for every model, sandbox, command, dependency,
   verification, Git, timeout, and cancellation failure; use it for retry and
   observability decisions.
4. Add timeout and heartbeat watchdogs using the existing runtime-policy and
   heartbeat schema, then prove recovery after process termination.
5. Fail startup when required models, model capabilities, Docker, the pinned image,
   repository access, or publication credentials are unavailable.
6. Add run ownership and authenticated actor binding. Client-supplied `userId` and
   `actorId` are not identities, and assigned reviewers are not currently enforced.
7. Route private-repository Git operations through the configured credential
   boundary; REST uses the GitHub token while `git push` currently depends on
   ambient Git credentials.

## Experience and observability gaps

- A failed plan leaves the UI without a retry-plan action.
- Freeze success followed by start failure can leave client and server states out
  of sync.
- SSE refreshes the full evidence surface per event, has no resume cursor, and can
  issue a large concurrent request burst on replay.
- Reload cannot reopen a durable run because there is no run list or URL/local run
  identity.
- The UI does not surface every manager `lastError` and has no dedicated
  observability page.
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

- Engineer plus gateway focused suite: 123 passed, 0 failed.
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
| SOL Builder and isolated SOL Reviewer | Partial: roles exist; failed-test repair loop missing |
| TERRA planning/testing/security | Partial: runtime calls exist; planning lacks repository context |
| LUNA classification roles | Not implemented at runtime |
| Offline Docker sandbox | Partial: policy exists; dependencies and live Docker proof missing |
| Independent verification and claim evidence | Partial: executable gates exist; full evaluation matrix missing |
| Human approval and Supervisor publication | Partial: hash binding exists; actor identity and live Git proof missing |
| Risk, retries, and budgets | Partial: deterministic rules exist; final reassessment and enforcement missing |
| Web/desktop workflow | Partial: main screen exists; recovery/resume/error paths incomplete |
| Mobile, observability, operations | Incomplete |
