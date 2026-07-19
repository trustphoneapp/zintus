# Zintus Engineer known limitations

> Release status: **not production-ready**. See
> [RELEASE-AUDIT-2026-07-14.md](./RELEASE-AUDIT-2026-07-14.md) for the verified
> architecture comparison, fixed defects, activation evidence, and prioritized
> TERRA/LUNA work lanes.

- The current execution slice supports one explicitly configured local checkout.
  Supervisor-only GitHub publication is available, but multi-repository connection
  management is not yet implemented.
- `QUEUED` dispatch and every Phase 2 in-progress execution state survive restart
  through durable fenced leases, bounded heartbeats, watchdog recovery, clean
  exact-base requeue, and orphaned Phase 2 worktree cleanup. Every active Phase 3
  verification/repair state also recovers from an immutable retained-sandbox
  checkpoint and restarts independent verification from `FAST_CHECKS`.
  Phase 4 publication states also recover on gateway restart by rechecking the
  remote base/protection policy and discovering an already-created PR first.
- The warm pool provides atomic one-time claims, TTL rejection, validation,
  quarantine, cold fallback, one-time destruction after claim, and a periodic
  maximum/health sweep. The gateway replenishes one clean workspace per sweep
  toward `ZINTUS_ENGINEER_WARM_POOL_MIN`, bounded by the configured maximum and
  keyed to the current canonical base. It deliberately avoids burst rebuilding.
- Docker storage quota enforcement relies on the host Docker/runtime configuration;
  the feature directly enforces CPU, memory, PIDs, time, output, privilege, and
  network limits.
- Dependency-bearing repositories require a verified offline bundle bound to the
  exact lockfile and toolchain hashes. Zintus does not fall back to a networked
  install or an unverified host `node_modules` tree.
- This checkout has not produced live Phase 2 activation evidence because the
  current host has no Docker-compatible runtime or canonical
  `ZINTUS_ENGINEER_*` execution configuration. `bun run doctor:engineer` fails
  closed until those external prerequisites are supplied.
- GitHub publication requires `ZINTUS_ENGINEER_PUBLICATION_SECRET` and
  `ZINTUS_ENGINEER_GITHUB_TOKEN`. Remote operations use the canonical GitHub HTTPS
  URL and an ephemeral askpass credential rather than ambient Git credentials.
  Tests exercise the service boundary but do not create a real external PR; that
  activation proof requires an authorized private test repository.
- A stale remote base is detected before mutation. Controlled recovery fetches
  the credentialed current base, advances only the canonical SHA, supersedes the
  old approval, and creates a new immutable run that repeats context, planning,
  execution, verification, fresh SOL review, and human approval. Automatic merge
  conflict resolution is intentionally not attempted.
- TERRA Tester and Security outputs are intentionally advisory. Deterministic
  checks and trusted command records remain authoritative, so the current security
  scan depth is limited to the frozen commands plus the built-in diff scanner.
  LUNA failure triage is likewise advisory and is invoked only after a deterministic
  failure classification. SOL remains reserved for Builder/Reviewer reasoning.
- Web and desktop replay the durable SSE ledger with `Last-Event-ID`/sequence
  cursors, heartbeat comments, bounded pages, duplicate/gap checks, and bounded
  reconnect. Web, desktop, and mobile reopen server-side durable history; mobile
  polls run detail while focused instead of maintaining an SSE connection.
- The gateway represents one authenticated local installation/owner. Client actor
  fields cannot alter authority; organization-scale multi-user RBAC and reviewer
  assignment remain outside this local Phase 4 slice.
- Runtime budget contracts now fail closed for unknown pricing and bound time,
  tokens, cost, command duration, diff size, artifact bytes, and concurrent agents.
  Every SOL/TERRA/LUNA call reserves its conservative worst case before transport
  and atomically reconciles the durable reservation to actual reported usage.
  A client-side provider timeout is inherently ambiguous: the remote request may
  still complete after the client disconnects. Zintus reports that amount as an
  unsettled reservation, never labels it settled spend, and never automatically
  replays the identical request. A human may retry twice from the retained
  workspace checkpoint without rerunning planning.
  Responses cached-read/cache-write details are persisted separately and priced
  through the dated model catalog. Providers that omit these fields remain an
  honest zero rather than an inferred cache hit.
- The gateway exposes and clients prefill the one authenticated canonical
  repository and exact base commit. Multi-repository connection management and an
  organization repository picker remain future product work.
- Flake confirmation runs after an initial failed non-security check and blocks
  mixed outcomes. It is intentionally not a broad statistical flake service and
  does not make a failing security check retryable.
- Provider-side final usage reconciliation for a request that completed after a
  client timeout requires provider request-status or billing-export integration.
  Until that exists, the conservative reservation remains visible and continues
  to reduce the run's available allowance.

## P12 release-gate postures (single-tenant GO)

- **Single-tenant only (P12 Finding C — Sol P1-3 / Luna-2).** `EngineerLedger` is
  single-tenant by design. `tenantOrgId` is fixed to `ENGINEER_DEFAULT_ORG_ID` and
  the constructor **rejects** any non-default org with `multi-tenant is not yet
  supported`. The runtime is safe because `deriveEngineerPrincipal` mints exactly
  one owner per install, and the P7 Resolution Desk read/mutate routes
  (`getCase`/`listCases`/`issueDirective`/`applyDirective`, not only `createCase`)
  owner-check every case/directive against that owner. What is NOT wired: real
  per-tenant isolation — `EngineerLedger` runs ~120 bare `WHERE run_id=?` queries
  that are not org-scoped, and `TenantScopedLedgerDal` (the isolation-tested
  multi-tenant DAL) is not the path the ledger/gateway route through. Do not claim
  tenant isolation.
- **Provenance attestation formally deferred (P12 Finding A — Sol P1-1 / Luna-1).**
  The v35 provenance attestation binds a result git *tree* hash for the verified
  candidate. That tree hash is not durably recorded for an ORIGINAL verified
  candidate (only `result_commit_sha` is) and deriving it needs a real
  `git rev-parse <sha>^{tree}` object read that is not wired to the v33 selection
  at publication time. Posture: attestation is gated behind the explicit env flag
  `ENGINEER_PROVENANCE_ATTESTATION_REQUIRED` (default **unset = not required =
  deferred**). When unset, publication approval proceeds without an attestation —
  a documented, deliberate deferral, not a silent fail-open. When set true,
  attestation is required and, because the tree hash cannot be sourced today,
  approval **fails closed (503) with no P8 approval written** — absence of a
  required attestation denies publication, never allows an unattested publish. If
  the flag is true but no signer authority is configured, the gateway withholds
  the publication authority entirely. When attestation is required and feasible,
  the P8 approval and its v35 attestation are made atomic by compensation: if the
  attestation emission throws after the P8 approval commits, the facade
  invalidates the just-created P8 approval before rethrowing, so no live approval
  can exist without its required attestation. To make attestation functional and
  flip the default to required: durably record/derive the result tree hash at
  promotion and thread it through `resultTreeHashFor`.
- **Source freeze now covers the live v33 publication tables (P12 Finding B — Sol
  P1-2).** Migration **v37** adds `freeze_source_*_v37` triggers on
  `publication_candidate_selections_v33`, `publication_approvals_v33`, and
  `publication_git_operations_v33`, so a terminal source run with an open
  resolution case can no longer be driven selectCandidate → approve → dispatch to
  publish on a frozen source. (v36 is reserved by contract §1 and skipped.)
