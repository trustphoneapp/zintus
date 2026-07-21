# Test evidence

## 2026-07-20 release-gate passes

- Database/Doctor focused matrix: 49 unique tests passed; real v18 disposable copy reached v39 with all source counts and authority hashes preserved.
- Loopback handshake/backend/handler/web matrix: 172 tests passed; live challenge/redeem succeeded, replay returned 401, hostile-origin reuse returned 403.
- Provider and gateway admission regression: 173 tests passed; missing, invalid, unreachable and unsupported provider states remain distinct; affected typechecks passed.
- Deterministic plan/freeze/execute/verify/review/checkpoint matrix: 200 tests passed with `OPENAI_API_KEY` and `TAVILY_API_KEY` removed.
- Budget/recovery/live-UI matrix: 57 tests passed with paid keys removed.
- Resolution/artifact/organization/publication matrix: 605 tests passed across 47 files with paid keys removed.
- Hardened Docker smoke: the exact pinned Bun image ran with network disabled, read-only root, dropped capabilities, no-new-privileges, and bounded PID/memory/CPU settings.

These are pre-final focused totals and overlap by design. The final full-suite total is recorded only after one clean repository-wide run.

## Final exact-working-tree evidence

- `env -u OPENAI_API_KEY -u TAVILY_API_KEY bun test packages/engineer/src/ apps/gateway/src/ apps/web/`: 2,012 passed, 0 failed, 11,831 expectations, 179 files.
- Engineer, Gateway, and Web typechecks: passed.
- `bun run --cwd apps/web build`: passed after moving the proof helper out of the Next.js route module; 49 application routes generated.
- `bun audit --production`: no vulnerabilities found.
- `git diff --check`: passed.
- Changed-diff credential-pattern scan: clear.
- Configured Doctor: `ok: true`, including Docker 29.6.1, exact pinned Bun 1.3.14 image, exact base, dependency bundle, database integrity, disposable schema-39 gateway construction, preserved source counts and eight authority hashes.
- Live final handshake: challenge 200, proof 200, redeem 200, token shape valid, replay 401, hostile-origin access 403.
- Authenticated Engineer status: 503 with the controlled missing-OpenAI-key readiness state, which is the expected fail-closed result for the current environment.
- Paid provider calls: zero. Git publication effects: zero.

All evidence here must be reproducible, non-secret, and tied to an exact commit or working-tree diff.

## Starting baseline

- HEAD: `14a49628fd8d773f9e73cb65ceb5c4a7aecb28e1`
- Engineer: 911 passed, 0 failed.
- Gateway: 502 passed, 0 failed.
- Web: 587 passed, 0 failed.
- Total: 2,000 passed, 0 failed.
- Typechecks: Engineer, Gateway, Web passed.
- Production dependency audit: no vulnerabilities.

This is a baseline, not final release evidence. Every affected suite and the mandatory end-to-end gates must be rerun after implementation.

## R15-01/R15-02 database and readiness pair

- Working tree based on HEAD: `14a49628fd8d773f9e73cb65ceb5c4a7aecb28e1`.
- Exact installed source remained at schema 18 and was opened read-only.
- Disposable image migrated to schema 39 through `EngineerLedger`.
- Preserved: 34 runs, 34 run budgets, 15 reviewer sessions, 23 findings, all source table counts, and hashes of eight authority tables.
- Post-upgrade: `quick_check=ok`; `foreign_key_check` returned zero rows.
- Focused tests: 49 unique passed, 0 failed.
- Engineer typecheck: passed.
- Gateway typecheck: passed.
- Configured Doctor with paid provider keys removed: `ok: true`.
- `git diff --check`: passed.
- Paid model calls: zero.
