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
- Phase 2 Builder results are not verified completion. The run ends this slice at
  `FAST_CHECKS`; Phase 3 must independently test, scan, review, and construct the
  evidence bundle.
- SSE recovery replays the durable event ledger, but relay/mobile UX for reconnect
  cursors is part of the later Zintus experience phase.
