# Zintus Engineer known limitations

> Release status: **not production-ready**. See
> [RELEASE-AUDIT-2026-07-14.md](./RELEASE-AUDIT-2026-07-14.md) for the verified
> architecture comparison, fixed defects, activation evidence, and prioritized
> TERRA/LUNA work lanes.

- The current execution slice supports one explicitly configured local checkout.
  Supervisor-only GitHub publication is available, but multi-repository connection
  management is not yet implemented.
- `QUEUED` dispatch survives restart. Execution now uses durable fenced leases,
  bounded heartbeats, watchdog recovery, and shutdown draining. Recovery for every
  verification/publication state and every orphaned container/worktree is not yet complete.
- The warm pool provides atomic one-time claims, TTL rejection, validation,
  quarantine, cold fallback, one-time destruction after claim, and a periodic
  maximum/health sweep. It does not yet replenish to a configured minimum or
  proactively rebuild quarantined capacity.
- Docker storage quota enforcement relies on the host Docker/runtime configuration;
  the feature directly enforces CPU, memory, PIDs, time, output, privilege, and
  network limits.
- GitHub publication requires `ZINTUS_ENGINEER_PUBLICATION_SECRET` and
  `ZINTUS_ENGINEER_GITHUB_TOKEN`, plus a configured Git remote that accepts the
  verified commit. Tests use an in-memory Git-service boundary and do not create a
  real external pull request.
- A stale remote base is detected before mutation and forced into `REVERIFYING`.
  Automated conflict resolution is intentionally not attempted; the candidate
  branch must be recreated/rebased by the controlled stale-base worker before the
  complete Phase-3 verification pipeline runs again.
- TERRA Tester and Security outputs are intentionally advisory. Deterministic
  checks and trusted command records remain authoritative, so the current security
  scan depth is limited to the frozen commands plus the built-in diff scanner.
- Web and desktop replay the durable SSE ledger with `Last-Event-ID`/sequence
  cursors, heartbeat comments, bounded pages, duplicate/gap checks, and bounded
  reconnect. Mobile-specific Engineer screens are not yet implemented.
- Runtime budget contracts now fail closed for unknown pricing and bound time,
  tokens, cost, command duration, diff size, artifact bytes, and concurrent agents.
  Every SOL/TERRA/LUNA call reserves its conservative worst case before transport
  and atomically reconciles the durable reservation to actual reported usage.
  Cached-token usage details are not yet stored, so billing evidence deliberately
  prices all reported input at the higher uncached rate.
- New-run repository metadata and the exact base commit are entered directly in
  this local-first slice. A connected repository picker and automatic branch-tip
  resolution require the future repository-connection service; the server still
  validates and records the exact submitted commit.
- Flake confirmation runs after an initial failed non-security check and blocks
  mixed outcomes. It is intentionally not a broad statistical flake service and
  does not make a failing security check retryable.
