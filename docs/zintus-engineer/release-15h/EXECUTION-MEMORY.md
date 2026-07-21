# Zintus Engineer 15-hour pilot — execution memory

Updated: 2026-07-20

## Authority and goal

- Worktree: `/Users/yashwanthsurabhi/Projects/zintus-wt-web`
- Branch: `codex/engineer-actual-localhost`
- Starting HEAD: `14a49628fd8d773f9e73cb65ceb5c4a7aecb28e1`
- Goal: deliver a production pilot for one configured organization with isolated local execution, hard budgets, durable evidence, secure approval, deterministic correction recovery, and fail-closed optional GitHub publication.
- Commit/push authority: not granted.

## Scope corrections

1. Local engineering readiness and GitHub publication readiness are separate. Missing GitHub credentials must not block plan, execute, verify, or review.
2. Browser gates require recorded visible-state, navigation, and console evidence; HTTP health alone is insufficient.
3. Once stabilization begins, only release-blocking fixes and their tests may change production code.
4. Historical fixtures follow the exact installed schema. Previously applied migration SQL remains immutable.
5. Organization identity is configured server-side. Client-supplied arbitrary organizations are rejected.
6. Publication ceremony is exercised early with a fake provider, then repeated with configured GitHub credentials before a GO verdict.

## Completed before this goal continuation

- Starting worktree confirmed clean and 117 commits ahead of its configured remote branch.
- Full baseline previously recorded: Engineer 911, Gateway 502, Web 587 tests; 2,000 total, zero failures.
- Engineer, Gateway, and Web typechecks previously passed.
- Production dependency audit previously reported zero vulnerabilities.
- Docker daemon and the pinned Bun image were verified.
- Exact offline dependency bundle was built for the starting HEAD.
- Real Engineer database was inspected read-only; schema version 18 and integrity check were healthy.

## Completed in task pair R15-01/R15-02

- Frozen the exact installed v18 review-classification schema as a reusable sanitized SQL fixture.
- Added a narrowly gated, durably recorded compatibility bridge for the installed empty-batch v18 variant.
- Preserved the checked-in migration-18 and migration-25 SQL constants; no applied migration bytes were rewritten.
- Made the classification validator accept only the two known artifact-FK variants and reject any other FK set.
- Found and fixed a second P0: migration 25 silently deleted 34 historical `run_budgets` rows because positional `SELECT *` met a legacy ALTER-appended column order and Bun continued after the middle statement failed.
- Migration 25 now executes its immutable intended rebuild using explicit named columns and individually checked statements.
- Every numbered migration now fails and rolls back if it removes a pre-existing table or changes a pre-existing table's row count.
- Doctor now serializes a consistent read-only database image, constructs `EngineerLedger` on a disposable file, migrates it, checks integrity/FKs/schema, verifies every source table count, and hashes eight durable authority tables.
- The real configured Doctor now reports READY at copied schema 39 while the installed source remains schema 18.

## Completed in task pair R15-03/R15-04

- Wired the browser to the gateway's single-use, origin-bound loopback handshake; no gateway token is copied, persisted, or embedded in the client bundle.
- Added a same-origin Next proof broker that reads only an owner-controlled `0600` live-process session file and returns only a challenge-bound HMAC proof.
- Concurrent shell and Engineer dashboard connection attempts share one handshake, preventing duplicate challenge/redeem storms.
- Explicit operator-token entry remains an advanced fallback for token-protected gateways and remains memory-only.
- AppShell polling is recursive and bounded: authentication failures stop polling; local-handshake failures back off and stop after five attempts until focus or credential change.
- The Engineer dashboard reloads immediately after the shared in-memory credential changes, so internal navigation uses the same tab-memory session.
- Live verification proved challenge `200`, redeem `200`, authenticated status `200`, replay `401`, and hostile-origin reuse `403`.
- Automated visual browsing is blocked by the browser tool's localhost URL-safety policy; this is recorded as an evidence limitation, not replaced with an unsafe workaround.

## Completed in task pair R15-05/R15-06

- Readiness now distinguishes missing OpenAI credentials, rejected credentials, provider/connectivity failure, and genuine Responses/strict-output capability failure using safe controlled messages.
- Incomplete repository, exact-base, pinned-image, or offline-dependency configuration is `FAILED`, never mislabeled `DISABLED`; public health therefore cannot claim a configured-but-broken Engineer is healthy.
- The gateway readiness guard returns the safe actionable failure to the Engineer UI instead of replacing it with a generic preflight message.
- Deterministic plan, freeze, exact-base execution, independent verification, scoped review classification, and signed checkpoint suites passed with paid provider keys removed.
- The real pinned `oven/bun@sha256:e105...e5c4` image ran successfully with no network, read-only root, all capabilities dropped, `no-new-privileges`, PID/memory/CPU limits, and reported Bun `1.3.14`.

## Completed in task pair R15-07/R15-08

- Durable hard-budget, top-up, pause/resume, settled/reserved/ambiguous accounting, cancellation, no-progress containment, and paid-call crash recovery suites passed with provider keys removed.
- Resolution Desk is the only live correction entry point; stale/failed sources are frozen, replacement lineage and correction budgets are durable, and retired direct/legacy mutation paths remain unavailable.
- Artifact confinement/tamper checks, evidence/attestation integrity, configured organization isolation, anti-oracle behavior, distinct approver enforcement, publication preflight, ambiguity reconciliation, and exactly-one-PR restart properties passed.

## Current task pair

- R15-09: complete. The final Engineer, Gateway, and Web sweep passed 2,012 tests across 179 files with zero failures; all three package typechecks and the production dependency audit passed.
- R15-10: complete for every locally automatable gate. Production build, configured Doctor, live loopback handshake, exact-base/pinned-container readiness, diff integrity, and changed-diff secret scanning passed.
- The production build found and drove one final integration repair: Next.js 16 rejects arbitrary exports from route modules. The proof broker is now a reusable server module and the route exports only `POST`.

## Active blocker

Release remains blocked on external/manual evidence: the in-app browser tool's localhost URL-safety policy prevents the required visible walkthrough; the running gateway has no OpenAI API key; and no distinct approver plus credentialed GitHub publication ceremony was provided. These constraints were not bypassed and no paid call or Git effect was attempted.

## Remaining ordered work

- Manually complete the visible browser walkthrough on the running local UI.
- Configure a valid OpenAI key and execute one controlled paid end-to-end run within the approved cap.
- Configure a distinct approver and GitHub credentials, then perform the real publication ceremony and verify exactly one draft PR.

## Commands and results

- `git status --short --branch`: clean at start.
- `git rev-parse HEAD`: `14a49628fd8d773f9e73cb65ceb5c4a7aecb28e1`.
- Source/history inspection confirmed the readiness disagreement described above.
- Focused database/Doctor regression set: 49 unique tests passed, 0 failed.
- `bun run --filter @zintus/engineer typecheck`: passed.
- `bun run --filter @zintus/gateway typecheck`: passed.
- `git diff --check`: passed.
- Loopback/backend/handler/web handshake regression set: 172 tests passed, 0 failed.
- Handshake/provider-focused Engineer regression set: 83 tests passed, 0 failed.
- Web and Gateway typechecks after handshake/provider changes: passed.
- Live security flow: challenge 200; redeem 200; token structurally valid; status 200; replay 401; hostile origin 403.
- Live readiness now distinguishes a missing OpenAI API key from an unsupported model without making a paid call.
- Deterministic plan/execution/verification/checkpoint gate: 200 tests passed, 0 failed, with paid keys removed.
- Budget/recovery/live-UI gate: 57 tests passed, 0 failed, with paid keys removed.
- Resolution/artifact/organization/publication joint gate: 605 tests passed across 47 files, 0 failed, with paid keys removed.
- Final exact-working-tree sweep: 2,012 tests passed across 179 files, 0 failed, with paid keys removed.
- Final Engineer, Gateway, and Web typechecks: passed.
- Next.js 16 production build: passed; 49 application routes generated, including Engineer, Resolution, Operations, Publication, and the loopback proof route.
- Production dependency audit: no vulnerabilities found.
- Final `git diff --check`: passed; changed-diff credential scan: clear.
- Real hardened pinned-container smoke: Bun `1.3.14`, exit 0.
- Configured `env -u OPENAI_API_KEY -u TAVILY_API_KEY bun run doctor:engineer`: `ok: true`.
- Real-copy evidence: v18 -> v39; 34 runs, 34 budgets, 15 reviewer sessions, and 23 findings preserved; `quick_check=ok`; zero FK violations; eight authority-table hashes preserved.
- Paid provider calls: zero.

## Files changed in this continuation

- Documentation/evidence and reusable historical fixture under `docs/zintus-engineer/release-15h/`.
- `packages/engineer/src/database-migrations.ts`
- `packages/engineer/src/deployed-v18-compatibility.test.ts`
- `packages/engineer/src/run-budget-migration-compatibility.test.ts`
- `packages/engineer/src/review-classification-immutability.test.ts`
- `scripts/engineer-doctor.ts`
- `scripts/engineer-doctor.test.ts`
- `apps/gateway/src/engineer-preflight.ts`
- `apps/gateway/src/engineer.test.ts`
- `apps/gateway/src/handler.ts`
- `apps/gateway/src/handler.test.ts`
- `apps/web/app/api/local-gateway/handshake-proof/route.ts`
- `apps/web/app/api/local-gateway/handshake-proof/route.test.ts`
- `apps/web/app/api/local-gateway/handshake-proof/broker.ts`
- `apps/web/lib/gateway.ts`
- `apps/web/lib/gateway.test.ts`
- Engineer shell/banner/sidebar/page connection-state components and their static regression coverage.

## Known limitations

- The allowed release claim is single-organization production pilot only.
- Full multitenancy, organization RBAC, SSO/SAML, cloud sandboxing, and public multi-customer GA are out of scope.
- Tavily-backed research is optional and unavailable without its credential.

## Next exact action

Add a valid OpenAI key through the supported local configuration, refresh `http://localhost:3000/engineer`, and perform the recorded manual browser run. Do not authorize publication until a distinct approver and GitHub credential are configured.

## Release verdict

BLOCK — all locally automatable release gates pass, but the mandatory manual browser, real provider, distinct-approver, and credentialed GitHub publication evidence is not available.
