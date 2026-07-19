# Zintus Engineer Required Lane implementation log

This file is the durable handoff record for the three-day Required Lane MVP.
It records verified work and architecture decisions; it is not evidence that an
unfinished pair has passed.

## Source of truth

- Worktree: `/Users/yashwanthsurabhi/Projects/zintus-wt-web`
- Branch: `codex/engineer-actual-localhost`
- Starting condition: 60 commits ahead of the remote branch with a protected,
  pre-existing dirty Engineer worktree.
- Commit/push policy: no commit or push without explicit user permission.
- Paid-call policy: automated implementation verification runs with provider
  keys removed.

## Gate 0 — complete

- `git diff --check`: passed.
- `@zintus/engineer` typecheck: passed.
- Engineer package: 233 tests passed.
- Gateway Engineer group: 109 tests passed.
- Web Engineer group: 36 tests passed.
- Aggregate: 378 tests, 2,742 assertions, zero failures.
- Paid model calls: zero.

## Architecture decisions

1. The existing `TaskManifest` remains unchanged because it is strict and
   canonically hash-bound.
2. Required Lane authority is a separate versioned contract envelope bound to
   the frozen `manifestHash`.
3. Legacy runs are never backfilled with a Required Lane contract.
4. Raw Reviewer output is retained; deterministic code will calculate its
   effective blocking or advisory disposition.
5. Verification and human approval attestations remain separate.
6. Optional hardening runs are children of an immutable verified checkpoint;
   their failure cannot mutate the parent baseline.

## Pair 1 — complete

- Required Lane contract module and contract tests: implemented locally.
- Transactional schema v14 to v15 contract migration plus ordered v16
  `contract_hash NOT NULL` rebuild: implemented locally. The v16 step preserves
  valid draft-v15 history instead of silently redefining or deleting it.
- Contract persistence during manifest freeze: implemented locally in the same
  manifest/event/audit transaction.
- Budget tightening is inside that same transaction; injected failures both
  before and after the budget update prove complete rollback.
- Plan-proposal and context-snapshot writes now recheck run state/version under
  their write transaction. Freeze rechecks the authoritative durable proposal
  hash and its context binding after acquiring its transaction.
- Required test commands must pass the exact trusted-executor grammar, occur in
  the allowlist, and not occur in the prohibited list.
- Migration ancestry, final schema shape, relational/JSON binding, valid legacy
  manifest reads/exports, and absence of fake legacy contracts are covered.
- First Luna pass: functional pass with one missing post-budget rollback test;
  that test is now added and green.
- First Sol closure pass: failed with proposal TOCTOU, command-policy,
  nullability, migration-ancestry, and legacy-runtime findings. Repairs are
  implemented; the pair remains open until Sol and Luna re-review the updated
  code.
- Latest focused Pair 1 verification: 43 tests passed, 169 assertions, zero
  failures; package typecheck and diff validation passed.
- Latest full boundary verification: Engineer 252 tests / 1,467 assertions and
  gateway plus Engineer UI 76 tests / 294 assertions, all green. Paid provider
  keys were removed.
- A disposable backup of the real local v15 Engineer database migrated through
  v16 successfully, retained its complete migration history, and reported the
  final `contract_hash` column as primary-key plus `NOT NULL`. The original
  database was not mutated.
- Sol closure audit round 3 and Luna closure verification round 2: pending.

### Pair 1 closure hardening

- Sol round 3 found a pre-lock v15 shape assertion race, acceptance of a
  partial counterfeit unique index, and an unbound trusted-command policy
  version. All three are repaired.
- The migration asserts v15 shape only after `BEGIN IMMEDIATE` and the
  under-lock version reread; final uniqueness requires the table-declared,
  non-partial unique constraint with exact columns.
- The Required Lane contract now hash-binds the literal trusted command-policy
  version, and Supervisor supplies that value as independent authority.
- A real two-process startup test initially exposed `SQLITE_BUSY` while two
  processes changed WAL journal mode. Startup now uses a BUSY-only, bounded WAL
  retry. The concurrent migration test subsequently passed 20 consecutive
  repetitions.
- A populated valid v15 contract is migrated to v16 with exact JSON and
  relational identity preserved, then reopened through Ledger read/export.
  Null contract hashes and broken v16 ancestry fail closed; a partial
  counterfeit uniqueness index is rejected.
- Latest full Engineer and gateway/UI boundary runs are green with no paid
  provider keys. Sol round 4 and Luna round 3 are pending before closure.

### Pair 1 legacy-envelope correction

- Sol round 4 found that adding `commandPolicyVersion` to contract schema v1
  would invalidate genuine draft-v15 contract JSON and hashes. Luna had passed
  the synthetic current-schema fixture, so the stricter Sol finding remained
  authoritative and the pair stayed open.
- Required Lane now has an immutable legacy v1 envelope and a new v2 envelope.
  Only v2 is emitted for new freezes and it binds the trusted command-policy
  version; v1 remains read-only and cannot authorize a new freeze.
- Ordered migration v17 changes only the relational schema-version check to
  permit v1 and v2 rows. It copies old contract bytes and hashes unchanged.
- The v15 compatibility fixture now contains literal historical v1 JSON and a
  precomputed canonical hash with no command-policy field. Reopen/read/export
  verifies exact preservation after v15 -> v16 -> v17.
- All legacy column existence checks and `ALTER TABLE` repairs now run after a
  `BEGIN IMMEDIATE` lock and re-read. A separate two-process test starts from a
  real v14-shaped database missing `engineer_runs.last_error`; both processes
  converge without duplicate-column failure.
- Both migration concurrency tests passed 20 consecutive repetitions. A
  disposable copy of the real local database migrated through v17 with the
  final `CHECK(schema_version IN (1, 2))` and intact history.
- Latest gates: Engineer 258 tests / 1,502 assertions; gateway and Engineer UI
  76 tests / 294 assertions; typecheck and diff check passed; zero paid calls.
- Sol closure round 5: PASS with no remaining correctness, security,
  durability, migration, or compatibility blocker.
- Luna closure round 4: PASS after directly probing the literal 1,347-byte
  legacy contract, its exact historical hash, v1 read-only behavior, v17
  preservation, and both multi-process startup paths.
- Pair 1 closed on 2026-07-17. No commit or push was performed.

## Pair 2 — in progress

- Objective: preserve raw Reviewer sessions/findings unchanged while a
  deterministic, versioned gateway classifier derives effective blocking or
  advisory disposition from the Required Lane contract and trusted evidence.
- Sol architecture design and Luna adversarial test design: requested before
  implementation begins.

### Pair 2A deterministic classification and immutable persistence

- Added a versioned, canonical, hash-bound classification kernel. Reviewer
  prose, severity, and decision never create blocking authority.
- Blocking is limited to referenced, digest-valid deterministic evidence for a
  failed frozen required test, an exact HIGH/CRITICAL deterministic security
  finding, or a failed final scope attestation.
- Unproven MUST/security claims, out-of-scope repair requests, model REJECT or
  human requests, unverified isolation, and provenance conflicts are routed to
  `HUMAN_REVIEW_REQUIRED`; human ambiguity takes precedence over auto-repair.
- Exact provider function-call argument bytes are represented by a distinct
  immutable artifact reference. Their digest is never conflated with the
  normalized Reviewer output/session/finding hashes.
- Classifier input hash-binds the complete sorted trusted-evidence identity
  set, including declared and recomputed payload hashes. Invalid digests and
  duplicate evidence identities fail to a provenance human gate.
- Normalized finding rows are derived and checked one-to-one against provider
  findings using the existing namespaced record-ID and fingerprint rules.
- Schema v18 adds immutable batch and per-finding classification tables. A
  deferred child-first foreign key plus a completeness trigger seals exactly
  one classification per normalized finding; post-seal inserts and all
  updates/deletes are rejected.
- Ledger persistence accepts the exact parsed `ReviewerInput`, rechecks its
  hash and all run/session/attempt/manifest/diff/evidence/policy bindings, and
  recomputes classification from its trusted evidence.
- Contract, artifact row, artifact bytes, and classifier output are re-read and
  verified inside one immediate write transaction. The raw artifact must be a
  trusted system capture produced for the exact Reviewer session.
- Exact retry is a no-op. Changed replay, fabricated batch, missing mapping,
  partial legacy session, wrong contract/input/producer, nonexistent artifact,
  byte tampering, and transaction failure all fail closed without partial rows.
- This is a dark Pair 2A API only. Verification-manager behavior and
  publication authority are deliberately not wired until Pair 2B.
- No-key full Engineer gate: 278 tests, 1,564 assertions, zero failures.
- Focused classification/schema/ledger gates, package typecheck, and
  `git diff --check`: passed. Paid model calls: zero.
- Sol/Luna closure re-review of Pair 2A: pending.

### Pair 2A Luna NO-GO repair round 2

- Luna returned NO-GO after finding that the first persistence boundary proved
  only a raw artifact hash, not that its provider argument bytes produced the
  normalized Reviewer session. Pair 2A was reopened rather than waived.
- Persistence now parses the exact raw provider JSON, applies the existing
  deterministic `bindReviewerEvidence` transform, regenerates normalized
  finding records with `reviewerFindingRecords`, and requires byte-for-byte
  canonical equality with the supplied session and finding rows.
- Exact canonical `ReviewerInput` and normalized Reviewer output JSON are now
  immutable v18 columns, not unrecoverable hashes. Rehydration parses and
  hashes both, rebinds raw to normalized output, checks session scalars and
  every classification child row, and re-verifies raw artifact bytes.
- Every Reviewer evidence reference is resolved again from durable authority
  under the immediate write transaction. Artifact evidence requires exact
  trusted type/producer/run/hash/time/owner-controlled bytes and JSON payload.
  Independent verification is reconstructed from the latest verification
  pass, command, stdout/stderr artifacts, audit metadata, executor, and exact
  result commit. Unknown, forged, and stale evidence fails closed.
- Reviewer attempt and verification pass remain independent counters; a test
  proves Reviewer attempt 2 accepts current verification pass 1, while an
  earlier pass is rejected after pass 2 exists.
- The same immediate transaction rechecks durable `REVIEWING` state, current
  manifest hash/JSON, v2 Required Lane contract, ReviewerInput, raw artifact,
  evidence, classification semantics, and exact replay identity.
- v18 validation now checks exact run-index columns/origin/partial flags,
  table-declared non-partial uniqueness, child PK/FKs/check/deferral, and exact
  normalized trigger SQL. Counterfeit index and unreachable-abort trigger
  fixtures fail closed.
- Added adversarial coverage for unrelated valid raw JSON, normalized
  omission/extra, forged and stale security reports, current-state loss,
  independent-ledger exact replay, post-write raw/normalized tampering, missing
  artifacts, wrong producer/input, and relational sealing.
- Round-2 full no-key gate: 286 tests, 1,588 assertions, zero failures;
  package typecheck and `git diff --check` passed; zero paid calls.
- Independent Sol/Luna closure re-review: pending.

### Pair 2A Luna NO-GO repair round 3

- Luna returned NO-GO on durable-evidence exhaustiveness. The prior resolver
  proved artifact bytes and shallow bindings but did not deterministically
  regenerate all typed evidence from current authority.
- Coverage matrices are now parsed with `VerificationCoverageMatrixSchema` and
  must equal `buildVerificationCoverageMatrix` for the exact current frozen
  manifest. A different internally valid matrix for that same manifest is
  rejected, as is a valid matrix from an earlier manifest.
- Adversarial reports are parsed with `AdversarialCoverageReportSchema`. Their
  `advisoryHash` must resolve to exactly one durable, byte-valid
  `TEST_ADVISORY`, and the report must equal
  `buildAdversarialCoverageReport(currentManifest, advisory)` exactly.
- Test-integrity comparisons are parsed, restricted to the supported stages,
  de-duplicated by stage, and bound to the latest durable baseline for the
  current manifest and base commit. This permits legitimate baseline
  recreation after sandbox reprovisioning while rejecting a comparison that
  references an older baseline. Exactly one current `PRE_REVIEW` comparison
  is mandatory; stale-manifest baselines and old-stage-only evidence fail
  closed.
- Independent verification now requires the exact persisted completion time
  and full command/evidence envelope while keeping Reviewer attempt and
  verification pass as independent counters. Security and final-scope reports
  retain exact current policy/run/diff/manifest/result bindings. Unknown event
  types fail closed.
- The ledger suite now covers valid, byte-forged, stale, and unseen evidence
  for every accepted evidence type, plus current-manifest semantic forgeries,
  stale baseline references, valid recreated baselines, and duplicate
  integrity stages.
- Round-3 focused ledger gate: 19 tests / 88 assertions. Full no-key Engineer
  gate: 290 tests / 1,627 assertions. Package typecheck and `git diff --check`
  passed; paid model calls: zero. Final Sol/Luna closure re-review: pending.

### Pair 2A Luna NO-GO repair round 4

- Luna returned NO-GO on evidence provenance depth and historical
  rehydration. Pair 2A was reopened without wiring Pair 2B.
- A `TEST_ADVISORY` now has authority only when it is an untrusted SYSTEM
  artifact produced by the exact SUCCEEDED TESTER agent whose durable output
  points back to that artifact. Exactly one canonical advisory-hash match is
  required; duplicate whitespace encodings and incorrectly trusted advisories
  fail closed.
- Test-integrity comparisons now have an append-only Supervisor attestation
  event. Reviewer evidence must reference the latest attested comparison for
  its stage and the latest baseline as of review time. A later failed
  `PRE_REVIEW` comparison cannot be hidden behind an older pass, while sandbox
  reprovisioning and historical reads remain restart-safe.
- Independent verification now rehydrates complete stdout/stderr artifact
  records and verifies run, type, executor producer, trusted status, regular
  file identity, exact size, and exact byte hash. Test and command types and
  start/completion timestamps must also agree. File tampering fails closed.
- The deterministic diff security scanner is now one exported pure rule
  source used by both execution and ledger replay. Report semantics are
  regenerated from the exact reviewed diff, and every reported finding must
  equal its durable `security_findings` row. Current-ID semantic fabrication
  is rejected.
- Final scope evidence is built by one exported pure policy function from the
  frozen manifest, exact diff, result commit, and as-of credentialed Git
  operation count. Ledger replay requires exact canonical equality.
- Every latest/current lookup is evaluated as of immutable ReviewerInput time:
  verification passes, baselines, integrity attestations, TEST_ADVISORY agent
  outputs, security rows, and Git operations. Future durable activity cannot
  make a historical classification unreadable.
- Round-4 focused provenance gate: 20 tests / 113 assertions. Full no-key
  Engineer gate: 291 tests / 1,652 assertions. Package typecheck and
  `git diff --check` passed; paid model calls: zero. Final independent
  Sol/Luna closure re-review: pending.

### Pair 2A Luna NO-GO repair round 5

- All Reviewer evidence time decisions now compare real instants, never ISO
  strings: JavaScript uses finite epoch milliseconds and SQLite filters/orders
  with `julianday(...)` plus deterministic rowid tie-breaking.
- The conversion covers verification passes, Tester agent/advisory outputs,
  baselines, integrity artifacts/events, security rows, and Git operations.
  Invalid/non-finite candidate times fail closed.
- Integrity source-event multiplicity is evaluated as of immutable review
  time. A later duplicate audit cannot invalidate history; two authoritative
  audits at or before review are rejected.
- Offset-crossing regressions prove chronologically future values that sort
  lexically earlier are excluded, while chronologically earlier offset values
  that sort lexically later are accepted. Artifact timestamp identity remains
  string-exact; only temporal ordering is instant-based.
- Round-5 focused Pair 2A gate: 20 tests / 123 assertions; package typecheck
  and `git diff --check` passed; provider calls: zero. Full no-key gate remains
  the already passing primary 291-test gate pending Luna re-audit.

### Pair 2A Sol/Luna blocker repair round 6

- Required-test readiness is now a deterministic gateway input. The persisted
  classification batch hash-binds one sorted `requiredTestGates` entry for
  every frozen required test; missing evidence produces `REPAIR_REQUIRED`,
  while durable failed, timed-out, or blocked execution produces `BLOCKED`.
  A model `APPROVE` with zero findings reaches `READY` only when every gate is
  durably `PASSED`.
- The ledger reconstructs the exact latest verification independently for
  each required test as of immutable ReviewerInput time. Authority requires a
  unique `VERIFICATION_EXECUTED` audit binding for the frozen test ID, exact
  manifest command and type, complete command/artifact validation, and exact
  Reviewer evidence identity. Missing, unexpected, duplicate, stale, forged,
  or byte-tampered evidence fails closed and cannot become ready.
- Exact immutable classification replay is exhaustively rehydrated and
  validated before any live `REVIEWING` or current-manifest requirement. An
  exact retry therefore remains idempotent after the run advances, while a
  changed retry still conflicts.
- All Pair 2A hash-bound collection ordering uses an explicit JavaScript
  code-unit comparator. Locale-dependent ordering was removed from classifier,
  persistence, raw-output rebinding, and child rehydration; mixed case,
  punctuation, BMP Unicode, and astral Unicode are covered.
- Round-6 focused gate: 32 tests / 157 assertions. Full no-key Engineer gate:
  293 tests / 1,670 assertions. Workspace typecheck and `git diff --check`
  passed; paid provider calls: zero.

### Pair 2A Terra chronology repair round 7

- Required-test reconstruction and independent-verification rehydration now
  treat `VERIFICATION_EXECUTED` audit authority strictly as of immutable
  ReviewerInput time. Both paths require a finite audit timestamp and apply
  `julianday(a.created_at) <= julianday(reviewCreatedAt)`.
- A valid future matching audit is ignored, so historical
  `getReviewClassification` and exact replay remain stable after the run
  advances. Multiple matching audit bindings at or before review fail closed;
  candidate reconstruction evaluates the complete as-of result rather than
  allowing a query limit to hide duplicate authority.
- The regression persists a valid classification, appends a future duplicate,
  confirms rehydration and exact replay are unchanged, then appends an as-of
  duplicate and confirms both paths reject it.
- Round-7 focused gate: 33 tests / 162 assertions. Full no-key Engineer gate:
  294 tests / 1,675 assertions. Workspace typecheck and `git diff --check`
  passed; paid provider calls: zero.

### Pair 2A Sol/Terra public-boundary repair round 8

- The public Supervisor now permits a post-state classified-session call only
  when exhaustive ledger rehydration proves that immutable classification
  already exists. Fresh inserts still require `REVIEWING` under the ledger's
  immediate transaction, and both new writes and replays retain isolated SOL
  and record-integrity checks. Public regressions cover exact replay after
  advancement, changed replay rejection, and non-`REVIEWING` new-write denial.
- Caller-reported `provenanceConflict` is now part of hash-bound batch content
  and must equal the authority flag for initial write and every replay. Both
  true-to-false and false-to-true substitutions conflict even when another
  gate leaves the visible result unchanged.
- Verification coverage, security, adversarial coverage, and final-scope
  evidence now resolve to the unique latest relevant SYSTEM artifact as of
  immutable ReviewerInput time. Selection binds exact run, type, producer,
  manifest/diff/policy/result semantics; tied latest authoritative instants
  fail closed, older attempts cannot displace the latest, and future artifacts
  are excluded before trust/file/byte/JSON inspection.
- A four-domain regression proves future corrupt duplicates cannot rewrite
  historical rehydration or exact replay, while canonical as-of duplicates
  invalidate both paths.
- Round-8 focused gate: 36 tests / 189 assertions. Full no-key Engineer gate:
  297 tests / 1,702 assertions. Workspace typecheck and `git diff --check`
  passed; paid provider calls: zero.

### Pair 2A Terra domain-identity repair round 9

- Every relevant as-of deterministic domain artifact now receives a canonical
  semantic identity derived from its parsed payload under the already-bound
  run, artifact type, and producer domain. Distinct artifact IDs with the same
  canonical identity fail closed regardless of timestamp ordering or raw JSON
  whitespace.
- Latest-as-of selection remains available for genuinely different older
  semantic attempts. Future candidates are still discarded before byte
  inspection, equal latest instants still fail, and the supplied evidence must
  remain the unique latest candidate.
- A table-driven four-domain regression persists a valid classification, adds
  a whitespace-different duplicate with an earlier timestamp and later rowid,
  then proves both historical rehydration and exact replay reject the duplicate.
- Round-9 focused gate: 37 tests / 201 assertions. Full no-key Engineer gate:
  298 tests / 1,714 assertions. Workspace typecheck and `git diff --check`
  passed; paid provider calls: zero.

### Pair 2A final closure

- Luna final defensive audit: PASS. Focused no-key gate 84/84; full no-key
  Engineer gate 298/298; package typecheck and diff hygiene passed.
- Sol final architecture audit: PASS after independently rerunning 76 focused
  tests. Every Pair 2A NO-GO is closed: model-independent required-test
  authority, exhaustive post-state replay through Supervisor, hash-bound
  provenance conflict, locale-independent ordering, immutable as-of history,
  and unique canonical authority for all deterministic evidence domains.
- Pair 2A remains dark by design. Production workflow and publication still
  use the legacy Reviewer path; Pair 2B is the only authorized place to switch
  authority to the persisted and rehydrated classification.
- Pair 2B release constraints are frozen: persist before transition; branch
  only on rehydrated `ReviewClassificationBatch`; advisories never spend repair
  budget; every transition, approval, evidence bundle, and publication attempt
  binds the exact Reviewer session and classification hash; legacy or missing
  classifications cannot authorize new publication.

### Pair 2B deterministic authority integration

- Phase 3 now persists the exact provider argument bytes separately from the
  normalized Reviewer opinion, computes the deterministic Required Lane
  classification, atomically records it, rehydrates it, and branches only on
  the rehydrated classification hash/result. Raw `REQUEST_CHANGES` output can
  no longer spend repair budget or regain authority through restart recovery.
- Required-test evidence gaps route to deterministic verification recovery;
  human/provenance ambiguity routes to a human; only exact persisted BLOCKING
  mappings can enter the classified repair lane. Every classified repair-chain
  transition carries the Reviewer session and classification hash.
- REVIEWING restart recovery is classification-first: a persisted batch is
  exhaustively rehydrated, its claims and v2 evidence bundle are replayed
  idempotently, and its mapped state is applied without another Reviewer,
  advisor, or retry purchase. Legacy raw-output recovery and later-artifact
  finding unions were removed.
- Classified evidence bundles have deterministic identities, classification
  timestamps, code-unit-sorted trusted artifacts frozen as of classification,
  and exact replay conflict checks. Publication resolves exactly one v2 bundle
  for the Reviewer session/classification pair and verifies its content hash;
  stale, duplicate, or mismatched bundles fail closed.
- Ordered schema migration v19 adds nullable direct Reviewer session,
  classification hash, and ready-result columns for legacy-compatible approval
  storage. Every new approval requires all three, rehydration returns them,
  changed idempotent replay conflicts, approval validation rechecks them, and
  the signed Supervisor PR command carries the classification hash/result.
- Pair-2B focused gate: 82 tests / 501 assertions. Full no-key Engineer source
  gate: 299 tests / 1,707 assertions. Workspace typecheck and `git diff --check`
  passed; paid provider calls: zero. A repository-root unscoped `bun test`
  remains unsuitable because it includes compiled `dist` duplicates, live
  provider modules, and the intentionally vulnerable demo fixture; the scoped
  source gate is authoritative for Engineer.

### Pair 2B Luna repair round 2

- Live execution and classification-first restart now share one
  `applyClassifiedOutcome` policy for READY, READY_WITH_ADVISORIES,
  HUMAN_REVIEW_REQUIRED, REPAIR_REQUIRED, and BLOCKED. BLOCKED can use only
  exact persisted BLOCKING mappings; Reviewer-fix retry replay is
  classification-bound and idempotent, and its trusted repair context has a
  deterministic identity before conditional state advancement.
- REVIEWING, REVIEW_CHANGES_REQUESTED, REVIEW_FIX_PREPARING, and classified
  REVIEW_REPAIR_STARTED recovery no longer fall into generic verification.
  State advancement is conditional, preventing same-state transitions and
  duplicate retry rows across process restarts.
- V2 bundle artifact membership no longer depends on timestamps or all trusted
  run artifacts. It is the immutable reference graph from ReviewerInput trusted
  evidence, nested executor stdout/stderr references, and the classification's
  exact raw-output artifact. Every selected artifact is re-read and byte-hash
  verified, de-duplicated, and code-unit ordered.
- A crash injected immediately after classified-session persistence recovers
  the READY result from durable authority with zero additional model calls and
  the same bundle/outcome. The same regression proves unrelated trusted
  artifacts with backdated, equal, and future timestamps cannot enter the
  classified bundle.
- Legacy raw Reviewer persistence/recovery methods were removed from the
  production Supervisor surface. The remaining ledger-only compatibility
  helpers are explicitly named `Legacy...ForTest`, and a runtime surface test
  prevents accidental re-export.
- Publication operation identities now include the exact classification hash.
  Before a durable branch, push, or PR operation can be reconciled or reused,
  its operation type, base commit, result commit, approval, and classified
  evidence bundle must all match the current authority. A changed
  classification on the same commit fails closed with zero Git-provider calls.
- Full no-key Engineer source gate: 301 tests / 1,720 assertions across 36
  files. Workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Pair 2B Luna repair round 3

- Builder repair dispatch now has a typed durable fence through the exact
  `AgentExecutionRecord`. Its input hash binds the frozen manifest, repair
  context, completion reason, and sorted Reviewer-session/classification
  authority. Boot recovery reconstructs that exact hash instead of treating an
  unrelated historical Builder execution as current authority.
- Only an absent matching dispatch may start Builder. A matching RUNNING,
  FAILED, or PAUSED execution is finalized and moved to
  `MODEL_PROVIDER_RETRY_PENDING` without transport. A matching SUCCEEDED
  execution must have its exact `BUILDER_REPAIR_RESULT`; recovery validates the
  bytes and run/manifest binding, reruns deterministic POST_REPAIR integrity,
  and advances to FAST_CHECKS without another model call.
- Crash regressions cover a recorded dispatch before provider response,
  provider success before continuation/result persistence, a durable result
  before state transition, and a repeated second restart. They assert exact
  Builder agent, model-call, and repair-retry counts with zero redispatch.
- Classification recovery has one bounded outcome matrix for READY,
  READY_WITH_ADVISORIES, HUMAN_REVIEW_REQUIRED, REPAIR_REQUIRED, and BLOCKED
  with repair denied or allowed. This exercises the shared deterministic
  outcome policy used by live execution and durable rehydration.
- Every publication resume now rehydrates current publication evidence and
  compares the complete non-null approval tuple: manifest, diff, evidence
  bundle, Reviewer session, classification hash, and classification result.
  A table of legacy-null, malformed, and stale bindings proves rejection before
  the first read-only or credentialed Git-provider call.
- Final no-key Engineer source gate: 304 tests / 1,779 assertions across 36
  files. Workspace typecheck and `git diff --check` passed; paid provider
  calls: zero.

### Pair 2B Sol repair round 4

- Ordered schema migration v20 adds `builder_dispatch_claims`, keyed by the
  exact `(run_id, input_hash)` repair authority and bound to one unique Builder
  agent, its central Terra tier, claim time, and optional paired worker-owner /
  positive fencing-token identity. Insert validation and immutable update/delete
  triggers are checked by exact schema and trigger-body validation.
- `claimBuilderDispatch` uses a SQLite immediate write transaction to either
  insert the fresh RUNNING Builder agent and exclusive claim together or return
  the exact durable winner. The loser cannot create an agent, routing decision,
  budget reservation, model call, or provider request. Legacy duplicate input
  hashes remain readable and migration creates no synthetic claims.
- Agent execution replay now verifies immutable run, role, model tier, input
  hash, and start identity. RUNNING/SUCCEEDED/FAILED/PAUSED shapes and legal
  terminal evolution are enforced; stale workers cannot regress or replace a
  SUCCEEDED result/output identity.
- Two independent verification managers are synchronized at the pre-claim
  boundary. The regression proves exactly one claim, Builder agent, routing
  row, paid model call, reservation/cost chain, and repair retry, while the
  loser deterministically rehydrates the winner and performs zero spend.
- Lease-enabled recovery rechecks fencing authority after the atomic claim and
  before routing. A stale-winner/new-lease interleaving proves the old worker's
  claim remains auditable while it creates zero routing, reservation, model,
  or provider activity.
- Final no-key Engineer source gate: 309 tests / 1,813 assertions across 36
  files. Workspace typecheck and `git diff --check` passed; paid provider
  calls: zero.

### Pair 2B Luna repair round 5

- Builder paid-boundary authority is now reusable and fail-closed. The same
  `assertAuthority` callback is checked immediately before provider token
  counting, inside every model-call reservation, and immediately before every
  provider request or retry. Both initial execution and verification repair
  Builders wire their current worker-lease authority into this boundary.
- The repair regression replaces the worker lease after routing and transport
  acquisition. The stale worker is rejected before token counting and produces
  zero reservation, provider, model-call, or cost records. The existing
  two-manager claim race remains atomic and single-spend.
- Agent execution contracts now require exact status shapes: RUNNING has no
  completion/output, SUCCEEDED has both, and FAILED/PAUSED have completion but
  no output. Durable execution history must originate as RUNNING, immutable
  identity fields replay exactly, and only legal RUNNING-to-terminal evolution
  is accepted.
- Migration-v20 validation now proves the declared non-partial unique constraint
  is exactly on `agent_execution_id`; omission, wrong-column, and partial-index
  substitutes fail closed. Trigger and ancestry validation remain exact.
- Legacy classification fixtures were updated to exercise the legal
  RUNNING-to-SUCCEEDED transition rather than bypassing the strengthened public
  invariant. No production behavior was weakened for compatibility.
- Focused round-5 boundary gate: 122 tests passed. Final no-key Engineer source
  gate: 310 tests / 1,822 assertions across 36 files. Workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Pair 2B Terra repair round 6

- Worker fencing loss is now one explicit control-flow class through
  `isWorkerAuthorityLoss`. Direct stale/conflict errors and an aborted signal
  carrying either reason bypass operational/provider failure classification.
- Verification transport acquisition and Builder execution rethrow authority
  loss before agent finalization or any durable query/write. Initial execution
  performs the same early rethrow before reading the run, recording a failure,
  terminalizing the agent, authorizing a retry, transitioning state, or
  destroying the sandbox.
- Builder authority checks remain immediately before token counting and every
  reservation. The pre-provider check now sits outside the provider catch, so
  fencing loss cannot enter model-retry authorization or create a false failed
  model call. An awaitable post-reservation seam proves that exact boundary.
- Adversarial lease replacement after transport acquisition leaves one auditable
  claim/route, the agent RUNNING, and the run IMPLEMENTING with zero token
  counting, reservation, provider, model, cost, retry, failure, or post-fence
  transition. Replacement after reservation leaves only its one ACTIVE
  pre-fence reservation and otherwise the same zero-mutation result.
- A shared Builder regression independently proves post-reservation authority
  loss invokes neither provider creation nor retry classification.
- Final no-key Engineer source gate: 312 tests / 1,845 assertions across 36
  files. Workspace typecheck and `git diff --check` passed; paid provider calls:
  zero.

### Pair 2B Terra repair round 7

- Provider rejection handling now rechecks worker authority immediately before
  retry authorization. A worker fenced while its request is in flight cannot
  record a false failed model call, consume retry authority, or transition the
  workflow; its pre-fence reservation remains explicit for reconciliation.
- A successful response remains durable charged model/cost evidence, then
  authority is rechecked before recording response IDs, parsing calls, writing
  continuation state, or using any paid output. Each tool in a multi-tool
  response receives its own fresh fence immediately before execution.
- Real lease replacement inside `transport.create` covers both provider reject
  and successful `write_file` response outcomes. Both leave the claimed agent
  RUNNING and run IMPLEMENTING with no new failure, retry, or state event. The
  reject path keeps only the active reservation; the success path keeps its
  exact successful model/cost record while workspace bytes, commands,
  continuation, and Builder result remain unchanged.
- A separate two-tool response revokes authority between a safe read and a
  write, proving the second tool is independently fenced and cannot mutate the
  workspace.
- Final no-key Engineer source gate: 314 tests / 1,876 assertions across 36
  files. Workspace typecheck and `git diff --check` passed; paid provider calls:
  zero.

### Day 1C Pair C1 — verified candidate checkpoint foundation

- Added the strict v1 `VerifiedCandidateCheckpoint` contract with the exact
  frozen run, requester, repository, Required Lane, manifest, commits, diff,
  Reviewer classification, evidence bundle, environment, claim, verification,
  security, scope, and Builder-dispatch bindings. Parent checkpoint identity is
  structurally null in v1.
- Every identity set and Builder claim is normalized with locale-independent
  code-unit ordering. Set hashes, the canonical checkpoint content hash, and
  the namespace-derived checkpoint ID are deterministically recomputed and
  validated; IDs and hashes cannot authorize their own content.
- Added an in-toto-style signed statement, canonical statement bytes/hash, and
  fail-closed `CheckpointAttestor` signing/verifying boundary. Statement subject
  repository/base/result bindings must match the checkpoint, and signer
  algorithm/key identity plus the exact canonical payload are verified.
- Ordered migration v21 creates the immutable
  `verified_candidate_checkpoints` authority table with exact run/user/
  repository/contract/manifest/Reviewer/classification/evidence foreign keys,
  three one-to-one unique bindings, v1/ready checks, canonical JSON/signature
  storage, run index, cross-record match trigger, and update/delete guards.
- Approval requests and Git operations gain paired nullable checkpoint ID/hash
  links so legacy rows remain readable without backfill. Insert/update triggers
  reject half identities, mismatched run/classification/evidence bindings, and
  Git/approval checkpoint substitution. Application promotion/writes remain
  intentionally dark for C2+.
- Migration ancestry and exact shape validation cover columns, checks,
  composite/individual foreign keys, non-partial unique indexes, run index,
  and byte-normalized trigger bodies. Tests cover deterministic reorder,
  content/signature tampering, invalid summaries, signer failure, legacy null
  migration, counterfeit columns/unique indexes/triggers, and v21 ancestry.
- Pair-C1 focused gate: 30 tests / 157 assertions. Final no-key Engineer source
  gate: 322 tests / 1,917 assertions across 37 files. Workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Day 1C Pair C1 repair round 1

- Checkpoint authority now binds the exact Reviewer session independently of
  the session's input evidence hash. The exact classification batch must bind
  the Required Lane contract and its stored result must equal the checkpoint
  result; BLOCKED, REPAIR_REQUIRED, READY, and READY_WITH_ADVISORIES cannot be
  relabeled at checkpoint creation.
- Evidence authority now requires bundle schema v2 and exact durable
  `reviewerSessionId`, `classificationHash`, and `classificationResult`
  bindings. Adversarial tests reject every omitted, stale, or relabeled field.
- Approval and Git checkpoint ID/hash links are write-once: legacy null links
  remain null and linked rows cannot be rebound, even to another valid pair.
  The migration validator proves all four exact foreign keys, their targets,
  and `ON DELETE RESTRICT` behavior and rejects counterfeit table shapes.
- Caller-provided durable summary hashes are preserved in the signed content;
  the v1 schema validates canonical sorted/unique identity sets, while durable
  record-content recomputation remains intentionally assigned to C2.
- Checkpoints reject RUNNING Builder claims, use a standard in-toto
  ResourceDescriptor subject (`name` plus `digest.sha256`), and accept an
  attestor verification result only when it is the boolean `true`. Numeric,
  string, thrown, rejected, forged, and wrong-key outcomes all fail closed.
- Repair-round focused gate: 33 tests / 207 assertions. Final no-key Engineer
  source gate: 325 tests / 1,965 assertions across 37 files. Package typecheck
  passed; paid provider calls: zero.

### Day 1C Pair C1 repair round 2

- The embedded Builder dispatch records are now a self-verifying set:
  `builderDispatchSummary.claimSetHash` must equal the canonical SHA-256 of the
  locale-independently sorted full claim records. This is intentionally
  separate from claim/test/security summary hashes whose underlying records
  are external and remain caller-supplied until C2 rehydrates them.
- Checkpoint construction sorts Builder claims before validation, so equivalent
  input order produces one stable claim-set hash and checkpoint identity.
  Caller-supplied and persisted mismatched Builder claim hashes fail closed.
- Repair-round focused gate: 33 tests / 210 assertions. Final no-key Engineer
  source gate: 325 tests / 1,968 assertions across 37 files. Package typecheck
  passed; paid provider calls: zero.

### Day 1C Pair C2 — atomic verified-candidate promotion

- Added Supervisor and ledger promotion APIs that accept only exact authority
  selectors plus the checkpoint attestor. The ledger derives every checkpoint
  summary from durable records; callers cannot supply claim, test, security,
  scope, environment, Builder summary hashes, or a transition timestamp. The
  checkpoint/event time is derived from the hash-bound classification batch.
- Promotion snapshots and signs a fully rehydrated candidate, then acquires a
  `BEGIN IMMEDIATE` writer transaction and recomputes the entire authority
  content before inserting. Any concurrent durable change is rejected before
  insertion. Checkpoint insertion and the `REVIEWING` to `REVIEW_APPROVED`
  transition commit atomically, and the transition's sole evidence identity is
  the checkpoint ID.
- Exact current-manifest Required Lane authority, the unique latest classified
  SOL Reviewer, READY/READY_WITH_ADVISORIES result, one exact Evidence Bundle
  v2, canonical bundle hash/columns/artifacts/claims, one current required-test
  pass, environment/commit identity, zero blocking critical findings, final
  scope success, and complete terminal Builder execution/dispatch coverage are
  all fail-closed preconditions. Empty Builder coverage and an all-failed or
  all-paused Builder history cannot produce a verified candidate.
- Claim, verification, and security set hashes bind canonical sorted full
  durable records. Builder claims bind the full v20 dispatch plus terminal
  execution/output shape. A later test pass, additional durable record,
  mismatched bundle hash/environment, or orphan Builder invalidates promotion.
- Strict reads resolve a run through its unique promotion event, or resolve an
  explicit checkpoint ID; they never choose a latest timestamp. Reads verify
  canonical checkpoint bytes, every duplicated relational column, canonical
  in-toto statement bytes/hash, signer identity/signature, exact predicate, the
  sole state-event authority including its ID, run, sequence/version, states,
  reason, actor, time, manifest, idempotency key, and sole evidence ID, and a
  fresh full durable-record recomputation.
- Exact replay returns the same checkpoint without another transition; changed
  replay conflicts. Two independent database connections converge on one row.
  An injected failure after checkpoint insertion rolls back both row and state.
  Tests also cover non-ready classification, READY_WITH_ADVISORIES, immutable
  rows, forged signatures, noncanonical JSON, and post-checkpoint record drift.
- C2 focused gate: 63 tests / 407 assertions. Final no-key Engineer source gate:
  334 tests / 2,014 assertions across 37 files. Workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Day 1C Pair C2 repair round 1

- Successful Builder authority now binds a fully terminal execution, exact
  dispatch claim, trusted result-artifact provenance, regular non-symlink file
  bytes, size and SHA-256, parsed Builder-result run/manifest/diff identity, and
  chronological start/result/completion timestamps. The unique latest
  successful Builder result must bind the Reviewer diff. Every terminal
  Builder must predate classification and successful result completion must
  exactly equal its durable agent completion time.
- Initial Builder work now acquires the same atomic dispatch claim and active
  lease/fence used by repair Builders before routing, transport, or provider
  work. Resumed budget attempts receive a fresh state-version-bound claim;
  paused or duplicate dispatches cannot masquerade as successful authority. A
  losing concurrent worker exits through a dedicated authority-loss path with
  zero provider calls, failure records, or state transitions, leaving the
  durable winner in control.
- Required-test evidence now revalidates the exact trusted command executor,
  audit timestamp, and canonical audit details containing verification, test,
  criterion, command, type, and status bindings. Field omission, actor
  substitution, timestamp drift, and noncanonical JSON all fail closed.
- Checkpoint reads validate the complete state-event sequence from version one
  through the run head, including contiguous sequence/version, predecessor and
  successor states, run version/state agreement, and the immediate REVIEWING
  predecessor of the promotion event. Migration v21 makes every existing and
  future state event immutable through exact update/delete triggers, and the
  schema validator rejects missing or counterfeit guards.
- Generic Supervisor transitions can no longer enter REVIEW_APPROVED. The
  VerificationManager READY/READY_WITH_ADVISORIES path now crosses the signed
  checkpoint promotion boundary through an injected fail-closed attestor; the
  gateway persists and reloads its local HMAC-SHA256 checkpoint identity.
- Strict historical reads now resolve only the durable record identities bound
  by the signed checkpoint. Later unrelated claims, tests, audits, failed
  Builder attempts, advisory findings, and legitimate later state transitions
  remain visible in current history without retroactively invalidating the
  verified snapshot; mutation of a referenced record still fails closed.
- Repair-focused adversarial coverage exercises all provenance, bytes,
  terminal-time, dispatch, audit, chain/head, immutability, bypass, historical
  append, and bridge cases. Final no-key Engineer source gate: 339 tests /
  2,074 assertions across 37 files. Full workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Day 1C Pair C2 repair round 2

- Initial Builder election now occurs immediately after validating the QUEUED
  run and acquiring/asserting current lease authority. The atomic durable
  dispatch claim precedes every run transition, sandbox claim/provision,
  workspace checkpoint, artifact/resource mutation, routing record, budget
  reservation, and provider call. A losing worker releases only its own lease
  and local identity; a regression proves the complete exported run ledger is
  byte-for-byte unchanged, the run remains QUEUED, and spend/failures stay zero.
- Checkpoint v1 now signs a canonical pre-promotion event-chain snapshot through
  the exact REVIEWING head: event count, head identity/sequence/version, and a
  SHA-256 over every full immutable event field with canonical evidence order.
  The chain is recomputed under the promotion write lock, strict reads resolve
  the exact signed historical prefix, and the promotion remains a separately
  validated immediate successor. Semantic actor, reason, evidence, timestamp,
  and idempotency rewrites all fail even when continuity remains valid.
- Embedded Builder claims now bind terminal start/completion plus complete
  successful output authority: artifact identity/hash/size/type, producer,
  trust classification, and regular non-symlink file semantics. The existing
  canonical claim-set hash covers the complete enriched records.
- Required-test summaries now sign sorted audit identities and a canonical
  provenance hash covering the exact verification record, full trusted command
  record, stdout/stderr artifact records and bytes, environment/commit/result,
  and exact audit identity/actor/details/time. Every authority timestamp is
  bounded by classification. Coordinated Builder bytes, command, audit-ID, and
  artifact-producer rewrites fail strict historical rehydration.
- An applied promotion is no longer acknowledged from the precommit object.
  After commit, the ledger performs a fresh signature, relational, byte, event,
  and durable-authority rehydration and returns only that strict result. A
  postcommit seam attack that mutates Builder bytes before acknowledgment is
  rejected, and future reads remain fail-closed.
- Independent A-D audit result: GO, with no concrete blocker. Final no-key
  Engineer source gate: 343 tests / 2,096 assertions across 37 files. Full
  workspace typecheck and `git diff --check` passed; paid provider calls: zero.

### Day 1C Pair C2 repair round 3

- Successful Builder output authority now signs the durable artifact
  `createdAt` timestamp in the canonical dispatch claim and claim-set hash. The
  contract requires a strict finite ISO timestamp and rejects missing,
  malformed, or independently shifted artifact creation authority.
- Promotion and strict rehydration require one exact terminal lineage:
  `execution.startedAt <= artifact.createdAt === execution.completedAt ===
  BuilderResult.completedAt <= classification.createdAt`. Initial and repair
  Builder artifact writers now persist the result completion timestamp as the
  artifact creation timestamp so real production records satisfy that exact
  boundary rather than relying on adjacent wall-clock reads.
- Direct contract/hash tests plus promotion and historical-read attack matrices
  cover post-classification, pre-execution, malformed, independently shifted,
  and coordinated post-checkpoint timestamp rewrites. Every mutation fails
  closed without changing any unrelated authority.
- Final no-key Engineer source gate: 343 tests / 2,105 assertions across 37
  files. Full workspace typecheck and `git diff --check` passed; paid provider
  calls: zero.

### Day 1C Pair C3-A — sole classified promotion caller

- `applyClassifiedOutcome` is now an exhaustive classification switch. Only
  READY and READY_WITH_ADVISORIES cross the signed verified-candidate boundary;
  HUMAN_REVIEW_REQUIRED, REPAIR_REQUIRED, and BLOCKED take explicit
  non-promotion recovery paths. An impossible future classification fails the
  exhaustive type boundary instead of inheriting an approval default.
- The two ready outcomes pass the exact run, Reviewer session, classification,
  Evidence Bundle, checkpoint attestor, and current state version to the
  dedicated promotion API. Verification lease authority is asserted as the
  final operation immediately before that call. A table test covers every
  classification, exact promotion count/arguments, and the lease/promotion
  ordering.
- Every generic incoming state-machine edge to REVIEW_APPROVED was removed,
  including CODE_REVIEW, REVIEWING, and HUMAN_REVIEW_REQUIRED. A complete
  RUN_STATES table proves `canTransition(state, REVIEW_APPROVED)` is false for
  every state, while the dedicated ledger promotion remains intact.
- Public Supervisor transitions reject both HUMAN and SUPERVISOR attempts to
  enter REVIEW_APPROVED, with or without legacy review facts/evidence. No
  generic event or state mutation is produced.
- C3-B/C were intentionally not started. Focused C3-A plus C2 preservation
  gate: 109 tests / 1,005 assertions. Final no-key Engineer source gate: 344
  tests / 2,174 assertions across 37 files. Full workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Day 1C Pair C3-B — classified crash recovery

- Test-only crash seams now exist immediately after strict classified-session
  persistence and immediately after exact Evidence Bundle persistence. Neither
  seam changes production ordering or grants a model output recovery authority.
- Restart recovery begins only from the fully rehydrated classified Reviewer
  authority. It deterministically re-derives claim identities, Evidence Bundle
  identity, classification-time claim timestamps, and the exact canonical
  artifact set, then reuses the same exhaustive `applyClassifiedOutcome`
  boundary as the uninterrupted path. Reviewer, Tester, Security, Builder, and
  failure-advisor transports are never acquired during this recovery.
- Evidence Bundle convergence is exact: zero matching bundles creates the
  expected record, one must be byte-identical, and multiple or conflicting
  records fail closed. Recovery never selects authority by latest timestamp.
- READY and READY_WITH_ADVISORIES were crashed at both persistence boundaries.
  All four restarts produced identical claim, bundle, hash, and content
  authority, exactly one signed checkpoint and promotion event, and
  REVIEW_APPROVED. A second recovery was byte-for-byte mutation-free.
- HUMAN_REVIEW_REQUIRED, REPAIR_REQUIRED, and BLOCKED recovery paths were
  exercised as model-free zero-promotion actions. Existing ledger coverage
  confirms a legacy raw Reviewer session cannot be retroactively classified or
  synthesized into recovery authority.
- Focused C3-B/C2 authority gate: 112 tests / 1,081 assertions. Final no-key
  Engineer source gate: 347 tests / 2,250 assertions across 37 files. The
  affected verification suite passed 39 tests / 383 assertions after the
  static fix; full workspace typecheck and `git diff --check` passed. Paid
  provider calls: zero. C3-C was intentionally not started.

### Day 1C Pair C3-C — fenced concurrent classified recovery

- Classified execution now reasserts the active worker lease immediately after
  strict classified-authority rehydration, after the classification crash/fault
  seam before derived claim persistence, immediately after exact Evidence
  Bundle persistence, after the bundle fault seam, and at the existing final
  boundary immediately before signed candidate promotion.
- Lease revocation and monotonic replacement at the post-classification seam is
  pure worker-control flow: no derived claim, bundle, checkpoint, promotion,
  failure, recovery transition, or provider call is written. Revocation after
  bundle persistence preserves exactly one reusable canonical claim/bundle but
  still produces no checkpoint, promotion, failure, transition, or provider
  call; a subsequent current worker reuses those exact bytes and promotes once.
- Two independent recovery managers over two database connections reconstruct
  the same deterministic classified authority concurrently without model or
  failure-advisor transport. The ledger converges truthfully as one applied
  promotion and one strict replay, with identical claims, Evidence Bundle, and
  signed checkpoint, exactly one bundle/checkpoint/promotion event, and no
  loser-side failure record.
- C3-A's sole promotion caller, C3-B's exact replay rules, C2's signed authority,
  and Pair 2B Builder/provider fencing remain covered. Focused preservation
  gate: 172 tests / 1,430 assertions across seven suites. Final no-key Engineer
  source gate: 349 tests / 2,285 assertions across 37 files. Full workspace
  typecheck and `git diff --check` passed; paid provider calls: zero.

### Day 1C Pair C3-C repair round 1 — sandbox reconstruction fencing

- The real ExecutionManager sandbox-recovery boundary now accepts the current
  verification worker's authority assertion. It checks authority for cached
  recovery, before reconstruction, immediately after every asynchronous
  recovery operation, before caching the reconstructed sandbox, and directly
  around the SANDBOX_RECOVERY_ATTESTATION artifact and ledger writes.
- Classified recovery passes its live lease assertion into ExecutionManager,
  reasserts immediately after `recoverSandbox` returns, and reasserts again
  immediately before exact Evidence Bundle convergence. Other verification
  recovery paths pass the same callback and recheck after return.
- An adversarial test uses the real ExecutionManager with a delayed sandbox
  adapter, expires and replaces the worker lease while `recoverAsync` is
  awaiting, then releases the await. The stale worker exits as authority-loss
  control flow before caching or attesting recovery: zero post-loss artifacts,
  recovery attestations, bundles, checkpoints, promotions, failures,
  transitions, or provider calls, and the complete pre-loss durable export is
  byte-identical afterward.
- C3-A/B/C promotion and convergence behavior plus Pair 2B provider/Builder
  fencing remain covered. Focused verification and ExecutionManager gate: 87
  tests / 664 assertions. Focused preservation gate: 173 tests / 1,443
  assertions across seven suites. Final no-key Engineer source gate: 350 tests
  / 2,298 assertions across 37 files. Full workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Day 1D Pair C4.1 — checkpoint-bound publication contracts and v22 schema

- New approval requests, human decisions, Git operations, and Supervisor PR
  commands have strict write contracts requiring an exact verified checkpoint
  ID/hash pair. Separate read-only legacy contracts preserve nullable v21 rows
  without granting them new mutation authority.
- Migration v22 adds nullable decision checkpoint columns with exact RESTRICT
  foreign keys, a deterministic index, and insert/update triggers that require
  complete pairs, match the immutable approval request, and bind the same run.
  No backfill is performed; populated v21 null rows remain readable.
- Exact migration validation rejects incomplete ancestry and counterfeit
  columns, foreign keys, indexes, or triggers. Contract and migration tests
  reject missing/single pairs and preserve legacy exports.
- Final no-key Engineer source gate: 353 tests / 2,324 assertions across 37
  files. Full workspace typecheck and `git diff --check` passed; paid provider
  calls: zero. Runtime publication wiring remained intentionally deferred.

### Day 1D Pair C4.2 — strict approval linkage and compare-and-swap

- Approval creation now accepts only the strict v22 write contract and a
  caller-supplied checkpoint attestor. Before insertion it strictly rehydrates
  signed checkpoint authority and compares the complete run, manifest, diff,
  Evidence Bundle, Reviewer session, classification, checkpoint ID, and
  checkpoint hash tuple. Both checkpoint columns and their audit binding are
  persisted; legacy null rows continue through the explicit read contract only.
- Human approval decisions persist their expected checkpoint pair and update
  only a PENDING request with that exact immutable pair. Decision/status
  semantics are deterministic, exact decision-ID replay is idempotent, changed
  replay conflicts, and a lost update rolls back both the decision and audit.
- Extensions use the same transaction, expected-pair check, and PENDING CAS.
  Extension target replay is exact and one extension is permitted per request,
  preventing a later mutation from rebinding earlier authority. Expiry is a
  checkpoint-bound REJECT decision to EXPIRED. Legacy null requests cannot be
  decided, extended, expired, or otherwise mutated through these Supervisor APIs.
- New approval writes are PENDING-only. After asynchronous attestation the
  ledger rechecks REVIEW_APPROVED under the same transaction as replay lookup,
  insertion, and audit persistence. Existing exact delivery replay remains
  valid after the run advances; new stale IDs and changed replay fail closed.
- Adversarial coverage includes two Supervisor connections competing for one
  request, stale/wrong pairs, changed same-ID replay, extension and expiry,
  legacy blocking, and a forced post-insert CAS loss proving no partial decision
  remains. Final no-key Engineer source gate: 355 tests / 2,357 assertions
  across 37 files. Full workspace typecheck and `git diff --check` passed; paid
  provider calls: zero. Publication-manager orchestration remains C4.3 scope.

### Day 1D Pair C4.3 — checkpoint-bound publication orchestration

- PublicationManager now requires the checkpoint attestor used by verification.
  Start strictly rehydrates the run's signed verified-candidate checkpoint and
  compares its run, manifest, diff, Evidence Bundle, Reviewer session, and
  classification tuple before creating approval or taking the low-risk auto
  path. Approval requests persist the exact checkpoint ID/hash pair through the
  strict C4.2 Supervisor API.
- Approve, request-changes, reject, extend, and expiry strictly rehydrate the
  request's checkpoint ID rather than selecting latest authority. Each decision
  carries the immutable request pair into the Supervisor CAS. Missing, legacy,
  invalid, mismatched, and stale pairs stop before a human decision or Git call.
- Publication resume rehydrates both the run checkpoint and, for gated runs,
  the same durable approval request/checkpoint. Low-risk auto publication and
  restart paths cannot bypass signed checkpoint validation.
- Gateway construction supplies the same checkpoint attestor and awaits the
  now-asynchronous expiry sweep. C4.4 publication preflight ordering and C4.5
  strict Git/PR command wiring remain intentionally deferred and fail closed at
  their existing storage boundaries.
- Focused publication gate: 15 tests / 100 assertions. Final no-key Engineer
  source gate: 357 tests / 2,386 assertions across 37 files. Full workspace
  typecheck and `git diff --check` passed; paid provider calls: zero.

### Day 1D Pair C4.3 repair round 1 — deadline and approval-revision fencing

- Approval requests now carry a durable nonnegative revision. New v22 writes
  start at revision zero, every request mapper exposes the stored revision, and
  legacy v21 rows acquire the migration default without being granted strict
  mutation authority. New decision records must persist the exact revision the
  reviewer saw; legacy decision reads remain explicitly nullable.
- Terminal decisions re-read the request inside the write transaction and use
  Supervisor server time, the immutable checkpoint pair, PENDING status, and
  the expected revision in one compare-and-swap. Approve, request-changes, and
  reject are valid only through the deadline; expiry is valid only strictly
  after it. A successful terminal decision increments the revision exactly
  once, and a failed CAS rolls back the decision and audit together.
- Extensions use the same server-time and revision fence, require a strictly
  later deadline, increment the revision atomically, and preserve exact
  same-decision replay. PublicationManager captures the displayed revision
  before asynchronous checkpoint attestation and passes that exact value to
  every approval, rejection, changes, extension, and expiry operation, so an
  intervening request mutation produces a conflict instead of stale authority.
- Adversarial coverage proves a delayed approval crossing its deadline leaves
  zero durable decision or transition; an expiry awaiting attestation loses to
  a concurrent extension; two synchronized independent processes racing
  extensions against the same database produce exactly one winner; and a
  browser action using the pre-extension revision is rejected while the
  extended request remains PENDING at revision one. Exact v22 validation also
  rejects counterfeit request or decision tables with either nonnegative
  revision CHECK constraint removed.
- Focused affected gate: 59 tests / 439 assertions. Final no-key Engineer source
  gate: 358 tests / 2,410 assertions across 37 files. Full workspace typecheck
  and `git diff --check` passed; paid provider calls: zero.

### Day 1D Pair C4.4 — immutable publication authority and remote-call ordering

- Publication now constructs one immutable authority before every publication
  path can inspect or mutate a Git provider. Human publication selects only the
  exact checkpoint ID/hash stored on the approved request; it never falls back
  to run-level or latest checkpoint selection. LOW no-gate publication selects
  the uniquely promoted run checkpoint.
- Strict checkpoint rehydration and signature verification precede mutable
  safety reads. The resulting authority validates the checkpoint ID/hash, run,
  requester, repository, Required Lane contract, manifest, base/result commits,
  diff, Reviewer session, classification, Evidence Bundle ID/hash, and
  environment digest. Human authority additionally requires the exact APPROVE
  decision, checkpoint pair, assigned actor, complete decision history, and
  approval revision.
- Because attestation can await remote or hardware-backed verification, the
  pre-await run and approval are selection hints only. The manager refetches
  the run and exact same approval after attestation, rejects route or approval
  drift, and builds the authority solely from the post-await snapshot. Ordered
  approval history is exhaustive: every prefix row is an exact checkpoint-bound
  EXTEND at its sequential revision, and the sole final row is the exact
  assigned-reviewer APPROVE decision.
- Repository, commit, command, and PR invocation values come only from the
  frozen authority. Immediately before CREATE_BRANCH, PUSH_COMMIT, CREATE_PR,
  base synchronization, or credentialed reconciliation, the manager strictly
  rehydrates the same checkpoint ID and compares the complete authority
  fingerprint plus the current state fence. Authority drift exits before a
  remote mutation or reconciliation call.
- Instrumented adversarial coverage proves bad signatures, missing checkpoints,
  legacy null bindings, stale checkpoint hash/diff/base/result/classification/
  evidence, wrong run/repository, wrong approval decisions, and stale approval
  revisions produce zero calls across inspection, reconciliation,
  synchronization, branch creation, push, and PR creation. Restart with the
  same checkpoint remains replayable; changed authority before mutation or
  reconciliation conflicts without the credentialed call.
- C4.5 remains intentionally deferred: Git operation and PR command writes use
  their legacy read contracts and therefore remain fail-closed at the strict
  v22 storage boundary in real ledgers. Delayed-attestor tests prove state
  changes during authority construction stop the first inspection, mutation,
  and reconciliation call. Focused publication gate: 21 tests / 154 assertions.
  Broader preservation gate: 119 tests / 793 assertions across five suites.
  Final no-key Engineer source gate: 363 tests / 2,457 assertions
  across 37 files. Full workspace typecheck and `git diff --check` passed; paid
  provider calls: zero.

### Day 1D Pair C4.5 — checkpoint-bound Git operations and signed PR commands

- Every new credentialed Git operation now uses the strict write contract and
  persists the exact verified-candidate checkpoint ID/hash pair. The SQLite
  INSERT path stores both fields and immutable replay comparison includes both;
  STARTED-to-terminal updates cannot change the operation's authority tuple.
  Legacy null-pair rows remain available through the explicit read union only.
- Publication idempotency namespaces are derived from run identity, the exact
  checkpoint hash, and the relevant base/result commit. The former
  classification-derived namespace and legacy-key lookup fallback are removed.
  A checkpoint change therefore creates a distinct namespace even when the
  result commit is unchanged.
- Publication replay compares operation type, base/result commits, approval,
  Evidence Bundle, checkpoint ID, and checkpoint hash before reconciliation or
  remote mutation. Same-key disagreement fails closed before the Git service;
  a legacy STARTED row cannot resume, reconcile, or mutate. Restart with the
  same pair retains the bounded STARTED reconciliation behavior.
- The Supervisor PR command is strict, carries the exact checkpoint pair, and
  signs the complete canonical command bytes. Tampering either checkpoint field
  invalidates signature verification. Every inspection, branch, push, and PR
  operation is emitted from the immutable C4.4 authority pair.
- Adversarial coverage proves all six operations in a successful publication
  carry the pair, PR-command pair tampering fails, changing the checkpoint
  changes operation keys, legacy STARTED recovery makes zero reconciliation or
  provider calls, checkpoint/approval conflicts make zero calls, and a real
  SQLite ledger preserves exact STARTED-to-SUCCEEDED replay while rejecting a
  changed pair. Focused gate: 69 tests / 525 assertions across two suites.
  Final no-key Engineer source gate: 368 tests / 2,496 assertions across 37
  files. Full workspace typecheck and `git diff --check` passed; paid provider
  calls: zero.

### Day 1D Pair C4.5 repair round 1 — historical replay and fast-path fencing

- The independent audit found that exact new-key lookup alone could miss a
  historical unbound operation stored under the former namespace. Publication
  now scans all run-scoped CREATE_BRANCH, PUSH_COMMIT, and CREATE_PR records
  before exact lookup and fails closed on either missing checkpoint field.
  Actual old-key STARTED and SUCCEEDED fixtures prove zero reconciliation and
  zero provider mutation.
- COMPLETED and PR_CREATED fast replay no longer trusts a matching key/status.
  The same validator used by ordinary publication first compares type, base and
  result commits, approval, Evidence Bundle, checkpoint ID, and checkpoint hash.
  Both terminal states reject changed checkpoint or approval authority without
  another Git call.
- The initial read-only inspection namespace now includes the result commit as
  well as run identity and checkpoint hash, matching all five later operation
  namespaces. The successful-publication test asserts the result commit across
  all six operation rows.
- Independent repair re-audit: GO, no remaining finding; 54 tests / 339
  assertions. Final focused gate: 70 tests / 550 assertions across two suites.
  Final no-key Engineer source gate: 369 tests / 2,521 assertions across 37
  files. Full workspace typecheck and `git diff --check` passed; paid provider
  calls: zero.

### Day 1D Pair C4.6 — restart recovery and browser approval authority

- Restart recovery now enumerates durable publication states while preserving
  the exact verified checkpoint authority. A replacement manager can rehydrate
  and complete an interrupted operation bound to the same checkpoint exactly
  once; a subsequent restart is a no-op. Stale authority and ambiguous remote
  results remain fail-closed and never trigger a blind credentialed mutation.
- Historical checkpointless approval or Git-operation rows remain readable but
  are explicitly classified as non-retryable manual-review conflicts. Recovery
  records one stable failure and does not inspect, reconcile, synchronize, or
  mutate Git; repeated boots do not duplicate either work or failure records.
- Every browser approval action now carries the checkpoint ID, checkpoint hash,
  and approval revision visible to that browser. Approve, request changes,
  reject, extend, and expire validate this tuple locally before a remote
  admission probe, then repeat the check immediately before the durable CAS.
  Missing authority is rejected at ingress. A changed candidate returns the
  stable `ENGINEER_CANDIDATE_CHANGED` HTTP 409 with `REFRESH_APPROVAL`, rather
  than a generic server failure.
- Approval reads expose the checkpoint pair and revision required for the next
  decision. The web client refuses to send a decision without that displayed
  authority and surfaces the refresh action. A two-browser race proves exactly
  one decision succeeds and the other receives the actionable 409; all five
  control endpoints are covered for exact tuple forwarding.
- Focused C4.6 gate: 107 tests / 1,315 assertions across publication, gateway,
  and web CAS suites. Final no-key Engineer source gate: 375 tests / 2,561
  assertions across 37 files. Final no-key gateway gate: 326 tests / 3,128
  assertions across 23 files. Focused web gate: 12 tests / 51 assertions across
  two files. Full workspace typecheck and `git diff --check` passed; paid
  provider calls: zero.

### Day 1D Pair C4.6 repair round 1 — durable approval CAS conflict translation

- Independent audit found that a true durable approval CAS loser raised the
  ledger's generic idempotency conflict, which the HTTP boundary returned as a
  400 even though the simulated browser test returned the intended actionable
  409. Publication now translates that error only within the immediate approval
  decision/extension CAS callback. Unrelated errors and all Git/publication
  idempotency paths remain outside the translation boundary.
- A direct concurrent publication test forces two decisions past attestation
  and proves one fulfillment, one stable candidate-changed conflict, and one
  transition. A full gateway-to-run-manager-to-publication concurrent extension
  test proves HTTP `[200, 409]` and the exact `REFRESH_APPROVAL` payload.
- Independent repair re-audit: GO, no remaining C4.6 blocker; 137 tests / 1,424
  assertions across publication, handler, gateway manager, and web CAS suites.
  `git diff --check` passed; paid provider calls: zero.

### Day 1E Pair C5.1 — verified candidate and approval read models

- Added a strict nine-field `VerifiedCandidateSummary` allowlist containing only
  checkpoint identity/hash, result commit, classification, required-test count,
  required-check status, open blocking-critical count, environment digest, and
  creation time. Projection reparses the full checkpoint first and omits user,
  repository, manifest, diff, reviewer, evidence, Builder, and scope internals.
- The gateway run manager receives the same checkpoint attestor instance used
  for promotion and publication. Its owner-authenticated checkpoint read uses
  the Supervisor's strict attestation and durable-authority rehydration. It
  returns null only when no promotion event exists; malformed, mismatched, or
  corrupt promoted authority fails the read closed.
- Added bearer- and owner-gated
  `GET /v1/engineer/runs/:runId/checkpoint`. The coherent snapshot is now async,
  verifies the checkpoint between its before/after state and event fences, and
  retries if either fence changes during verification. Checkpoint failures are
  not downgraded into best-effort section errors.
- Approval reads preserve the complete approval metadata while exposing a
  separate compare-and-swap authority tuple only for a PENDING, checkpoint-bound
  nonlegacy approval. The approval and authority projection are derived from one
  read. Decided and legacy approvals expose null authority.
- SSE cursors and event serialization remain unchanged; the exact promotion
  checkpoint evidence ID is replayed in the durable state event. Focused local
  gate: 114 tests / 1,237 assertions across checkpoint, gateway manager, and
  handler suites. Final no-key Engineer gate: 376 tests / 2,570 assertions
  across 37 files. Final no-key gateway gate: 332 tests / 3,149 assertions
  across 23 files. Full workspace typecheck and `git diff --check` passed.
  Independent audit: GO, 122 tests / 1,253 assertions; paid provider calls:
  zero.

### Day 1E Pair C5.1 repair round 1 — missing promoted authority fails closed

- Run-reference checkpoint lookup now distinguishes an absent promotion event
  from a promotion event whose referenced checkpoint row is missing. Only the
  former returns null. The latter throws the stable
  `ENGINEER_VERIFIED_CANDIDATE_CORRUPT` integrity error. Explicit unknown
  checkpoint-ID probes retain their intentionally nullable semantics.
- A real SQLite adversarial test promotes a candidate, disables only the
  immutability protection required by the fixture, deletes the authority row,
  and proves run lookup rejects. Existing signature and canonical-content
  tampering remains fail-closed. Gateway manager tests prove both checkpoint and
  coherent snapshot reads propagate the integrity failure; the checkpoint HTTP
  route returns a stable 500 error and never `verifiedCandidate: null`.
- Repair focused gates: real-ledger adversarial case 1 test / 3 assertions;
  gateway manager and handler 109 tests / 1,191 assertions. Final no-key
  Engineer gate: 377 tests / 2,573 assertions across 37 files. Final no-key
  gateway gate: 333 tests / 3,152 assertions across 23 files. Full workspace
  typecheck and `git diff --check` passed; paid provider calls: zero.

### Day 1E Pair C5.2 — machine-verification UI and human-review bypass removal

- Human-review control now accepts only reject or an already-authorized recovery
  retry. The legacy `approve` value returns the stable
  `ENGINEER_VERIFIED_CANDIDATE_REQUIRED` HTTP 409 with `RETRY_OR_REJECT` before
  manager invocation, including malformed legacy requests without a rationale.
  Tests prove zero transition, checkpoint, approval, Git, or provider work.
- Added a compact semantic `Machine verified` card rendered only from the
  snapshot's strict verified-candidate summary. It shows shortened checkpoint,
  result commit and environment identities, classification, required tests,
  blocking-critical count, and verified time; full identities remain available
  only as existing title text. It has no candidate-creation control.
- Human approval remains a separate gate. Approve, request changes, reject, and
  extend are enabled only when the snapshot candidate exactly matches the
  displayed approval checkpoint ID/hash and the page is neither busy nor stale.
  Candidate-change conflicts keep the controls disabled and announce
  `Candidate changed—refresh before deciding.` through a polite live region.
- The human-review recovery card contains only authorized retry and reject; the
  former Continue-to-approval bypass is removed. A tested truth matrix prevents
  a Human-approved label before a durable approved decision. Promotion and
  approval SSE events trigger a full snapshot refresh while ordinary hot events
  retain the lightweight status path.
- The card uses responsive one-column layout at 820px, anywhere-wrapping hashes,
  visible keyboard focus, and reduced-motion behavior. Focused C5.2 gate:
  127 tests / 1,271 assertions. Final no-key Engineer gate: 377 tests / 2,573
  assertions across 37 files; gateway: 334 tests / 3,159 assertions across 23
  files; web library: 397 tests / 1,107 assertions across 42 files. Full
  workspace typecheck and `git diff --check` passed; paid provider calls: zero.

### Day 1E Pair C5.2 repair round 1 — run-scoped stale approval state

- Independent audit found that a global stale flag could disable a newly opened
  run after a conflict on a prior run. Staleness is now stored by run ID and
  affects only that exact active run. Successful full refresh/open and run exit
  clear it after identity checks; lightweight live-summary refresh cannot clear
  it and accidentally re-enable stale controls.
- The regression matrix proves run A stale, run B unaffected, and a successful
  full-open reset. Independent repair re-audit: GO, 134 tests / 1,292 assertions
  across candidate truth, live UI, approval CAS, SSE, gateway manager, and
  handler suites. Final focused repair gate: 129 tests / 1,280 assertions.

### Day 1E Pair C5.2 repair round 2 — accessible machine identity and rendered UI evidence

- The machine-verification card now labels and displays the authoritative
  checkpoint hash rather than presenting the checkpoint row as its internal ID.
  The compact checkpoint ID remains a separate secondary field. Checkpoint
  hash, result commit, and environment digest remain visually compact while
  exposing their complete values through keyboard-focusable code elements,
  full accessible names, and visible focus treatment.
- The candidate border now consumes the centrally defined semantic
  `--color-green` design token; the undefined `--c-success` reference is gone.
  Long identifiers wrap, the three-column desktop grid collapses at 820px, and
  the Engineer reduced-motion rule remains effective.
- Candidate and approval controls were extracted into rendered, testable React
  components. React server rendering plus Bun's HTML rewriter proves identifier
  focus order and accessible names, native disabled approval controls, the
  polite candidate-change live region, pending action labels, and the exact
  checkpoint-hash row. Deterministic CSS contract tests cover responsive
  columns, wrapping, focus, motion, and token resolution; the lack of a layout
  engine is documented and browser geometry remains a live-audit responsibility.
- Focused rendered/state gate: 20 tests / 85 assertions across verification UI,
  candidate truth, and lifecycle suites. Final no-key Engineer gate: 377 tests /
  2,573 assertions across 37 files; gateway: 334 tests / 3,159 assertions across
  23 files; web library: 401 tests / 1,114 assertions across 43 files. Full
  workspace typecheck and `git diff --check` passed. Independent repair audit:
  GO, 133 focused tests passed with no blocking findings or backend regression;
  paid provider calls: zero.

### Day 1E Pair C5.2 final copy repair — machine-only publication truth

- The `REVIEW_APPROVED` fallback without approval authority no longer says
  `Review approved` or claims that human review passed. It now identifies the
  state as `Machine verified` and states explicitly that the signed candidate
  passed deterministic verification while neither human approval nor
  publication has occurred.
- The branch renders a dedicated tested notice. Rendered markup assertions prove
  the exact machine-only truth and forbid both legacy human-review claims; a
  branch-wiring assertion prevents the fallback from silently reverting to
  inline misleading copy.
- Focused web gate: 22 tests / 93 assertions. Final no-key web library gate:
  403 tests / 1,122 assertions across 43 files. Full workspace typecheck and
  `git diff --check` passed; paid provider calls: zero.

### Day 2A P1 — optional-hardening authority foundation and v23 schema

- Added strict, canonical, hash-bound contracts for advisory backlog items and
  events, hardening quotes and consent, parent-to-child run lineage, signed
  candidate-lineage attestations, and append-only publication candidate
  selections. Every creator derives deterministic content hashes and IDs from
  policy-versioned canonical JSON, rejects duplicates and invalid ordering, and
  enforces bounded money, token, duration, identifier, commit, and timestamp
  domains.
- Added the additive v23 migration with the eight frozen authority tables,
  exact foreign keys, indexes, immutability and transition triggers, relational
  projections, lineage ancestry checks, event-specific reference shapes, and
  publication-selection compare-and-swap revision rules. Approval and Git
  selection authority remains nullable in P1; when supplied, its ID/hash pair
  must be complete, exact, latest, and immutable. Mandatory publication writes
  remain deferred to the frozen P8/v24 lifecycle slice.
- Startup validation now requires the complete v14-through-v23 ancestry and
  exact v23 table, column, foreign-key, index, and trigger definitions. It
  rehydrates every v23 canonical JSON authority, compares its relational
  projection to stored columns, validates signed statement structure and
  identity, and fails closed on gaps, counterfeits, projection drift, or foreign
  key corruption. Ledger export includes every new run-scoped and lineage-linked
  v23 table without backfilling legacy rows.
- Quote creation and storage require the exact ordered actionable advisory set:
  the creator rejects audit-only input, the insertion trigger compares each
  ordinal with canonical quote JSON and its selection hash, and startup
  recomputes actionability from the checkpoint-bound frozen manifest. Consent
  compare-and-swaps the quote's parent state version against the live run, so an
  otherwise unexpired quote cannot survive a parent authority change.
- Added adversarial coverage for deterministic hashes, ordering and duplicate
  rejection, actionability, event reference shapes, quote and consent caps,
  child-lineage derivation, signature verification and tampering, publication
  selection CAS, empty and populated migration, ancestry gaps, counterfeit
  schema objects, relational JSON drift, nullable selection pairs, and durable
  export scope. A complete actionable advisory-to-mapping-to-quote-to-consent-to-
  child-lineage-to-signed-attestation-to-publication-selection graph persists
  and passes v23 revalidation, including stale-parent consent rejection. The
  legacy downgrade fixture removes selection indexes and columns before
  referenced v23 tables, matching SQLite dependency order.
- Focused P1 gate: 40 tests / 276 assertions. Final no-key Engineer gate: 386
  tests / 2,647 assertions across 38 files; gateway: 334 tests / 3,159 assertions
  across 23 files; web: 468 tests / 1,268 assertions across 51 files. Full
  workspace typecheck and `git diff --check` passed. Independent final P1
  re-audit: GO, with no genuine blockers under the frozen authority rulings;
  paid provider calls: zero.

### Day 2A P1 repair round 1 — exact authority names and signed-read boundary

- Entity IDs now hash a policy namespace plus the entity's exact dynamic hash
  field name. Seven literal vectors lock advisory, event, quote, consent,
  lineage, candidate-lineage attestation, and publication-selection identities.
  Canonical fields and v23 columns use the frozen `reasonCode`,
  `pricingVersion`, lineage-attestation, and candidate-lineage-attestation names;
  consent canonical content contains only the authorized child-run budget.
- Advisory actionability parses the frozen manifest and fails closed for every
  normalization error, absolute or traversal path, Git metadata path, empty or
  NUL path, Windows separator, or malformed manifest. Quote creation requires
  every selected advisory to be actionable and bound to the same owner,
  repository, parent run, and exact checkpoint authority.
- Consent parses and hash-verifies the supplied quote before trusting caps or
  identity, enforces quote creation through expiry chronology, and the v23
  trigger repeats chronology plus live parent-state CAS checks. Candidate
  lineage now proves that both the lineage row and parent checkpoint carry the
  exact parent ID/hash/run/owner/repository tuple; a cross-checkpoint insertion
  is rejected.
- Selection and statement hashes have exact lowercase SHA-256 SQL constraints,
  and startup rejects counterfeit v23 table definitions with either constraint
  removed. Signed lineage rows remain structurally rehydrated at startup but
  are omitted from generic trusted exports because that API has no attestor;
  no unverifiable signature is exposed as trusted evidence.
- Focused repair gate: 40 tests / 297 assertions. Final no-key Engineer gate:
  386 tests / 2,668 assertions across 38 files; gateway: 334 tests / 3,159
  assertions across 23 files; web: 468 tests / 1,268 assertions across 51 files.
  Workspace typecheck and `git diff --check` passed. Independent repair audit:
  GO on all nine frozen blockers with nullable P8 authority preserved; paid
  provider calls: zero.

### Mandatory final goal — extra-high wiring and live UI audit

- After every implementation phase is closed, Sol must perform an extra-high,
  end-to-end architecture, core-authority, and wiring audit of the completed
  Required Lane. Luna must independently challenge that result. Every blocker
  loops back through implementation and both audits until they pass.
- The final verification must traverse the complete live Engineer experience in
  the in-app browser. It must prove that every visible control reaches the
  intended authorized backend transition and that every durable backend state,
  action, recovery path, budget condition, and error has a truthful and
  reachable UI representation.
- The live audit includes refresh/restart durability, tenant isolation, legacy
  runs, no-overage enforcement, resolution and recovery flows, loading/empty/
  error states, scrolling, responsive geometry, focus and keyboard behavior,
  and browser-console/network failures. Core or UI defects found in this pass
  are repaired and re-audited before the goal can be marked complete.
- This final pass uses no paid provider calls for automated verification and
  does not authorize a commit or push.

### Day 2A P2 — deterministic advisory backlog materialization and owner lifecycle

- Verified-candidate promotion now materializes the exact advisory-only
  classification set and one hash-bound `ADVISORY_BACKLOG_MATERIALIZED` marker
  inside the existing promotion transaction. READY candidates persist the
  required zero-item marker; READY_WITH_ADVISORIES candidates persist the exact
  code-unit-ordered set. Any insertion, transition, or replay failure rolls the
  checkpoint, items, marker, state transition, and run update back together.
- Promotion preserves the pre-P2 state-event bytes and exact
  `verified-candidate:<checkpointId>` idempotency identity. Marker absence is
  exposed only as read-only `LEGACY_UNAVAILABLE`; lifecycle actions fail closed
  with materialization-required and never infer or backfill provenance. Replay
  recomputes classification, actionability, canonical item bytes, every
  relational projection, sorted IDs, set hash, and the exact marker.
- Owner-scoped advisory reads use a canonical owner/run/filter-bound base64url
  cursor, code-unit keyset ordering, strict UTC-millisecond timestamps, and
  `limit + 1`. The public view exposes only the frozen allowlist and nulls file
  locations for `AUDIT_ONLY` items. The exact page field is
  `materializationStatus`. Gateway output redacts secrets only from description
  and recommended change, returns the full stable `ENGINEER_ADVISORY_*` error
  codes and uniform owner-safe 404s, and applies `no-store` to every advisory
  URL response including origin, authentication, and OPTIONS early exits.
- Defer, dismiss, and reopen are append-only owner actions with exact
  compare-and-swap revisions and semantic idempotency. Every mutation rechecks
  owner, canonical checkpoint bytes, exact materialization, and the complete
  lifecycle inside `BEGIN IMMEDIATE`. Every lifecycle event is rehydrated with
  its strict schema, canonical JSON, recomputed hash and ID, full relational
  projection, owner/run/checkpoint/operation binding, contiguous revision, and
  legal transition. The Supervisor verifies the signed in-toto/DSSE checkpoint
  before authority is consumed; owner actions retain that attestation and
  compare statement JSON/hash, algorithm, key ID, and signature again inside
  the write transaction before materialization or event access. Event time uses
  the injected ledger clock. Unsupported future or forged supported event
  shapes fail closed on list, action, and idempotent replay.
- Acceptance coverage proves marker absence and action blocking, marker and
  action-time tampering, canonical row/JSON/checkpoint/event integrity,
  complete rollback, three-item/two-page pagination and filters, cursor
  substitution and malformed fields, two-supervisor same-revision CAS,
  `AUDIT_ONLY` location nulling, historical idempotency response semantics,
  wrong-attestor rejection, signed-authority TOCTOU mutation with zero writes,
  redaction, early-exit cache controls, route errors, and canonical parent
  checkpoint bytes.
- Final no-key gates: focused P2 178 tests / 1,694 assertions; Engineer 397 tests
  / 2,719 assertions across 38 files; gateway 339 tests / 3,214 assertions across
  23 files; web 470 tests / 1,276 assertions across 52 files. Workspace
  typecheck and `git diff --check` passed. Official independent Sol/Luna P2
  re-audit: GO with no remaining union-contract blocker; paid provider calls:
  zero.

### Day 2A P3 — deterministic optional-hardening quotes and explicit consent

- Added the model-free `deterministic-hardening-estimator-v1`. It computes the
  exact frozen N/F builder, reviewer, token, time, and call caps, and calculates
  worst-case cost only with integer `BigInt` arithmetic from the current frozen
  Terra builder and Sol reviewer model prices. Routing and pricing versions,
  exact models, nonzero prices, and the three exact sorted assumptions are
  mandatory; missing, zero, altered, or stale authority fails closed.
- Quote creation accepts only the owner request, one to twenty code-unit-sorted
  unique advisory IDs, the displayed parent state version, and an idempotency
  key. Before and again inside `BEGIN IMMEDIATE`, it binds the exact signed
  promoted checkpoint, current owner/run/repository/state version, complete P2
  materialization, and only OPEN ACTIONABLE advisories. Ordered mappings, the
  canonical quote, and a new immutable v24 owner/key request-idempotency
  authority are inserted atomically. Exact replay returns the same quote;
  semantic key reuse conflicts; quote creation writes no advisory lifecycle
  event and starts no work.
- The additive v24 migration contains only the dedicated quote-request binding,
  its run export index, exact quote/owner/time projection trigger, and immutable
  update/delete triggers. Startup validates exact v24 table, index, and trigger
  SQL plus complete v14-through-v24 ancestry. Rehydration independently checks
  canonical request JSON, recomputed request hash and ID, all relational
  projections, exact quote JSON/hash/ID/columns, and every ordinal mapping.
- Owner quote reads revalidate signed parent authority without treating a
  legitimate later parent state transition as historical quote invalidation,
  plus the exact request binding, immutable mapped ACTIONABLE selection, canonical
  quote storage, and a freshly derived deterministic estimate. Expired quotes
  remain readable with status `EXPIRED`; no expired
  quote can authorize new consent. Consent accepts only the exact quote pair,
  positive budget not above all three caps, four literal acknowledgements, the
  displayed state version, and an idempotency key. Inside one write transaction
  it repeats owner, signed checkpoint, materialization, selection, quote,
  request, state, and inclusive creation/expiry checks before inserting one
  immutable consent. It creates no reservation, charge, child run, lineage, or
  lifecycle event.
- Gateway and Web expose only nested owner routes for quote creation, quote
  reading, and consent. Path/body run identity is exact where applicable;
  request bodies are strict, public quote output is an explicit allowlist,
  ownership failures are uniform 404s, stable `ENGINEER_HARDENING_*` responses
  redact internals, and `Cache-Control: no-store` covers success, route errors,
  authentication, origin rejection, and OPTIONS.
- Adversarial acceptance proves exact formulas and price failure, strict body
  shapes, empty/duplicate/over-limit/non-actionable selections, deferred and
  audit-only rejection, foreign ownership, stale state, over-cap consent,
  quote/request/attestation tampering, signed-authority TOCTOU rollback, exact
  replay and conflicting replay, expiry visibility and denial, zero side
  effects, exact inclusive expiry-boundary consent, and two-supervisor
  convergence on one request and quote. Focused P3 gate: 227 tests / 2,037
  assertions. The post-audit repair gate additionally proves byte-equal quote
  and consent replay after advisory deferral and a later run-state transition,
  rejects a coherently rehashed quote with altered estimator caps, and maps
  over-cap consent to a redacted stable HTTP 409. Final no-key suites: Engineer
  410 tests / 2,789 assertions; gateway 344 tests / 3,267 assertions; web 472 tests / 1,279
  assertions. Full workspace typecheck and `git diff --check` passed; paid
  provider calls: zero. The official follow-up audit found and repaired one
  remaining historical-read defect: a legitimate later parent state transition
  no longer invalidates immutable quote GET, while new consent still requires
  the current displayed state version. Exact prior quote and consent operations
  continue to replay from immutable authority. Final independent narrow
  Sol/Luna re-audit: GO, with no remaining P3 blocker.

### Day 2A P4 — atomic optional-hardening child creation

- Added the strict owner-scoped child command at
  `POST /v1/engineer/runs/:parentRunId/hardening/children`. Its body is exactly
  the signed consent ID/hash pair. The Gateway rejects every extra or malformed
  field, derives owner authority from authentication, returns only the frozen
  strict `{child,lineage}` view, uses uniform owner-safe not-found behavior and stable hardening
  errors, and applies `Cache-Control: no-store` on success and every early exit.
  The public lineage is an explicit no-extras allowlist; it omits owner,
  repository, advisory text, request JSON, DSSE, actor, database, provider, and
  budget-revision internals. Gateway and Web runtime schemas reject missing
  lineage authority and leaked extra fields. First creation and exact replay
  return the same status and byte-equivalent envelope.
- Child creation verifies the signed promoted checkpoint before the write lock
  and revalidates the exact signed bytes inside one `BEGIN IMMEDIATE`
  transaction. It rehydrates the complete immutable consent, quote, quote
  request, ordered advisory mappings, deterministic estimate, checkpoint,
  repository/base identity, chronology, caps, and acknowledgements. A consent
  accepted within the quote window remains valid after quote expiry. First
  creation additionally requires complete P2 materialization and the exact
  selected OPEN ACTIONABLE set; exact replay may ignore later mutable advisory
  or parent-state changes only after strict child, budget, lineage, and durable
  authority rehydration.
- The deterministic child ID, root ancestry, canonical durable-only request,
  exact repository inheritance, risk floor, and human gate are bound into the
  child authority. Original and normalized requests contain the same canonical
  bytes; no manifest is fabricated. The child begins at `REQUEST_RECEIVED`,
  state version zero. Its budget equals the consent caps and lifetime caps,
  starts at revision zero, and has zero used, reserved, and ambiguous usage.
  The transaction inserts child and budget before the exact hash-bound
  `EngineerRunLineage`; any boundary failure rolls back all three.
- P4 performs no planning, model, sandbox, workspace, tool, execution,
  publication, approval, Git, advisory-selection/start, parent mutation, or
  parent-budget transfer. One nonterminal child per parent checkpoint is
  enforced. Root cycles, ambiguous ancestry, deterministic-ID collisions,
  foreign ownership, closed selections, signed-authority drift, and corrupted
  replay all fail closed.
- The minimal v25 migration changes only the `run_budgets.revision` lower bound
  to permit the required zero revision. It preserves populated v24 rows and
  verifies complete v14-through-v25 ancestry, the exact rebuilt table shape,
  prior indexes, triggers, and foreign keys, and rejects counterfeit variants.
- Adversarial evidence covers first creation and pristine replay, parent byte
  identity, zero workflow side effects, exact expiry-boundary consent consumed
  later, two-supervisor convergence, active-child exclusion and terminal
  replacement, deterministic collision, insertion rollback at budget and
  lineage boundaries, parent base drift, every upstream authority tamper, and
  lineage/child-request/budget/state replay corruption. Final no-key gates:
  focused P4 236 tests / 2,128 assertions; Engineer 417 tests / 2,860
  assertions; Gateway 347 tests / 3,293 assertions; Web 474 tests / 1,283
  assertions. All three TypeScript checks and `git diff --check` passed; paid
  provider calls: zero.

### Day 2A P5 — seeded optional-hardening execution and v2 checkpoint

- Added the strict nested child-start command with exact state-version,
  lineage-pair, and idempotency authority. Start performs no planning: it
  deterministically freezes one advisory-bound manifest with zero planner and
  repair allowances, one Terra Builder, one Sol Reviewer, inherited scope and
  executable tests, and the consent-capped child-only budget.
- A fresh cold/offline sandbox is materialized from the exact parent base and
  verified parent candidate diff. The signed `HARDENING_SEED_VERIFIED`
  attestation binds operation, lineage, parent checkpoint, base/result/tree/diff,
  image, environment, and dependency identities. Durable authority is committed
  before manifest progression; sandbox persistence follows the frozen manifest,
  so restart recovery reconstructs the exact seed without duplicate model or
  tool calls. The Gateway recovers partial starts before ordinary queued work.
- The additive v26 start/seed authority and v27 checkpoint migration are strict,
  immutable, ancestry-checked, and projection/FK validated. Ordinary v1
  checkpoints remain byte-exact. Hardening completion creates a separate signed
  v2 checkpoint with mandatory parent-checkpoint, lineage, and seed ID/hash
  pairs, atomically records `HARDENING_VERIFIED`, and stops at
  `HUMAN_REVIEW_REQUIRED`; it creates no approval, publication, candidate-lineage
  attestation, or Git operation. Non-ready outcomes emit an idempotent
  `HARDENING_STOPPED` and never enter the normal repair loop.
- Owner-safe snapshots dispatch child checkpoint reads through strict v2
  rehydration while retaining the existing minimal public summary. Evidence
  export includes immutable start and seed records. Repeated start/recovery and
  promotion requests replay exact durable authority without duplicated lifecycle
  events, sandboxes, provider calls, or parent mutation.
- Adversarial evidence covers strict HTTP shapes, late-state replay, cold seed
  reconstruction, diff/environment tampering and cleanup, planner zero,
  Builder/Reviewer/model-call 0/1/1 limits, STOPPED idempotency, restart recovery,
  v1/v2 schema and relational tampering, zero-repair classification routing, and
  one real single-database production-authority parent-to-child v2 promotion.
  That final test exposed and repaired a SQL arity defect in the previously
  unexecuted `HARDENING_VERIFIED` insert. Stable gates: classified ledger 71/71
  (509 assertions), verification 44/44 (436), execution 49/49 (247), Gateway
  manager 39/39 (156), Gateway handler 86/86 (1,190), checkpoint/schema focused
  18/18 (156). Forced Engineer/Gateway TypeScript builds and `git diff --check`
  passed; paid provider calls: zero. No commit or push was performed.

#### P5 structural hardening — v28 pre-side-effect fencing and paid-call slots

- Added an additive exact v28 authority that durably records `PREPARING` before
  any cold seed/workspace side effect. The immutable intent binds owner, full
  ancestry, parent checkpoint, lineage, quote, consent, and intended start
  operation. A bounded lease carries a random fence token and monotonic
  generation; only an expired lease may be stolen, and a stale worker cannot
  finalize the operation/signed-seed/sandbox triple.
- Added fail-closed pre-dispatch paid-call slots with the complete frozen graph:
  Builder/Terra one, Reviewer/Sol one, Planner/Tester/Security/repair zero.
  `CLAIMED`, `COMPLETED`, `FAILED`, and `AMBIGUOUS` all consume the single slot;
  exact replay never grants another transport dispatch.
- Exact schema, index, trigger, projection, ancestry, FK, counterfeit recovery,
  two-connection ownership, crash/lease-steal, stale-fence, replay, role/tier,
  and ambiguous-consumption coverage passed. Focused no-provider gate: 115
  tests / 848 assertions; targeted diff check passed. Workflow integration must
  acquire the start claim before seeding, finalize it after the three durable
  authorities exist, and claim a paid slot before each provider transport.
- Luna's first re-audit correctly rejected a late-only fence: generation one
  could previously persist start/seed authority before a generation-two steal
  made finalization fail. The repaired boundary now places the current,
  unexpired claim CAS; operation and seed rows; deterministic manifest and
  transitions; advisory events; sandbox and checkpoint artifact rows; and
  claim finalization in one `BEGIN IMMEDIATE`. Any stale token or callback
  failure rolls back every row. The execution manager publishes its pending
  sandbox in memory only after that database transaction succeeds.
- Sol's recovery re-audit also found that a live PREPARING lease at boot was
  omitted until another restart. Recovery now enumerates all owner-safe durable
  PREPARING claims, deduplicates one in-process recovery promise per child, and
  schedules it at the persisted lease expiry. Repeated boot recovery calls do
  not duplicate work. Restart coverage exercises REQUEST_RECEIVED, PLAN_FROZEN,
  and QUEUED, while the real-SQLite stale-worker interleaving proves the losing
  generation creates zero operation, seed, manifest, transition, advisory,
  sandbox, or checkpoint rows and generation two alone finalizes.
- Post-repair no-provider gates: 204 tests / 1,302 assertions across schema,
  ledger, execution, fencing-contract, and Gateway recovery suites; Engineer
  and Gateway TypeScript checks and repository-wide `git diff --check` passed.

### Day 2B P6 — hard child budget, no-runaway authority (in progress)

- Sol froze an unreleased v2 hardening-quote amendment before the v29 budget
  schema ships. It preserves all v1 quote bytes and treats OpenAI prompt
  caching only as a cost optimization: it never increases signed authority,
  reduces token or TPM accounting, grants a retry, or permits a top-up.
- The cache contract is pinned to the official OpenAI Prompt Caching guide
  verified on 2026-07-18
  (`https://developers.openai.com/api/docs/guides/prompt-caching`): exact-prefix
  eligibility begins at 1,024 tokens; static instructions and tool schemas
  precede dynamic input; GPT-5.6 requests provide a stable `prompt_cache_key`;
  one explicit breakpoint uses `prompt_cache_options.mode="explicit"` with
  the only supported explicit TTL, `30m`; and v1 uses one stable
  tenant/role/model/policy key. The documented approximate
  15-requests-per-minute routing-key guidance affects hit rate only; future
  measured sharding requires a new frozen policy. A hit is never assumed or
  required for correctness.
- Pricing is pinned to the official GPT-5.6 Terra and Sol model pages verified
  on the same date. Terra input/cache-hit/output rates are $2.50/$0.25/$15.00
  per million tokens and Sol rates are $5.00/$0.50/$30.00. The guide specifies
  a 1.25x cache-write charge for GPT-5.6-class models, so Terra/Sol cache-write
  liability is $3.125/$6.25 per million input tokens. Provider-reported
  `cached_tokens` and `cache_write_tokens` are authenticated separately;
  prompt caching does not reduce TPM consumption or guarantee identical model
  output.
- Eligibility is an explicit acceptance gate, not an assumption. The official
  minimum is 1,024 rendered prefix tokens. Meaningful stable role policy—not
  filler—now places the exact Builder and Reviewer static layouts at 1,344 and
  1,304 offline o200k tokens, and a pinned no-provider regression requires a
  conservative minimum of 1,200. Canonical layout hashes and key vectors change
  with any policy or tool-schema drift.
- The v2 deterministic role caps remain one Terra Builder and one Sol Reviewer,
  with zero Planner, repair, Tester, or Security calls. Its worst-case quote
  assumes every input token is a GPT-5.6 cache write at 1.25 times uncached
  input pricing. Frozen quote goldens are 746,875 microusd for one advisory and
  one file, 753,125 microusd for two advisories and one file, and 825,000
  microusd for the maximum selection. Cached and cache-write tokens remain
  subsets of the role input caps.
- Builder and Reviewer must use canonical static-prefix-first requests, exactly
  one explicit 30-minute cache breakpoint, `store:false`, privacy-safe
  HMAC-scoped cache keys, and one default tenant/role/model/policy routing key.
  Dynamic run,
  repository, manifest, diff, evidence, and advisory data follows the cache
  boundary and is excluded from the provider key.
- Sol rejected unconditional four-way per-child sharding because it makes a
  low-volume tenant warm four independent caches. The unreleased policy now
  uses one stable tenant/role/model/policy/prefix key by default. OpenAI's
  approximate 15-RPM-per-key guidance affects hit rate only; future sharding
  requires durable measured traffic and a new frozen policy, never an ad-hoc
  child identifier in the v1 key.
- Before provider transport construction, v29 must atomically reserve the full
  cache-write liability under the current main SQLite execution fence. A
  settlement may reduce that liability only from a trusted provider artifact
  containing explicit safe-integer total-input, cached-input,
  cache-write-input, and output counts. Missing, malformed, overlapping, or
  over-bound usage remains worst-case ambiguous, consumes the paid slot, stops
  the child, and cannot retry.
- Work remains open until the strict v1/v2 quote union and sizing authority,
  v29 input caps and cache reservation fields, authenticated reconciliation,
  Reviewer request layout, concurrency/crash boundaries, complete no-provider
  test gates, and independent Luna and Sol audits all pass. No paid provider
  calls, commit, or push are authorized for this phase.
- Sol's first cache-amendment implementation review rejected the partial P6
  integration. It reproduced a fresh-v2 quote SQL arity failure, found that
  legacy v1 quotes could still authorize new paid children, identified partial
  database row-to-canonical-JSON projections, and showed that Builder and
  Reviewer dynamic content was still inside unkeyed cache prefixes. These are
  active repair items, not accepted behavior; P6 remains open.
- Luna's independent interim gate was also deliberately red while the repair
  was in progress. It added role-specific input-cap exact/+1 enforcement,
  trusted-artifact equality for all I/C/W/O usage fields, and independent
  cache MISS/HIT/WRITE/MIXED settlement arithmetic to the mandatory matrix.
  A cached role may settle below its worst-case reservation, but it can never
  borrow the other role's allowance or trust caller-supplied cache counts that
  diverge from the retained provider response.
- The frozen no-provider P6 matrix now has seven gates: legacy-v1 read/replay
  with zero-write denial of new authority; v2 quote/sizing SQL and tamper
  invariants; canonical cache prefix, HMAC privacy, breakpoint, and shard
  vectors; pre-transport role-cap, fence, and concurrency reservation; exact
  safe I/C/W/O settlement and ambiguity; durable remaining-wall-clock,
  tool/mutation/command/no-progress/cancel enforcement; and parent immutability
  with one Terra/one Sol maximum and no repair, top-up, or resume. The repaired
  historical migration gate independently passed 39 tests / 296 assertions
  with all provider keys unset.
- The first D/E reservation-and-reconciliation implementation passed its
  focused happy-path gates, but both Luna and Sol rejected pair closure. They
  found subset-only reservation replay, missing strict at-rest rehydration,
  incomplete model-call tuple/cache binding, direct-SQL settlement forgery,
  a legacy public slot-claim bypass, arbitrary rather than production-layout
  cache descriptors, and missing provider-backed HIT/WRITE/MIXED and artifact
  mismatch vectors. Terra paused later work to repair this pair; the earlier
  green counts are evidence of partial behavior only and are not a P6 pass.
- D/E is now closed after the repair cycle. The ledger reconstructs every
  reservation and terminal reconciliation from the full canonical row,
  authenticates provider artifact bytes and exact I/C/W/O usage, validates the
  bound model-call route/prompt/schema/status/retry/cache/reference tuple, and
  normalizes unverifiable provider outcomes to one terminal ambiguous
  liability. Direct SQL missing-key, wrong-null, hash, model-call, cache, and
  reference tampering fails closed. Duplicate reservation delivery cannot
  construct Builder or Reviewer transport, and no public hardening slot bypass
  remains. The independent no-provider D/E gate passed 226 tests / 1,730
  assertions plus repository TypeScript checks; no provider key was used.
- Sol's subsequent crash-boundary audit reopened D/E with one P0. A process
  death after reservation commit could strand `RESERVED`/`CLAIMED` authority;
  a replacement fence could neither prove the provider request unsent nor
  reconcile it without reusing stale reservation ownership. P6 therefore
  remains open until a monotonic durable dispatch protocol distinguishes
  `RESERVED_UNSENT`, `DISPATCHING`, and `RESPONSE_RECORDED`, permits only proven
  unsent voiding, conservatively consumes uncertain delivery, recovers exact
  retained responses without another provider call, and passes crash/race
  matrices for both roles.

#### P6 crash recovery, cancellation, and terminal finalization repair cycle

- The monotonic paid-call lifecycle is now integrated for both Builder and
  Reviewer. A reservation is durably `RESERVED_UNSENT` before transport
  construction, becomes `DISPATCHING` at the managed send boundary, records an
  authenticated response before settlement, and can never issue another send
  after dispatch becomes ambiguous. Proven-unsent work is voided; an uncertain
  dispatch consumes the full reserved liability; an exact retained response is
  reconciled without a provider call. The paid-call slot remains single-use in
  every terminal outcome.
- Cross-database recovery now holds the worker-lease `BEGIN IMMEDIATE` fence
  across the synchronous Engineer-ledger recovery transaction, with a fixed
  worker-to-Engineer lock order. Terminal recovery covers cancellation, failure,
  timeout, budget exhaustion, and the other terminal states without allowing a
  stale recovery worker to mutate authority. The v30 forward migration is
  additive, ancestry checked, and literal-shape validated.
- Cancellation is now durable across process restart. The owner records the
  cancellation intent and artifact atomically, claims a separate run lease for
  cleanup ownership, revokes paid-call authority, reconciles any open paid-call
  lifecycle before generic agent finalization, and performs the final terminal
  compare-and-swap under the active lease. The Gateway, rather than each
  `EngineerRunManager`, owns the periodic convergence timer and drains it before
  shutdown. Content-addressed loser cleanup deletes only unreferenced files and
  preserves the first-cause error.
- Paid-call finalization is an explicit durable claim/apply authority. The
  consumer claims, validates the exact successor, and applies in one Engineer
  transaction so any validation failure rolls the claim back to `PENDING` with
  generation zero. Builder validation now authenticates its result and provider
  artifacts, the settled model-call identity and usage, and the single
  `FAST_CHECKS` transition. Reviewer validation remains isolated and bound to
  its raw response, classification, model call, and provider artifact.
- Luna's focused provider-artifact substitution and model-routing tamper pass is
  green (88 tests, 891 assertions), and the broader last stable no-provider
  matrix was green: Engineer 474 tests / 3,530 assertions; Gateway Engineer and
  handler 132 tests / 1,400 assertions; Web Engineer 58 tests / 207 assertions;
  all three TypeScript checks and `git diff --check` passed. These are interim
  regression results, not P6 release evidence. No paid provider, publication,
  remote Git, commit, or push operation occurred.
- Sol's deeper release audit found one remaining P1: the finalization consumer
  still rehydrates only a projection of the terminal reservation, route, and
  model references. P6 remains open until consumption reuses the complete strict
  reservation and reconciliation parsers, validates exact routing cardinality
  and policy/fallback/cache/time bindings, and validates the exact ordered
  five-reference production shape for both paid roles. The production vectors
  are `[manifestHash, providerInputHash, requestHash, clientRequestId,
  providerResponseId]`; `providerInputHash` is not the distinct agent-dispatch
  hash. Any implementation that equates those values would reject valid real
  runs. Settlement/recovery idempotency hashes and recovered-outcome generation
  semantics are also part of the current adversarial ruling.
- Closure requires a table-driven direct-SQL tamper matrix covering canonical
  settlement/reconciliation cost, cache descriptors and rates, route tuple and
  cardinality, ordered references, extra model calls, successor semantics, and
  atomic claim rollback. Terra owns the repair, an independent read-only
  red-team owns the negative matrix, and Sol owns the release ruling. P7 work
  must not begin until all three agree.
- The exact five-reference, route, settlement, reconciliation, and finalization
  rehydration repairs reached an interim no-provider green checkpoint (the
  focused ledger matrix passed 81 tests / 963 assertions; the crash and review
  pair passed 20 tests / 92 assertions; package typecheck passed). Independent
  adversarial review then found two additional P1 recovery gaps, so these green
  results remain regression evidence rather than P6 release evidence.
- First, recovered `RESPONSE_RECORDED` receipts with corrupt, missing, or
  structurally invalid evidence could be charged as fully ambiguous but their
  pending finalization later tried to re-prove the failure from mutable artifact
  bytes. That stranded the finalization and made its outcome depend on whether a
  file was restored after recovery. The frozen repair records one canonical,
  hash-bound `invalidReceiptObservation` inside the immutable reconciliation in
  the same transaction as the full ambiguous charge, budget stop, terminal
  reservation transition, and pending finalization. Consumption authenticates
  that recovery-time observation; it does not require the receipt to remain
  broken. Normal and settled receipts retain strict current-byte validation.
- Second, the recovery-terminal successor did not yet prove the exact model-call
  set. Proven-unsent void recovery requires zero reservation calls; an uncertain
  dispatch requires exactly one deterministic failed recovery call; a recovered
  invalid receipt requires the exact original successful call or the explicitly
  bound deterministic failed replacement, with no additional calls. Direct-SQL
  insertion of any extra, missing, reordered, or mismatched call must reject and
  roll the finalization claim back to untouched `PENDING` authority.
- Sol narrowed the artifact-row ruling after inspecting the actual v29/v30
  foreign keys and trigger chain. A missing referenced artifact database row is
  fatal database-integrity corruption, not recoverable ambiguity: it cannot
  occur with foreign keys and `foreign_key_check` intact, and no trusted artifact
  identity remains to attest. Recovery must fail before mutation, preserve the
  reservation/budget/slot/finalization bytes, make zero redispatches, surface a
  typed `DATABASE_INTEGRITY_CORRUPTION` remediation, and stop automated retry.
  The v29/v30 trigger remains byte-immutable and P7 retains v31. Missing files
  and other corrupt bytes remain recoverable because the immutable artifact row
  still supplies the expected identity. Missing or changed model-call rows and
  model/artifact binding mismatches are fatal for the same reason: the original
  `RESPONSE_RECORDED` transition proved those durable tuples, and the restored
  trigger re-proves them during the recovery claim.
- P6 now passes only after missing files, non-regular files,
  size/hash/JSON/provider-id/usage failures, file restoration or mutation after
  observation, observation and reconciliation tampering, call-cardinality
  tampering, concurrent consumption, and exact replay all converge
  deterministically. The recoverable observation enum is closed to those seven
  file/content failures. Missing rows or durable model/artifact binding changes
  fail before claim with byte-identical liability and no redispatch; the durable
  recovery loop records one non-retryable typed failure and stops retrying that
  run. Terra is implementing that matrix; the independent red-team is holding
  its final verdict; Sol has explicitly ruled P6 `FAIL` until both gaps close.
  No paid provider calls are used for this work.
- The current post-repair no-provider checkpoint is green: the consolidated P6
  matrix passes 112 tests / 1,239 assertions across the budget contracts, crash
  lifecycle, deterministic classification, strict ledger, Gateway recovery, and
  doctor; Engineer and Gateway TypeScript checks and `git diff --check` pass.
  The crash matrix alone passes 11 tests / 185 assertions, and the Gateway plus
  doctor pair passes 4 tests / 32 assertions. Provider keys were explicitly
  absent. This remains interim evidence until the independent P6 security pass
  and final Sol release ruling both return `PASS`.
- The first independent matrix returned `PASS`, but the mandatory extra P6
  security pass and Sol release audit both held release at `FAIL` on Gateway
  recovery authority/liveness. The paid-call accounting and observation core
  passed; three sweep-level repairs remain mandatory. First, a fatal recovery
  marker must be an exact canonical record-or-replay authority. Its identifier,
  fingerprint, evidence tuple, class, reason, retryability, and run binding must
  all match; a divergent deterministic-ID collision must produce a separate
  durable fail-closed terminal instead of false-freezing or retrying forever.
- Extra Sol fixed the marker algorithm without a migration. One atomic Ledger
  operation builds a per-run canonical failure using the deterministic marker
  ID, `WORKFLOW_FAILURE`, `DATABASE_INTEGRITY_CORRUPTION`, non-retryable status,
  empty evidence, a domain-separated run fingerprint, and immutable run creation
  time. Under `BEGIN IMMEDIATE` it inserts-or-ignores, reads the raw primary-key
  row, strictly parses and byte-compares the complete record, and writes the
  exact guidance in the same transaction. Only that complete record stops later
  sweeps. Malformed, cross-run, or divergent same-ID content raises a distinct
  fatal-marker conflict and is never overwritten or silently accepted.
- Pair A reached an interim implementation checkpoint: the canonical marker
  helper, atomic Ledger/Supervisor insert-or-replay operation, exact getter,
  outstanding-work SQL probe, and in-transaction zero-work recheck are landed.
  Independent no-provider reruns pass the marker matrix (5 tests / 33
  assertions) and paid-call crash matrix (11 tests / 191 assertions), and the
  Engineer package typecheck passes. This is not Pair A acceptance: the
  independent Terra challenge found that the first same-ID collision path threw
  and rolled back with no durable explanation.
- Extra Sol therefore bound the collision path more tightly. A hostile row at
  the canonical marker ID remains byte-untouched and is never authority, but a
  separate domain-separated, run-bound conflict `FailureRecord` and distinct
  restore guidance must be inserted or exactly replayed in the same
  `BEGIN IMMEDIATE` transaction. Only after commit may the typed conflict be
  surfaced. Recovery checks this exact conflict authority before the canonical
  marker and remains stopped across restart even if the hostile row is later
  removed. If the conflict ID is itself preoccupied by divergent data, the
  bounded fallback persists exact emergency guidance, reports a separate
  authority-invalid code, performs no lease/lifecycle work, and never invents a
  recursive chain of marker IDs. Race, restart, hostile-deletion, malformed
  JSON, every-field drift, cross-run collision, atomic rollback, and dual-ID
  collision tests are required before Pair A passes.
- Independent Pair A review is presently `FAIL`. The new inner zero-work gate
  is correctly placed before recovery-fence mutation, but one existing
  cancellation/replay test still encodes the old behavior and fails because it
  expects fence generation `4`; the corrected invariant retains generation `3`
  and the complete prior fence row. The exact SQL must name finalization states
  `PENDING` and `CLAIMED` instead of relying on `status != 'APPLIED'`, even
  though the current table constraint makes them equivalent. The release matrix
  must add the full outstanding-work truth table, a pre-gate-to-inner-gate race,
  and prove zero durable mutation when work disappears before lifecycle entry.
- The same review found a paid-fence race that also blocks Pair A: lifecycle
  recovery currently defers only when an open reservation and a live paid-call
  fence coexist. A pending/claimed finalization with no open reservation could
  therefore be consumed while the paid worker still owns its execution fence.
  Recovery must return zero work whenever that exact paid-call fence is live,
  regardless of which outstanding-work category triggered the sweep, and an
  adversarial pending-finalization/live-fence test must prove no successor,
  finalization, agent, budget, or recovery-fence mutation.
- Second, prompt-cache secret absence/rotation is configuration authority loss,
  not database corruption. Reservation rehydration must surface a distinct typed
  error and remediation, the Gateway must not persist a permanent database-
  corruption marker for it, and doctor must compare compatible secret identity
  read-only. Restoring the correct secret and restarting must resume recovery;
  the system must never silently rotate a secret while open liability depends on
  it.
- Extra Sol fixed the runtime behavior: prompt-cache authority loss must not
  take the Gateway or Engineer history/UI offline. The control plane starts with
  paid-hardening cache authority unavailable; every new reservation, recovery,
  and provider boundary fails before dispatch with separate typed unavailable or
  descriptor-mismatch codes. A purpose-bound, owner-only companion identity file
  is an early guard, not sole authority. When legacy reservations exist and the
  identity file does not, every stored descriptor is recomputed read-only before
  the identity may be initialized. A missing secret is never regenerated in that
  state, and a mismatch is never overwritten. Doctor verifies permissions,
  shape, identity, and all durable reservation descriptors; restore plus restart
  clears only the exact prompt-cache guidance and resumes recovery.
- The first Pair B implementation is under adversarial review and is not yet an
  accepted authority. Descriptor validation must compare a raw reservation
  count to a `LEFT JOIN` projection; an orphan reservation may never disappear
  through an inner join and make a nonempty database look safe for secret
  bootstrap. Secret and identity reads must convert filesystem races into the
  typed unavailable/mismatch state instead of throwing Gateway startup. Atomic
  creation must avoid exposing partial bytes and durably sync the containing
  directory. The companion identity stays the frozen exact v1 purpose/key-id
  record, and any internal result containing the secret must have a separate
  redacted projection before it reaches handlers, UI, or logs.
- Pair B also requires production wiring, not only a passing helper. The
  redacted degraded-readiness projection belongs on `EngineerRunManager`; it
  must not be passed to the Verification Manager or omitted so the facade
  silently defaults to ready. Doctor and runtime must agree on the authority
  parent directory: an existing permissive, non-owner, unreadable, or
  unpublishable directory produces an actionable unavailable check and never an
  uncaught Gateway startup exception. Tests must cover a permissive/unwritable
  parent, multi-reservation late drift, missing-secret/present-identity,
  malformed identity, concurrent candidate initialization, and byte-identical
  read-only inspection.
- Extra Sol ruled that API-only degraded readiness is not sufficient for the P6
  release/user-test gate. Before release, the Engineer page minimally fetches
  the redacted readiness projection, treats fetch failure as degraded for
  optional hardening only, shows one safe inline restore/doctor/restart message,
  and disables every mutation-capable optional-hardening control before click.
  History, evidence, ordinary runs, cancellation, and unrelated controls remain
  usable. No path, secret, key/fingerprint, reservation ID, or raw error may be
  rendered. The backend `503` remains the zero-mutation authority for stale
  tabs; P9 retains ownership of the richer staged UX and accessibility polish.
- Degraded authority also gates every recovery ingress, not only new API
  actions. Optional-hardening start recovery, queued recovery, expired worker-
  lease recovery, execution cleanup recovery, and the periodic paid-call sweep
  must all leave a paid child unchanged until the original secret is restored.
  Ordinary non-hardening runs and read-only history remain available. The
  worker-watchdog test must prove that an expired optional-child lease under
  degraded authority performs no run, agent, budget, finalization, or recovery-
  fence mutation while a later ordinary run still recovers normally.
- Extra Sol closed a generic-route authority bypass. An optional-hardening child
  is a separate protocol, so readiness can never authorize generic plan, freeze,
  start, planning recovery, provider-timeout retry, model-causing human retry,
  budget top-up, or budget resume. Plan/freeze/start/retry return a stable
  hardening-generic-operation error before preflight, lease, sandbox, state, or
  provider effects; top-up/resume retain the immutable-budget "new run required"
  error. Only an exact finalized signed-start/seed/checkpoint/manifest chain may
  recover a queued child. Dedicated quote, consent, child, signed start, paid
  execution, and authenticated recovery require ready cache authority. Reads,
  history, evidence, advisory bookkeeping, reject/close, and a cancellation
  request remain available while degraded; cancellation may stay pending until
  liabilities can be authenticated, and it never replays work. Optional-child
  remote publication remains forbidden.
- Third, the ten-second sweep needs an exact outstanding-work predicate: open
  reservations, pending finalizations, or the C0 pre-reservation running-agent
  seam. Completed zero-work children must not acquire leases or advance recovery
  fences forever. Every per-run probe/lifecycle/recording exception is isolated,
  releases its lease, reports safely, and cannot starve a later healthy run.
  Collision, insertion-race, malformed-row, unknown-error, two-sweep zero-work,
  delete/rotate/restore-secret, and later-healthy-run tests are required before
  the independent and Sol audits repeat.
- P6 integration checkpoint (intermediate, not a release gate): Terra reported
  `111` focused tests passing with `0` failures and `1,262` expectations, plus
  green Engineer, Gateway, and Web typechecks. That evidence predates the latest
  publication-lane guard, signed-seed recovery, degraded-readiness UI, receipt
  same-file-descriptor, and exact-guidance CAS edits, so it is retained only as
  a memory anchor. Root independently reran the current prompt-cache authority,
  doctor, and degraded-readiness UI group: `16` tests passed with `0` failures
  and `56` expectations. The final P6 gate still requires the post-edit focused
  and provider-free regression suites, generic-route zero-mutation matrix,
  degraded/zero-outstanding recovery cases, publication defense-in-depth cases,
  hostile receipt filesystem cases, and independent plus Sol re-audits.
- Independent restart review found a release-blocking signed-seed gap in the
  newest recovery wiring. Optional children already in verification states are
  not reconstructed by the start recovery that ends at `QUEUED`; verification
  recovery presently proves only that a prompt-cache secret is present. The
  generic sandbox path can select a later schema-v1 workspace checkpoint written
  after the original schema-v2 seed-bound checkpoint, so paid verification could
  resume before the durable start operation, signed seed, parent checkpoint,
  child manifest, and current workspace checkpoint have been jointly validated.
  Every optional-child workspace checkpoint must retain the schema-v2 lineage
  and seed binding, and every verification recovery ingress must rehydrate and
  verify that complete authority before any state, artifact, agent, reservation,
  provider, or transport effect. Restart tests must prove missing, tampered, or
  v1-only authority produces exactly zero effects, while one exact authority
  resumes only its own child.
- Extra-high Sol rejected the first multiple-v2/latest-checkpoint repair. The
  schema-v2 workspace checkpoint is one immutable seed locator selected by the
  finalized start claim, sandbox ID, run/manifest, lineage and seed pairs,
  trusted producer, artifact bytes/hash/size, and exact sandbox row. Exactly one
  distinct locator is allowed; a second v2 is ambiguous, a later v1 cannot win,
  and optional execution must not append another v2 merely to show progress.
  The seed locator authenticates provenance, not later candidate bytes.
- Optional restart now requires a server-derived, read-only workspace recovery
  authority before controller or worker-lease creation. It binds owner,
  repository/base, Required Lane manifest/contract, quote/consent/lineage, one
  finalized start claim, the signed parent and seed, exact projections, the
  selected locator, current state/version, and a stage-specific content
  authority. Pre-Builder states bind actual HEAD/diff/tree/dependencies to the
  seed; `FAST_CHECKS` binds one successful Builder result, finished event, paid
  successor, and full candidate diff; later verification binds the exact
  event-selected independent checkpoint, result commit, diff, and evidence;
  classified `REVIEWING` also binds its classified-review authority. Optional
  repair states are invalid because the hardening paid graph permits zero
  automatic repair calls. `HUMAN_REVIEW_REQUIRED` never auto-resumes.
- After preflight succeeds, recovery acquires the exact run lease, revalidates
  the authority hash and state version, recovers with `resetToHead:false`, and
  verifies actual content before it may cache authority, record a recovery
  attestation, transition, execute, reserve, or call a model. Invalid preflight
  creates no lease or workflow/provider effect; invalid post-recovery content
  destroys the untrusted handle and releases the lease. Adversarial coverage
  must include v1 displacement, v2 ambiguity/tampering, signed authority drift,
  Builder/paid/event/checkpoint cardinality drift, dirty verified bytes, forged
  in-memory caches, preflight-to-lease races, recovery-attestation binding,
  cleanup, legacy ordinary-v1 compatibility, and valid `FAST_CHECKS`, security,
  and classified-review restarts with no provider calls in tests.
- Sol clarified that `SECURITY_REVIEW` is not itself proof that the independent
  checkpoint was stored. Recovery counts every raw checkpoint row before trust
  or parsing: zero rows may use exact Builder authority only when no durable
  post-checkpoint fact exists; one row is strictly validated and becomes the
  higher authority; malformed or multiple rows fail closed. Completion/resume
  events, final-scope or checkpoint-bound evidence, any Reviewer authority,
  classification, bundle, promotion, approval, or equivalent event-chain fact
  installs a monotonic `checkpointRequired` latch. Once installed, a missing
  checkpoint can never downgrade to Builder recovery. An interrupted pre-store
  pass is audit-only and a fresh deterministic verification pass is required.
  The recovery hash binds content level, raw cardinality, latch and sorted proof
  IDs, verification pass, run state/version, checkpoint identity or absence,
  and the exact Builder authority, then repeats that proof under the lease.
- Builder-stage byte authority also binds the ordered command executions named
  by the exact Builder result. Expected HEAD is the final unambiguous referenced
  command commit, or the signed seed result commit when no command ran; every
  command execution must bind the run, manifest, and environment. The complete
  Builder diff is then verified against that HEAD, so legitimate command-side
  commits survive restart without weakening the seed provenance.
- Sol also froze a monotonic three-route `REVIEWING` discriminator. An exact
  checkpoint with zero raw footprint in every Reviewer namespace is the clean
  pre-Reviewer crash window and may make the one allowed Reviewer call. Any
  agent, route, paid slot/reservation/finalization/model call, response receipt
  or artifact, session/raw output, classification, claim/bundle, or dispatch or
  failure event makes that clean route permanently unavailable; provider-free
  paid recovery runs first, then incomplete or malformed authority quarantines
  without a second Reviewer call. Exact classified authority additionally
  requires the canonical Reviewer agent/route/call/session/classification and
  paid finalization; pending accounting is applied first and an already applied
  result recovers provider-free. The route and sorted raw footprint identity are
  part of the preflight hash and are re-read under the lease. Cancellation has
  precedence over all three routes.
- 2026-07-18 root integration checkpoint: the paid-call recovery regression
  suite remains green (`7 pass`, `38 expect`), `git diff --check` is clean, and
  the Engineer package type-checks. The first independent Gateway type-check
  correctly rejected incomplete public wiring: the two typed workspace/Reviewer
  recovery errors were not yet exported from `@zintus/engineer`, and the public
  `EngineerSupervisor` type did not yet expose the durable quarantine method.
  The writer then exported the typed errors and public Supervisor API; root
  reran both Engineer and Gateway type-checks and both passed. P6 nevertheless
  remains open until direct provider-free adversarial tests cover
  prepare/activate/resume, lease and
  authority races, raw checkpoint cardinality/latches, all three Reviewer
  routes, duplicate recovery idempotency, cold-start `QUEUED` recovery, typed
  quarantine, cancellation precedence, and untrusted-sandbox cleanup before a
  Sol release audit can begin.
- The concurrent read-only Terra audit found a cancellation-precedence race in
  the Gateway's pre-lease recovery failure path: a failed preparation followed
  by a fresh state read could quarantine a run that had meanwhile entered
  `CANCELLATION_PENDING`. Quarantine must compare-and-swap the original recovery
  snapshot and explicitly yield to cancellation and terminal states. The same
  audit requires raw Reviewer claim/evidence and dispatch/failure event tails in
  the R0/R1/R2 footprint, an exact v2 completion-event binding test, rejection
  of extra failed or pending Reviewer rows in R2, rejection of latch-plus-zero
  checkpoint authority in every Builder fallback state, and strict validation
  of every historical recovery-attestation row. These are open P6 release
  blockers until focused provider-free race and tamper tests pass.
- The first direct activation replay test immediately justified this gate: a
  same-lease replay compared the artifact store's exact byte digest with a
  canonical-value digest of the JSON string, so an otherwise identical replay
  could never match. The writer must use the exact stored-byte SHA-256 and the
  test must pass before attestation idempotency is accepted. The writer changed
  the comparison to the exact byte digest; the read-only Terra audit and root
  independently reran the focused provider-free test, which now passes with
  `10 expect` assertions. Root then reran the complete execution suite: `52
  pass`, `267 expect`, zero failures and no paid provider calls.
- Root's next authority pass found that Builder recovery still selected only
  the command IDs named by `BuilderResult`, permitting extra durable command
  rows, and command rows do not themselves carry the frozen manifest hash.
  Exact Builder authority must reject extra raw Builder agents, reservations,
  finalizations, and command rows and must bind every ordered command to its
  unique immutable `COMMAND_EXECUTED` manifest audit projection (or an
  equivalent immutable authority). Missing, extra, duplicate, or reordered
  command/audit evidence remains a P6 blocker.
- Root also reran the complete Gateway Engineer facade suite after dedicated
  late hardening recovery wiring landed: `47 pass`, `218 expect`, zero
  failures, with the recovery test asserting zero provider calls. This is a
  regression baseline, not a release waiver for the open race/tamper matrix.
- The read-only Terra pass then rejected an over-broad Reviewer event matcher:
  `/REVIEW|MODEL_PROVIDER/` also matched ordinary `ENTER_SECURITY_REVIEW`
  history, which would misclassify every legitimate clean pre-Reviewer R0
  restart as partial Reviewer authority and quarantine it. Reviewer event
  footprint must use a closed, exact set of Reviewer-derived dispatch/failure
  authorities, and R0 must be tested with its normal security-review history.
- The writer has since implemented the cancellation CAS guard, early-stage
  latch rejection, a closed Reviewer event set, exact raw Reviewer and Builder
  cardinalities, claim/audit footprint, strict historical attestation parsing,
  and manifest-bound ordered command audits. Both root and the audit Terra
  independently reran Engineer and Gateway type-checks successfully. The audit
  still found one Builder hash gap: `commandAuthorityHash` must bind the entire
  validated closed command plus `COMMAND_EXECUTED` audit projection, including
  timestamp/order facts, so consistent durable mutations cannot preserve the
  restart snapshot hash. The writer closed that hash/timestamp gap and the
  audit Terra confirmed it. Strict historical-attestation parsing briefly
  rejected the platform's `sha256:<64hex>` hash form; after switching back to
  the shared hash contract, the focused recovery test again passes with `10
  expect` assertions. Historical state-to-stage compatibility, exact orphaned
  Reviewer correlation, and direct R0/R1/R2/recovered-resume tests remain open.
- Activation cleanup must distinguish validation failure from lost fencing
  authority. Clearing stale local maps is always safe, but a stale worker must
  never destroy a sandbox after `assertAuthority` fails because the replacement
  worker may now own it. Destroy is required only for invalid bytes while the
  current worker still holds the exact lease; lease-loss and invalid-byte paths
  require opposing adversarial assertions (`destroy=0` versus `destroy=1`).
- R2's semantic successor verifier covers Reviewer/provider content, producers,
  and response binding, but its raw ledger file reads do not enforce the local
  artifact store's run-root and owner-controlled path checks. Recovery must
  re-read every exact referenced Reviewer/provider artifact through
  `LocalArtifactStore.read`; a swapped external path or symlink is invalid even
  when the copied bytes and digest match.
- The R2 audit also rejected `latestClassifiedReview` as sufficient authority:
  extra Reviewer sessions, classification batches, raw artifacts, findings,
  claims, or bundles could coexist with the selected row. Its footprint hash
  covered only table-kind, row ID, and count, so a same-ID content mutation
  could preserve the snapshot hash. R2 must validate one complete canonical
  Reviewer lane, reject every extra raw row, and hash strict closed normalized
  row and artifact-byte projections; arbitrary claim evidence must not survive
  as an accepted expected set. Direct extra-row and same-ID mutation tests are
  P6 release blockers.
- Cold `QUEUED` coordinator review found a false-success route: an empty signed-
  start recovery fell through to `resumeRecovered` and reported
  `AUTHORIZED_EXECUTION`, although the real execution manager silently no-ops
  without in-memory hardening authority. Fallback is valid only when
  `hasOptionalHardeningAuthority(runId)` is already true; missing or malformed
  signed-start authority must stop visibly and provider-free. The ordered
  command proof must also reject overlap (`current.startedAt` before the prior
  `finishedAt`), not merely decreasing start or finish timestamps.
- The writer added the authority predicate and provider-free coordinator tests;
  the audit Terra and root independently reran the expanded hardening-recovery
  suite at `9 pass`, `45 expect`, zero failures. Missing signed authority now
  stays paused and is never reported as executed.
- Root reran the complete Phase 3 verification suite at the same checkpoint:
  `48 pass`, `455 expect`, zero failures and no live provider transport. This
  preserves legacy and ordinary verification behavior while the missing strict
  optional-hardening restart matrix is added.
- Gateway preflight still had one uncovered rejection seam: the typed authority
  catch lived inside `.then`, so an asynchronous rejection from
  `prepareOptionalHardeningStartForOwner` bypassed quarantine entirely. The
  full awaited preparation-plus-snapshot chain must share the same original-
  version cancellation-precedence guard and provider-free typed outcome.
- The writer closed that seam and expanded both direct recovery tests. Root and
  the audit Terra independently verified `14 expect` assertions for async
  preflight failure plus cancellation precedence and `14 expect` assertions for
  malformed history, same-lease replay, stale-lease no-destroy, and live-lease
  invalid-byte destroy behavior. Both focused tests are provider-free and pass.
- Durable authority helpers must also normalize malformed JSON/schema/artifact
  validation into the typed workspace/Reviewer quarantine boundary; raw
  `SyntaxError`, Zod, or content errors must not strand the run. The first R2
  exact-table repair overcorrected by requiring zero claims and bundles, which
  rejects legitimate classified crash tails. R2 must accept only the
  deterministic canonical claim prefix/set and zero-or-one exact bundle for
  the appropriate crash boundary, while rejecting all arbitrary extras.
- Sol resolved the v2 checkpoint event fork. Normal completion is the exact
  contiguous chain `H -> C`; recovered completion is `H -> O -> R -> C`, where
  `H` is the checkpoint payload's exact pre-store event head, `O` is the one
  `PHASE3_PROCESS_INTERRUPTED` transition, `R` is the one
  `INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED` transition, and `C` is the one
  `INDEPENDENT_VERIFICATION_COMPLETE` transition. The checkpoint tuple `A` is
  artifact ID, byte hash, and payload checkpoint hash. O/R/C use distinct
  deterministic idempotency keys derived from run+A+H, bind A/H in evidence,
  and have independent `0..1` cardinality. Every existing prefix is a resumable
  crash window and must be reused; sequence, state version, previous/next state,
  evidence prefix, and event bytes are contiguous and exact. Duplicate,
  foreign, interposed, timestamp-selected, or later same-reason events cannot
  substitute. Later valid Reviewer/human events after C do not change the
  selected checkpoint chain.
- Recovery-attestation generations are keyed by the exact lease triple, not by
  lease plus authority hash. The same `{leaseId, ownerId, fencingToken}` may
  have exactly one immutable record; changing its authority hash or any other
  byte is a conflict, never permission to append a second attestation.
  Lease IDs and fencing tokens are bijective, new generations require a fence
  greater than the historical maximum, and the existing append order itself
  must be strictly increasing; poisoned history such as fence 2 followed by
  fence 1 is invalid.
- The first H/O/R/C helper audit found a post-completion replay gap: an existing
  valid C still entered `verifyPass`, recreating time-sensitive `PRE_REVIEW`
  integrity and risk facts before the first Reviewer request. C must bind the
  exact complete trusted-evidence suffix and final risk authority used by the
  Reviewer input, and recovery must rehydrate or record-or-verify those facts;
  advancing the restart clock cannot change evidence IDs, risk hash, Reviewer
  input hash, or create duplicate durable rows.
- Sol froze the bridge into paid Reviewer ingress: one trusted canonical
  `HARDENING_REVIEW_INPUT_AUTHORITY` is committed atomically with C, and C binds
  its artifact ID and exact byte SHA. It binds the full ReviewerInput and input
  hash; deterministic session ID, attempt and evidence-derived timestamp;
  checkpoint, manifest, Required Lane contract and predecessor; exact evidence,
  PRE_REVIEW and risk rows/hashes; evidence-bundle hash; hashed cache descriptor;
  provider input/request hash; and its own authority hash. Every referenced row
  and artifact byte is resolved before any Sol agent, reservation, transport or
  call. An existing C without this authority is invalid and cannot be repaired
  by recomputation. Legal R0 reuses C/authority directly with no new O/R/C.
- The checkpoint's `verified` payload and every nested evidence artifact must
  be strictly parsed and byte-verified during signed preflight, before any Sol
  reservation or transport. Missing/tampered stdout, stderr, security report,
  or trusted-evidence artifacts are typed provider-free quarantine conditions,
  not post-spend generic failures.
- Independent Terra exercised the pure H/A/O/R/C chain validator directly.
  All four legal recovered prefixes (`H`, `H/O`, `H/O/R`, `H/O/R/C`) were
  accepted, while R-without-O, C after an incomplete O prefix, an interposed
  sequence gap, a forged C idempotency key, and a mixed normal/recovered
  predecessor were rejected. The core chain validator is therefore no longer
  a P6 blocker. The remaining release blockers are the transactionally atomic
  authority-plus-C write, rejection of orphan authority, exhaustive typed
  artifact-row/type/producer/hash/byte resolution before Reviewer spend, and
  direct end-to-end R0/R1/R2 restart tests. At this checkpoint Engineer
  type-checking passes; the execution suite is `51/52`, with the sole failure
  isolated to a newly hardened fixture that still supplies an invalid empty
  `verified` payload rather than the new strict schema.
- The writer introduced a Supervisor-owned outer Ledger transaction for the
  review-input authority row and C transition. Independent Terra verified Bun
  SQLite's nested transaction behavior directly: an outer failure after the
  inner transition rolls both inserts back to zero rows, while success commits
  both rows. The transaction primitive is sound. The remaining atomic-boundary
  work is exact committed-C replay, explicit orphan-authority rejection, event
  time ordering against the authority record, and durable crash/replay tests;
  non-exact replay must remain fail-closed.
- After the strict fixture repair, the complete execution suite is green at
  `52 pass`, `281 expect`; Engineer type-checking and diff validation also
  pass. This is compilation and fixture evidence only, not the P6 release gate:
  direct atomic crash/replay and real recovered-resume tests plus exhaustive
  pre-spend evidence resolution remain required.
- The atomic gate now reads the proposed authority bytes, verifies their byte
  hash, strict schema, authority hash and run/manifest/checkpoint/ReviewerInput
  bindings before C can commit. The valid-authority injected-transition
  rollback test passes with `9 expect`, proving a failed C transition leaves no
  durable authority; the ordinary optional-hardening verification test also
  passes with exactly one controlled Reviewer call and `9 expect`. Engineer
  type-checking and diff validation remain green. P6 still requires frozen
  provider-request authority (model/config, prompt/tool schema, cache descriptor,
  safety and request hashes), exhaustive evidence-reference resolution, and
  direct real recovered-resume tests before release.
- Extra-high Sol rejected raw `readFileSync(storageReference)` at the atomic C
  gate: it permits path/root/symlink ambiguity and the legacy semantic-hash
  fallback is not byte authority. The Supervisor must be configured once with
  an immutable LocalArtifactStore-root reader that enforces the owner-controlled
  regular-file boundary, exact size and `sha256Bytes`, fatal UTF-8, strict
  schema, canonical JSON bytes, and exhaustive referenced row/artifact checks.
  C bindings and its idempotency key are derived from those bytes, never trusted
  from caller projections. Exact A+C replay revalidates every byte even after
  later state advancement; one-sided, duplicate, conflicting, noncanonical,
  escaped, symlinked or time-disordered authority fails provider-free.
- The first provider-ingress refactor exposed a pre-existing mutable-array bug:
  TESTER input hashed `verified.trustedEvidence`, then PRE_REVIEW append/sort
  mutated that same array, so durable reconstruction saw a different order.
  Independent Terra isolated all 13 failures to this alias. The repair must use
  one immutable canonical TESTER snapshot and copy before Reviewer append/sort;
  the durable validator is not to be loosened. The full verification release
  target after repair is `49/49`.
- The immutable TESTER snapshot/copy repair closed all 11 adversarial-binding
  order failures. The next full verification run reached `47/49`, `456 expect`:
  the fresh durable re-read request-authority mismatch was then fixed through
  canonical provider-input serialization and its focused test passes. One
  ordinary paused-budget resume regression remains under isolation before the
  next `49/49` run. The resolver's byte checks also cannot substitute for the
  Ledger's semantic Reviewer-evidence validator; that existing no-write logic
  must be exposed and run before `startAgent`, reservation or transport, while
  retaining the post-response validation as defense in depth.
- The last regression was an authority-lane bifurcation error: ordinary v1
  budget-checkpoint recovery had been routed through optional-hardening v2
  H/O/R/C validation. Restoring the explicit optional-child branch preserved
  the legacy v1 flow. The complete verification suite is again green at
  `49 pass`, `467 expect`; the focused fresh hardening authority path also
  passes, with no validator weakening and no paid provider call during the
  recovery checks.
- R0 fault analysis found that FINAL_CHANGE_SCOPE, PRE_REVIEW integrity and the
  final risk assessment were still persisted after H but before A+C. A crash at
  any of those seams could leave duplicate/time-drifted facts; duplicate final
  scope is itself rejected by durable semantic validation and could permanently
  quarantine an otherwise resumable run. A fixed-clock probe also exposed the
  `reviewCreatedAt = max(...) + 1ms` versus immediate wall-clock C race.
- Extra-high Sol selected one atomic Reviewer-ingress bundle and rejected orphan
  adoption. The fresh path must compute pending H-bound final-scope/PRE_REVIEW
  artifacts, deterministic risk, ReviewerInput and request/evidence authority
  without Ledger mutation. One Supervisor transaction then strict-validates and
  records the pending artifact rows and audits, risk row/run projection/audit,
  authority A and transition C. Every identity and time is derived from the
  unique v2 checkpoint/H; no UUID or current-clock authority is permitted.
  Failure after any internal insert rolls the whole Ledger bundle back; files
  already placed in content-addressed storage remain non-authoritative garbage.
  Exact complete-bundle+C replay is the only replay; any partial legacy/random
  scope, PRE_REVIEW, risk, A or C footprint fails provider-free. Direct fault,
  two-Supervisor race, tamper, fixed-clock, file-put/restart and provider-zero
  tests are required before P6 release.
- Independent Terra's final pre-bundle checkpoint marks canonical v2 bytes,
  exact LocalArtifactStore reads for A/checkpoint/diff/explicit evidence,
  unique H/O/R/C derivation, caller-projection rejection, pre-C semantic gate,
  all-required-tests-PASSED admission, frozen request/cache/model/safety
  authority, post-C durable rehydrate, monotonic event validation and the
  current atomic rollback/replay target as implemented. The exactly-one-Sol
  happy target, Engineer type-check and diff validation pass. P6 is still
  blocked on expanding authority to every implicit baseline/audit/advisory/
  agent/security/Git/risk/contract dependency, replacing the pre-C scope/
  PRE_REVIEW/risk writes with Sol's atomic ingress bundle, fixed-clock safety,
  direct H/O/R/C provider-zero fault coverage, and restoring two partial-manager
  fixtures so the complete verification suite returns from `47/49` to `49/49`.
- The baseline was restored before the atomic rewrite: verification is
  `49/49` with `471 expect`, the strict restart fixture is `1/1` with
  `30 expect`, and pure checkpoint-chain tests are `2/2` with `10 expect`.
  Terra then implemented deterministic ingress identities/times, pure pending
  PRE_REVIEW preparation, pure final-risk projection and an explicit derived
  transition timestamp seam; the existing nested SQLite transaction primitives
  are sufficient, so no new database architecture is required.
- A second read-only Terra froze the fault matrix in parallel. It covers every
  atomic seam (scope, PRE_REVIEW, integrity audit, risk, semantic preflight, A,
  C), exact complete replay, two-Supervisor convergence/conflict, every invalid
  H/O/R/C subset and binding, fixed/regressing clocks, explicit and implicit
  dependency tamper, and a final real R0 with exactly one legal Reviewer call.
  Every failure asserts zero transport lookup/create and zero Reviewer paid
  footprint. The matrix also caught three must-fix details: add the semantic-
  preflight seam, recompute full dependency hashes inside the same DB snapshot,
  and use literal distinct v2 O/R/C key namespaces rather than helper-vs-helper
  self-confirmation. The old private A+C-only helper must be removed after the
  new bundle caller is wired.
- The compiled production bundle now binds exact sorted implicit authority for
  manifest, Required Lane contract, risk rows/run projection, verification/
  integrity/risk audits, security rows, Git operations, TESTER rows and every
  semantic domain artifact using strict byte reads. Supervisor recomputes both
  explicit and implicit authority inside the atomic DB snapshot; durable load
  recomputes both again before any Reviewer agent or transport. A checkpoint-
  derived logical clock makes fresh and recovered authority bytes independent
  of restart wall time, and O/R/C use independently tested literal v2 keys and
  exact derived timestamps.
- The fake rollback target was replaced with the real v2 atomic path. Independent
  Terra verified one table-driven test with `14 expect`: injected failure after
  FINAL_SCOPE, PRE_REVIEW, integrity audit, final risk, semantic preflight,
  review authority or completion leaves zero partial scope/PRE_REVIEW/risk/
  audit/A/C footprint and zero provider lookup/create. Type-check, the real
  exactly-one-Reviewer happy target, strict R2 fixture and chain targets pass.
  P6 release coverage is now narrowed to actual public H, H/O, H/O/R and H/C
  resume/provider-order tests plus explicit exact replay and two-Supervisor
  same/conflicting bundle assertions.
- The complete verification suite advanced to `52/52`, `487 expect`; direct
  manager-level H, H/O and H/O/R prefix reuse passes with `6 expect`, and H/C
  authority reuse passes with `4 expect`. Atomic replay/conflict passes with
  `5 expect`. The unreachable 108-line A+C-only helper and obsolete 93-line
  dead test were removed completely, along with their unused imports; type-check
  and diff validation remain green. Final release proof must still compose the
  signed ExecutionManager preparation/activation with a newly constructed
  VerificationManager and real recovered artifact/sandbox authority, and must
  prove semantic-row plus nested-artifact tamper after C reaches neither
  provider lookup nor any paid footprint.

### Day 2C P7 — Developer Resolution Desk (architecture frozen; implementation pending)

- P7 is an append-only resolution lane. It never rewrites a source run. A
  canonical Resolution Case binds the owner, source run/state/version,
  repository/base, manifest, Required Lane contract, optional complete candidate
  tuple, and exact durable blockers. A signed directive may only choose
  `CREATE_CORRECTED_RUN`, `CREATE_REVERIFY_RUN`, or `REJECT_AND_CLOSE`; it cannot
  waive a test/security finding, accept risk, approve, publish, top up, or
  generically resume a run.
- Corrected and reverify actions create a separate deterministic replacement run
  with explicit source/case/directive lineage. Corrected runs are required for
  code, test, review, security, or scope defects. Unchanged reverify is limited
  to deterministic transient/environment/flake cases with an exact retained
  candidate and fresh readiness proof. Both paths rerun the entire required
  verification/security lane and a fresh isolated Reviewer; no prior evidence,
  review, approval, or publication row can satisfy the replacement.
- Directive creation and application use strict owner-scoped routes, source and
  case compare-and-swap versions, a fixed TTL, canonical hashes, gateway-held
  signing authority, exact replay, conflict-safe idempotency, and atomic
  replacement linkage. The next migration is additive and immutable; its case,
  directive, event-chain, and replacement tables must preserve every v14-v30
  byte and be included in evidence export. Implementation starts only after P6
  passes its release gate.
- Luna correctly rejected the first contextual reverify proposal: transient
  verification failures ordinarily have no promoted checkpoint, and existing
  v1/v2 checkpoint rehydration requires same-run Builder rows and artifacts.
  Sol superseded option B with B-prime: the resolution case carries a separately
  named and signed **pre-verification source candidate** authority. It is not a
  ready checkpoint. It binds the successful source Builder dispatch and output
  bytes, source run/event head, manifest/contract/base, result commit/tree/diff,
  content-addressed seed artifact, test-plan hash, and exact transient proof or
  blocker snapshot after re-reading every byte and proving quiescence.
- A reverify replacement may inherit only that signed source-candidate Builder
  summary under the signed case, directive, event, and replacement chain. It
  creates exactly zero current Builder executions, dispatch claims, routes,
  model calls, artifacts, paid reservations/finalizations, or Builder liability.
  Its tests, integrity and security evidence, isolated Reviewer, classification,
  evidence bundle, and normal schema-v1 checkpoint signature are fresh. Every
  checkpoint promotion/read, approval, publication/Git preflight, retry/recovery,
  and export path must call one companion-aware verifier. Missing or invalid
  replacement authority can never fall back to legacy same-run verification.
  Optional-hardening/v2 sources are excluded from the first P7 release. A
  standalone checkpoint-v3 design remains deferred to an explicitly scoped v32.
- Corrected directives select every currently open blocker in canonical order;
  reverify selects none and is allowed only when there are no correction-
  eligible blockers. The transient reverify authority is a closed typed
  allowlist with matching durable evidence. Generic
  `PHASE3_UNEXPECTED_FAILURE`, failed required tests, security/scope/integrity
  defects, runtime-budget exhaustion, model-call limits, Builder failures, and
  unknown messages never authorize reverify. The erased underlying Phase 3
  cause is a P1 that must be made typed before reverify becomes available.
- Replacement budgets are separately and explicitly human-authorized fresh
  authorities. They neither inherit nor reset/top up source allowance. The
  directive binds exact cost, token, active-time, and pricing limits plus a
  root/case cumulative ceiling; prior replacement actual and ambiguous liability
  plus the new cap must remain within that ceiling. Changed limits conflict with
  exact replay. Source usage remains immutable.
- The frozen v31 schema has exactly four additive authority tables (cases,
  directives, events, replacements) plus their indexes and immutable projection
  triggers. Replacement creation uses a fenced `PREPARING` to `READY`/`FAILED`
  protocol so a crash cannot expose an orphan executable run. Opening a case
  freezes competing approval, publication, retry, and top-up paths for the
  source. Publication must validate the complete replacement/source authority
  chain, fresh evidence, budget, and blocker preservation. No fifth table,
  legacy-row rewrite, fake provenance, blocker subset, or direct corrected-run
  bypass is permitted in P7.
- The legacy corrected-run endpoint and planner acceptance of its directive
  artifact are direct authority/budget bypasses. New calls must return `410` or
  execute only through the exact P7 case/directive/event/replacement CAS; old
  runs remain readable. First case creation installs a ledger-wide source freeze.
  Every transition, retry/resume/top-up, hardening action, approval, publication
  selection/Git operation, worker dispatch, decision resolver, and background
  recovery path must enforce it inside its transaction and immediately before
  remote effects. Case decisions are the only allowed mutations of a frozen
  source. These seven B-prime/source-freeze/legacy-closure invariants are the P7
  architecture go/no-go gate before implementation pair 1.

### Day 3 — P6 closure work: live-void finalization repair and deterministic-extractor hardening (2026-07-19)

- The stranded `PENDING` VOID_UNSENT hardening finalization at the BEFORE_DISPATCH
  seam was a live-path/recovery-path split: the worker's catch block recorded the
  Builder agent FAILED before the provider-free recovery sweep ran, so
  orphan-finalization never emitted the `HARDENING_PAID_CALL_RECOVERY_TERMINAL`
  audit that `hasExactHardeningRecoveryTerminalSuccessor` requires, and
  finalization consumption threw. Fix: when a hardening child has a durable
  pending paid-call finalization for the current execution and recovery is
  configured, the graceful-failure path leaves the agent RUNNING so the existing
  recovery sweep terminalizes and applies atomically — no new successor type, no
  loosening of the strict validator the crash matrix guards. Non-hardening and
  no-recovery paths keep direct FAILED recording.
- The 2026-07-18 audit's two safety-control bypasses are closed. Scope: path
  extraction is now block-oriented and space/rename/copy-safe with both rename
  sources and destinations recorded; an ambiguous unquoted `diff --git` header
  with no body markers fails closed as an explicit `unparseable diff header
  (scope indeterminate)` violation that forces FAILED even under a permissive
  `**` allowlist, in the extractor shared by final-change-scope and the ledger
  recompute. Security: the Builder-controllable POSSIBLE_SECRET test-path
  downgrade is removed entirely; severity stays CRITICAL regardless of
  Builder-authored path or content markers. Table-driven regressions cover
  space paths, pure renames, quoted specials, mixed diffs, rename-source
  violations, and secret-in-test-path blocking.
- Independent Sol adversarial probes (constructed apart from the implementers'
  tests) confirmed: space-path, rename-source, copy-source, mode-change-only,
  added-space-path, diff-of-a-diff, quoted-special and fail-closed-under-`**`
  attacks are all blocked, and the test-path secret downgrade is gone. Known
  retained limitation (pre-existing, logged for the P12 adversarial suite): the
  POSSIBLE_SECRET regex is evadable by construction (e.g. string concatenation);
  the deterministic scan is one layer, not a completeness claim. Gates verified
  directly: engineer src 529/529 (4,164 expect), gateway 377/377, web 478/478,
  workspace typecheck and `git diff --check` clean.

### Day 3 — P6 release ruling (Sol): GO (2026-07-19)

- Three-party gate satisfied. Terra repair: the live-void finalization seam and
  both 2026-07-18 audit bypasses are closed at `965476e5` with gates re-verified
  directly. Independent Luna red-team (read-only, refute mode): GO with zero
  confirmed P0/P1; its two uncertifiable runtime claims were closed by direct
  trace — the hardening recovery sweep runs on a 10s non-reentrant interval
  (gateway index.ts) with an immediate startup sweep, and a FAILED
  final-change-scope attestation can never bind a verified candidate
  (ledger.ts:3941-3948 hard-throws unless trusted SYSTEM producer, byte-hash
  bound, status SUCCEEDED, zero violations; no fallback path).
- Release-proof review: both stated obligations exist and pass at HEAD —
  composed signed ExecutionManager preparation/activation into a newly
  constructed VerificationManager across H/H-O/H-O-R/H-C restart prefixes with
  exactly one Reviewer and provider 1/1 (verification.test.ts:1401), and
  post-C SEMANTIC_ROW + nested-artifact tamper rejected at provider 0/0 with
  zero reservations/finalizations/routes/slots (verification.test.ts:1436),
  corroborated by the real signed schema-v2 C with exact [BUILDER, REVIEWER]
  calls and post-C durable tamper closure (review-classification-ledger
  :3054/:3012). Mutation testing found the tamper invariant over-determined by
  at least three independent layers (strict-read fd/inode identity, exact
  byte size+sha256, durable risk compare, semantic-authority hash recompute,
  recovery verifyPass); no one- or two-line neuter flipped it red.
- Honest residuals carried to the P12 matrix, none release-blocking: (1) no
  single test composes the restart boundary with a freshly promoted real
  signed v2 checkpoint (the composed test's C is the ingress authority; real
  v2 C is proven without restart) — P12's restart-at-every-durable-stage
  journeys own this; (2) recovery tests model restart at the manager layer,
  sharing the producer's SQLite connection/store objects (durability-immaterial
  by strict re-reads, but not connection-level); (3) Luna P2s: cancellation-race
  recovery latency bounded by fence TTL + sweep cadence, the `!sawHeader`
  plain-diff fallback lacks an `@@` break (unreachable for trusted FINAL_DIFF),
  and POSSIBLE_SECRET keyword/backtick completeness (heuristic layer only; the
  reviewer-evidence binding re-runs the scanner server-side over the trusted
  diff and byte-matches semantics). P6 is released; P7 implementation may begin
  per the frozen Day 2C go/no-go invariants.

### Day 3 — P7 implementation pair 1 (2026-07-19)

- v31 landed: exactly four additive resolution tables with immutability/
  projection/fence triggers plus eight source-freeze triggers spanning run
  updates, state events, budget events, approval requests/decisions, git
  operations, builder dispatch claims and hardening lineage; ancestry and
  exact-definition startup validation extended; every v14-v30 byte preserved
  (full suite 581/0, gateway 377/0, typecheck clean — integrator-verified
  directly). Legacy corrected-run POST now returns 410 GONE with the
  resolution-cases successor. Contract supersession S1 (blocker shape,
  pricingPolicyDigest with 409 drift, wrapper convention) implemented.
- Domain and persistence authority shipped: canonical case creation installs
  the freeze in one transaction with an idempotent one-case-per-source rule;
  signed directives (gateway-held HMAC, fixed 900s TTL, case+source CAS,
  exact-byte replay, UNIQUE one-directive-per-case); fenced
  PREPARING→READY|FAILED replacement scaffold with ceiling arithmetic
  (prior actual + ambiguous + cap ≤ ceiling); reverify law with the closed
  typed allowlist, SOURCE_CLASS_EXCLUDED for optional-hardening/v2, and the
  Phase-3 typed-cause classifier delivered (not yet wired into the strict
  FailureRecordSchema erasure site — reverify honestly reports
  PHASE3_CAUSE_UNTYPED until the column lands in pair 2).
- Integrator adversarial probe (independent of implementer tests, 12 attacks):
  freeze scope, case/event/directive tamper and delete-as-freeze-lift,
  conflicting replay, expired-directive apply with zero replacement rows,
  ceiling and pricing-drift rejection, fourth-directive-type rejection, and
  frozen-source dispatch-claim rejection — all blocked. Noted P2 for route
  wiring: service-seam schema violations surface as raw ZodErrors; the
  gateway wrapper must map them to typed 400s.
- Honest pair-2 seams, unchanged from the frozen plan: executable replacement
  dispatch through the supervisor with the full lane rerun and fresh isolated
  Reviewer; deep signed B-prime candidate authority (digest is currently
  untrusted input); companion-aware lineage verifier with no legacy fallback;
  gateway HTTP routes for cases/directives/apply; typed-cause column wiring;
  evidence-export inclusion of the v31 tables.

### Day 3 — P7 pair 2 committed as WIP; four P1 integration blockers tracked (2026-07-19)

- Pair 2 delivered the lineage verifier, B-prime signed source candidate, typed
  Phase-3 cause (v32, additive nullable — migration-verified safe), and the five
  gateway routes. Gates green and Fable-reverified (engineer 615, gateway 386,
  typecheck clean). Committed as WIP because the independent cross-verifier
  confirmed no P0 (code runs, nothing safety-breaking blocks the commit) — but
  it is NO-GO FOR INTEGRATION until the four P1 blockers below are closed. These
  are the integration-ladder entry gate; the merge sequence does not start until
  they are fixed and Fable-reverified.
- P1-A (fail-open): `ResolutionLineageVerifier.verify()` returns verified:true
  for a replacement run that has NO engineer_runs row — it checks only the
  SOURCE run exists (resolution-lineage.ts:146), never the replacement run's
  existence/state. Must validate the replacement run exists and is at its own
  legitimate start/READY state.
- P1-B (unimplemented seam): `ReplacementRunFactory` has no implementation and
  is not wired in index.ts; apply creates no real engineer_runs row, so the
  "real run at start, fresh budget, ZERO inherited evidence" guarantee is
  undelivered and untestable. Must implement the factory over
  supervisor.receiveRequest sharing ONE db connection (cross-connection breaks
  the fenced atomicity), with the zero-inheritance assertion test.
- P1-C (default-path weakening): `verifySourceCandidate` trusts the
  artifacts.sha256 row when no byteReader is passed — a same-length byte rewrite
  returns ok. Reverify apply must pass a byteReader so "re-read every referenced
  durable byte" holds; make the byte re-hash non-optional on the authority path.
- P1-D (coverage): seven lineage checks (SOURCE_RUN_MISSING, CASE_HASH_MISMATCH,
  DIRECTIVE_LINK_MISMATCH, KIND_MISMATCH, CASE_MISSING, DIRECTIVE_MISSING,
  CASE_NOT_RESOLVED) have zero tests — neutering any turns no test red. Plus
  source-candidate SIGNING_AUTHORITY_UNAVAILABLE. Add targeted rejection tests.
- P2 notes carried: signature.keyId is unauthenticated (single-secret today,
  silent hole under future rotation — bind keyId into the signed content);
  recoverPreparingReplacements guards on state!=="FAILED" and would
  double-terminalize a SUCCEEDED run in a future partially-committed path (guard
  on non-terminal only); applyDirective idempotency-key is validated but dedup
  is by directive_id. Refuted (verifier holds): cross-case swap, canonical-JSON
  collision, TTL boundary, quiescence-vs-Day-2C consistency, v32 mechanical
  migration safety.
- Numbering ruling S2 (contract doc): v32 reallocated to the typed-cause column;
  checkpoint-v3 renumbered to v36 reserved. POST publications success body
  frozen as {publicationId, state}.

### Day 3 — P7 pair 3: three of four integration blockers closed (2026-07-19)

- P1-A (fail-open) CLOSED + Fable mutation-verified: verify() now re-derives the
  replacement run's own existence and state — REPLACEMENT_RUN_MISSING for a
  phantom scaffold, REPLACEMENT_RUN_INVALID_STATE for any failure-terminal
  (only COMPLETED is a legitimate finished replacement). Neutering the missing
  guard in the real tree turned exactly one lineage test red (20→19), restore
  clean — the guard is load-bearing and covered.
- P1-C CLOSED: verifySourceCandidate authority path requires a real byteReader
  (BYTE_READER_REQUIRED); a same-length byte rewrite passes a non-authority read
  but fails the authority path with OUTPUT_BYTES_DRIFT.
- P1-D CLOSED: seven lineage rejection tests + SIGNING_AUTHORITY_UNAVAILABLE,
  each neuter-verified red. Two P2s closed: keyId bound into signed content
  (swap → RECORD_TAMPERED); recoverPreparingReplacements guards on non-terminal
  state so a COMPLETED linked run is not clobbered to FAILED.
- P1-B PARTIAL: the production ResolutionReplacementRunFactory is implemented,
  tested and proven (raw inserts on the desk's own connection so run creation is
  atomic inside the fence; zero-inheritance enumerated across all evidence
  surfaces; no-op neuter turns the real-run test red). It is NOT yet wired in
  index.ts because the gateway needs a server-side CaseCreationInput derivation
  adapter (build canonical classified blockers + spend + ceiling + pricing +
  candidate from a durable terminal run) that does NOT exist anywhere. A fake
  facade was correctly refused — wrong blocker classification would authorize
  wrong correction/reverify. That derivation adapter is the sole remaining gate
  before the merge sequence. Gates: engineer 630, gateway 386, typecheck clean.

### Day 3 — P7 gateway derivation adapter: the spine is complete (2026-07-19)

- The last integration blocker (P1-B wiring) is closed. deriveCaseCreationInput
  builds the full CaseCreationInput from a durable terminal run over the desk's
  shared connection: canonical classified blockers, chain-aware spend (source +
  ancestor settled/ambiguous), root ceiling, S1 pricing digest, source-class
  exclusion, pre-verification candidate digest. ResolutionDesk is now
  constructed in index.ts on the ledger's single connection (fence atomicity
  preserved) with the owner-confined directive-signing secret and the real
  ResolutionReplacementRunFactory injected; the 5 routes run create→issue→apply
  end-to-end instead of 503, owner-scoped with cross-owner returning the safe
  not-found shape.
- Blocker classification (the safety-critical mapping) is fail-closed: every
  failure_record is BLOCKING; a security/review finding that is not provably
  LOW/INFO is BLOCKING; an unrecognized severity is BLOCKING; a terminal
  non-success run with no durable blocker gets a synthetic BLOCKING floor; only
  a durably-typed transient cause is ever transient. Fable mutation-verified the
  dangerous direction directly: widening ADVISORY_SEVERITIES to include
  MEDIUM/HIGH/CRITICAL turned three derivation tests red, restore clean — a
  security mis-downgrade cannot pass. Gates: engineer 645, gateway 391,
  typecheck + diff-check clean.
- P7 spine COMPLETE: all seven Day-2C go/no-go invariants now met in code
  (append-only cases/3 directives; separate replacement with real executable run
  + zero inheritance; CAS/TTL/signing/replay/ceiling; B-prime signed candidate
  with mandatory byte re-read on the authority path; companion lineage verifier
  gating replacement-run existence + state, no legacy fallback; corrected-selects-
  all-blockers + typed reverify allowlist with PHASE3 cause typed; four-table
  additive schema + fenced protocol + ledger-wide freeze + legacy 410). The
  integration merge sequence (P8 real-verifier swap, then P9/P10, then full
  P11/P12) is now unblocked.

### Day 3 — Integration step 1: lineage verifier wired at all authority sites (2026-07-19)

- The last P7 fail-open is closed. ResolutionLineageVerifier is now invoked at
  the three authority-granting call sites in ledger.ts via
  assertReplacementLineageAuthority: promoteVerifiedCandidate (REVIEW_APPROVED
  grant, :4163), recordApprovalRequest (:7074 — a decision cannot exist without
  a request, so this closes the whole approval path), and getPublicationEvidence
  (publication-selection preflight, :7263). A run owning a resolution_replacements
  row MUST verify (verified===true) or throw ReplacementLineageUnverifiedError;
  a non-replacement run returns immediately (ordinary path unchanged). No legacy
  same-run fallback; unavailable secret fails closed. Secret threaded via
  configureResolutionSigningSecret on the ledger's own connection, wired in
  index.ts from the gateway-held secret, never in model/sandbox.
- Fable mutation-verified the promotion gate directly: neutering the :4163 gate
  turned two lineage-gate tests red (a broken-lineage replacement run falls
  through to promotion), restore clean. Load-bearing, not decorative.
  promoteVerifiedHardeningCandidate is intentionally not gated (hardening
  children bind via engineer_run_lineage, not resolution_replacements — not
  replacement runs). Gates: engineer 656, gateway 391, typecheck + diff clean.

### Day 3 — Integration step 2: P8 publication authority live (v33) (2026-07-19)

- v33 is in the live migration chain: five publication-authority tables with
  additive+immutability idiom, version 32→33, ancestry + 29-object exact-shape
  startup validation, every v14-v32 byte preserved (forward-install on a
  populated v32 DB proven, foreign_key_check clean). PublicationAuthorityService
  (publication-authority.ts) is the real authority, bound to the ledger's real
  ResolutionLineageVerifier via createPublicationAuthorityService — callers
  supply only credentialed-effect seams, never the verifier or db.
- All four cross-verified guarantees survived integration, each RED-confirmed:
  single-use approval P0 (partial unique index uq_pub_git_operation_approval_v33
  + APPROVED→CONSUMED CAS; removing both → actuatorCalls=2 double-publish;
  Fable re-confirmed the guards are physically in the live schema at
  database-schema.ts:2869/2824), RECONCILING-not-redispatch, requester-bound
  approval, fail-closed lineage with the real verifier (broken-lineage
  P7_REPLACEMENT → StaleCandidateError). Gates: engineer 683, gateway 391,
  typecheck + diff clean.
- TRACKED SEAMS (honest, → integration steps / P12): (1) gateway HTTP routes for
  publications/approvals not wired — authority exposed at ledger layer, HTTP
  context derivation deferred; (2) LEGACY CUTOVER: publication-manager.ts
  publish()/publishFenced() still run the old git_operations flow — the new v33
  authority is the clean replacement path but the manager is not yet routed
  through it, so the :497-512 double-PR window code is unchanged. Ruling: an
  acceptable interim seam because that legacy path is already defended by
  lease-based reconcileUncertainOperation (STALE state, no remote retry), but a
  full manager reroute is a required P12 cutover slice, not silently closed.
  (3) Positive real-verifier publish path proven only with a mock=true; a
  fully-signed resolved P7 chain being publishable is unproven; (4) real
  concurrency and real GitHub actuator injected as fakes.

### Day 3 — Integration step 3: P10 tenancy/RBAC live (v34) (2026-07-19)

- v34 is in the live chain: org_id NOT NULL additively on all 71 tenant-owned
  tables (extended to cover the P7 v31 resolution tables and P8 v33 publication
  tables, not just the v30-base draft set), single-tenant DEFAULT org backfill,
  3 authority tables (orgs/org_memberships/non_human_actors) with immutability
  triggers + sponsor CHECKs, version 33→34, every v14-v33 byte preserved
  (forward-install on a populated v33 DB verified, foreign_key_check clean). The
  delicate part — SQLite ALTER ADD COLUMN rewrites stored table sql — was
  handled with a single-source column-DDL list + shared tolerances so ~13
  historical shape validators still match pristine bytes minus exactly the v34
  columns. Tenant-scoped DAL + 7-role deny-by-default matrix + non-human actor
  identity ported live; 5 highest-traffic ledger.ts sites org-scoped alongside
  the existing owner predicate (behavior-preserving today, multi-tenant-ready).
- Fable mutation-verified cross-tenant isolation directly: stripping the org_id
  predicate from the DAL run-fetch turned three isolation tests red (tenant A
  sees tenant B's run), restore clean. Load-bearing. Gates: engineer 720,
  gateway 391, typecheck + diff clean.
- Integration-surfaced regression found + fixed: exportRunRecords SELECT * leaked
  v34 columns into content-integrity/attestation hashes (broke ~7 verification
  tests); stripped tenancy annotations at the exportRunRecordPage attestation
  chokepoint (operational metadata, not attested run content; keeps pre-v34
  attestations valid). This is exactly the class of bug parallel-lane integration
  banks for P12 — surfaced and closed at merge.
- TRACKED SEAMS (honest, → later steps / P12): gateway per-request identity→org
  derivation not closed (DAL uses the single default org; multi-tenant-ready but
  single-tenant-today); resolution_cases isolation is column-enforced + in the
  tripwire but not exercised through a DAL method (no case query on the DAL yet);
  org_id→orgs(id) referential integrity is DAL-enforced not a DB FK (SQLite
  additive limitation); ~140ms one-time migrate cost from 90 additive ALTERs.

### Day 3 — Integration step 4: P11 attestation + audit export live (2026-07-19)

- Attestation GENERATION is live and sourced from real durable records:
  emitPromotionProvenanceAttestation builds+signs a DSSE in-toto statement whose
  subject is the verified-candidate digest and whose predicate pulls contract/
  commit/test/security/scope digests + requester from verified_candidate_
  checkpoints, roles from agent_executions, budget from run_budgets, and P7
  replacement lineage from resolution_replacements⋈resolution_cases (present iff
  the run owns a replacement row). Audit export is live and org-scoped through
  the P10 DAL (readRunAuditEntries/exportRunAuditChain, every query AND org_id=?)
  with redaction + per-page checksums. Independent offline verifier accepts a
  real attestation and rejects tampered predicate / wrong subject / missing
  replacement lineage / approver==requester. Gates: engineer 768, gateway 391,
  typecheck + diff clean.
- Reconciliation bug fixed: the ported code bound isReplacement to
  checkpoint.schemaVersion===2, which is the HARDENING lineage — disjoint from
  P7. A P7 replacement emits an ordinary v1 checkpoint; isReplacement is now a
  promotion-context flag cross-bound only to P7-lineage presence.
- Fable mutation-verified both load-bearing gates: making the budget read ignore
  the row failed the real-sourced-fields test; dropping org_id from the audit
  events read failed the cross-tenant smuggled-row test; both restore clean.
- ARCHITECTURAL CORRECTION (agent, accepted): the attestation auto-call-site is
  decideApproval (the APPROVE path — the only point a distinct human approver
  bound to the exact subject exists), NOT promoteVerifiedCandidate as the task
  assumed. approverUserId + resultTreeHash are caller-supplied seams today (no
  distinct approver exists at REVIEW_APPROVED; result tree hash not durably
  recorded for the verified candidate); publicationReceipt is honestly null
  until a downstream publish reaches RECEIPTED.
- OPEN SEAM (→ remaining work / P12): v35 attestation-storage table + the
  auto-emit call inside decideApproval are deliberately NOT done — a 34→35
  head-version bump breaks ~16 version assertions + needs promotion-path surgery,
  too risky to leave MAIN red under budget. Generation is a real tested library
  call; persistence + call-site wiring is the tracked seam.
