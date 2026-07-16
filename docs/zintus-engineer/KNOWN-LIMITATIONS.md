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
