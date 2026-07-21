# Release checklist

Status values: `TODO`, `PASS`, `BLOCK`.

| Gate | Status | Evidence |
| --- | --- | --- |
| Historical database-copy upgrade | PASS | Exact v18 copy reaches v39; counts, hashes, history, integrity and FKs verified |
| Clean database startup | PASS | Canonical chain and disposable ledger construction regressions pass |
| Doctor/gateway readiness agreement | PASS | Doctor now constructs the same Engineer ledger path on a disposable copy |
| Docker/image/dependency bundle | PASS | Baseline verification at starting HEAD |
| Browser handshake and replay/origin controls | PASS | Single-use HMAC handshake; replay 401; hostile origin 403; client/proof/backend regressions pass |
| Internal navigation retains tab-memory authentication | PASS | Shared module-memory credential, credential-change reconciliation, and authenticated multi-route HTTP proof; visual browser evidence separately blocked by tool policy |
| Provider failure diagnostics | PASS | Missing key, unreachable provider, and unsupported capability have distinct safe messages; no paid diagnostic call |
| Plan/freeze/execute/verify | PASS | Deterministic exact-base suites pass with keys removed; hardened pinned container smoke passes |
| Human decision and checkpoint | PASS | Deterministic gateway classification and signed verified-candidate promotion tests pass |
| Budget, top-up, cancellation, restart | PASS | 57-test budget/recovery/UI matrix plus gateway cancellation/restart coverage |
| Resolution Desk stale-base recovery | PASS | Sole correction entry point, source freeze, CAS, durable lineage, and replacement execution covered |
| Artifact and evidence integrity | PASS | Strict byte reads, symlink/path escape, tamper, audit export, DSSE/checkpoint coverage pass |
| Single-organization enforcement | PASS | Configured-org validation, owner fences, anti-oracle and cross-org negative matrix pass; pilot claim remains single-org |
| Publication failure/reconciliation/exactly-one PR | PASS | P8 joint/consolidation suites prove preflight, ambiguity, restart, distinct approver and one-PR properties |
| Production dependency audit | PASS | Final working tree: `bun audit --production` reports no vulnerabilities |
| Full tests and typechecks | PASS | 2,012 tests across 179 files; Engineer, Gateway, and Web typechecks pass |
| Production web build | PASS | Next.js 16 production build completes and enumerates all 49 routes |
| Changed-diff integrity | PASS | `git diff --check` passes and credential-pattern scan is clear |
| Browser walkthrough | BLOCK | In-app browser control refuses localhost under its URL-safety policy; no workaround used |
| Real provider run | BLOCK | Running gateway correctly reports missing OpenAI key; zero paid calls made |
| Credentialed GitHub ceremony | BLOCK | Distinct approver and GitHub credential were not supplied; no Git effect attempted |

Final verdict: **BLOCK** on the three external/manual gates above. All locally automatable gates are PASS.
