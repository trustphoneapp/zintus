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
- Phase 3 can reach `REVIEW_APPROVED`, but that is a verification boundary rather
  than published completion. Human approval, stale-base checks, remote push, and
  PR creation arrive in Phase 4.
- TERRA Tester and Security outputs are intentionally advisory. Deterministic
  checks and trusted command records remain authoritative, so the current security
  scan depth is limited to the frozen commands plus the built-in diff scanner.
- SSE recovery replays the durable event ledger, but relay/mobile UX for reconnect
  cursors is part of the later Zintus experience phase.
