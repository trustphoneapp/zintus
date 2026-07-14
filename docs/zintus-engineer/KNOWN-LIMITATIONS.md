# Zintus Engineer known limitations

- The current execution slice supports one explicitly configured local repository.
  GitHub connection and supervisor-only PR publication arrive in Phase 4.
- `QUEUED` dispatch survives restart. A process that dies after sandbox claim is
  visible in the ledger, but automated orphan reconciliation and heartbeat-driven
  cleanup are Phase-6 hardening work.
- The warm pool provides atomic one-time claims, TTL rejection, validation,
  quarantine, and cold fallback. Minimum/maximum pool maintenance, periodic health
  replacement, and poisoned-cache quarantine automation are not yet scheduled.
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
- SSE recovery replays the durable event ledger, but relay/mobile UX for reconnect
  cursors is part of the later Zintus experience phase.
