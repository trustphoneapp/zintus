# Zintus Engineer demo repository

This deliberately vulnerable, deterministic fixture is the pinned repository for
the three-minute demo. Its password-reset token remains reusable after the first
successful consumption. The test suite contains the real failing assertion; no UI
status or command result is hardcoded.

```bash
cd examples/zintus-engineer-demo
bun test
```

Expected baseline: the expiry and privacy/rate-limit tests pass, while the
single-use test fails. Ask Engineer:

> Make password-reset tokens single-use while preserving 15-minute expiry,
> privacy-preserving responses, rate limiting, and tests.

For a recording, initialize this directory as its own Git repository, commit the
baseline, and submit that exact commit SHA. The normal test command is `bun test`;
the allowed paths are `src/**` and `test/**`.
