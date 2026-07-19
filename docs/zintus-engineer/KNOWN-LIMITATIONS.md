# Zintus Engineer known limitations

> Release status: **not production-ready**. See
> [RELEASE-AUDIT-2026-07-14.md](./RELEASE-AUDIT-2026-07-14.md) for the verified
> architecture comparison, fixed defects, activation evidence, and prioritized
> TERRA/LUNA work lanes.

> **R0 rebaseline (2026-07-19):** the historical P12 single-tenant GO ruling is
> revoked. A clean full-suite audit found two deterministic test matrices exceeding
> Bun's default five-second test timeout, and the current browser-to-gateway
> publication and corrected-run paths still have release-blocking integration and
> authority gaps. The supported posture remains development/testing only until the
> R1-R6 remediation plan is complete and a new end-to-end release ruling is recorded.

- The current execution slice supports one explicitly configured local checkout.
  The P8 publication schema and HTTP surface are only partially wired: the gateway
  can persist a `PREFLIGHT` operation, but no production route drives dispatch, the
  installed actuator deliberately throws, and the browser cannot complete a durable
  select/approve/publish journey. GitHub publication is therefore unavailable and
  must remain disabled. Multi-repository connection management is also not wired.
- `QUEUED` dispatch and every Phase 2 in-progress execution state survive restart
  through durable fenced leases, bounded heartbeats, watchdog recovery, clean
  exact-base requeue, and orphaned Phase 2 worktree cleanup. Every active Phase 3
  verification/repair state also recovers from an immutable retained-sandbox
  checkpoint and restarts independent verification from `FAST_CHECKS`.
  The legacy Phase 4 manager has restart tests for remote-base/protection rechecks
  and existing-PR discovery. That does not make the new P8 path recoverable: P8
  dispatch, reconciliation, and durable browser hydration remain R3 blockers.
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
- The current host has Docker Desktop 29.6.1 available. Live Phase 2 activation
  evidence still requires canonical `ZINTUS_ENGINEER_*` execution configuration
  and the pinned offline image/bundle; `bun run doctor:engineer` fails closed when
  any of those prerequisites are absent or inconsistent.
- A future enabled GitHub publication path requires `ZINTUS_ENGINEER_PUBLICATION_SECRET` and
  `ZINTUS_ENGINEER_GITHUB_TOKEN`. Remote operations use the canonical GitHub HTTPS
  URL and an ephemeral askpass credential rather than ambient Git credentials.
  Current tests exercise service boundaries but do not establish a reachable real
  external-PR flow. Activation proof requires the R2/R3 authority and dispatch
  repairs plus an authorized private test repository.
- Stale-remote-base recovery exists in the legacy manager, but the new P8 HTTP path
  does not yet connect it to a durable dispatch/reconciliation worker. Automatic
  merge-conflict resolution remains intentionally unsupported.
- TERRA Tester and Security outputs are intentionally advisory. Deterministic
  checks and trusted command records remain authoritative, so the current security
  scan depth is limited to the frozen commands plus the built-in diff scanner.
  LUNA failure triage is likewise advisory and is invoked only after a deterministic
  failure classification. SOL remains reserved for Builder/Reviewer reasoning.
- Web and desktop replay the durable SSE ledger with `Last-Event-ID`/sequence
  cursors, heartbeat comments, bounded pages, duplicate/gap checks, and bounded
  reconnect. Web, desktop, and mobile reopen server-side durable history; mobile
  polls run detail while focused instead of maintaining an SSE connection.
- The gateway represents one authenticated local installation/owner, but that is
  not yet a complete authority boundary. The current candidate-selection facade
  spreads browser-supplied repository, candidate-run, result-SHA, and lineage fields
  into the service request, and its owner/reviewer identifiers are derived from one
  installation secret. Publication must remain disabled until R2 derives candidate
  identity wholly from durable server records, scopes every operation to the owner,
  and supplies a genuinely independent approver context. Organization-scale
  multi-user RBAC and reviewer assignment are not implemented.
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

## P12 release-gate postures (historical GO revoked)

- **Single-tenant development posture only (P12 Finding C — Sol P1-3 / Luna-2).**
  `EngineerLedger.tenantOrgId` is fixed to `ENGINEER_DEFAULT_ORG_ID` and its
  constructor rejects a non-default org. That guard is useful but is not proof of
  production isolation or complete owner authorization. `EngineerLedger` still
  runs many bare `WHERE run_id=?` queries, `TenantScopedLedgerDal` is not the
  ledger/gateway runtime path, and joined repository metadata is not consistently
  scoped to the same organization. Resolution Desk routes contain owner checks,
  but the broader publication facade does not. Do not claim tenant isolation or a
  production-safe single-tenant authority boundary until R2/R4 close these gaps.
- **Provenance attestation formally deferred (P12 Finding A — Sol P1-1 / Luna-1).**
  The v35 provenance attestation binds a result git *tree* hash for the verified
  candidate. That tree hash is not durably recorded for an ORIGINAL verified
  candidate (only `result_commit_sha` is) and deriving it needs a real
  `git rev-parse <sha>^{tree}` object read that is not wired to the v33 selection
  at publication time. Posture: attestation is gated behind the explicit env flag
  `ENGINEER_PROVENANCE_ATTESTATION_REQUIRED` (default **unset = not required =
  deferred**). At the isolated service/facade boundary, leaving it unset permits an
  approval without an attestation. This is a documented deferral, not evidence that
  the browser publication flow is usable; publication remains disabled for the
  independent R2/R3 blockers above. When set true,
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
- **Reverify replacement lane is intentionally disabled in R1.** The case model
  can classify a typed transient failure as otherwise eligible, but the system
  does not yet carry cryptographic authority for the retained pre-verification
  B-prime candidate into a replacement run. The server therefore rejects
  `CREATE_REVERIFY_RUN` with `NO_PRE_VERIFICATION_CANDIDATE` before writing a
  directive or allocating budget, and the Resolution Desk displays the action
  disabled. Use a corrected run for repairable blockers; do not claim reverify
  execution support until retained candidate checkpoint binding is implemented.
- **Source freeze now covers the live v33 publication tables (P12 Finding B — Sol
  P1-2).** Migration **v37** adds `freeze_source_*_v37` triggers on
  `publication_candidate_selections_v33`, `publication_approvals_v33`, and
  `publication_git_operations_v33`, so a terminal source run with an open
  resolution case can no longer be driven selectCandidate → approve → dispatch to
  publish on a frozen source. (v36 is reserved by contract §1 and skipped.)
