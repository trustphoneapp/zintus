# R2 Frozen Contract — Publication Authority (P8 + v35 attestation + audit export)

Status: FROZEN by R2 on branch `codex/engineer-actual-localhost`.
Purpose: R3 (dispatch / reconciliation) and R4 (tenant / migration / attestation
export) build against these interfaces in parallel. The **code is the single
source of truth** — every shape below cites its authoritative TypeScript type +
Zod schema (or durable DDL) by `file:line`. R3 codes against these interfaces;
R4 implements their durable enforcement. Neither may unilaterally change an
invariant marked **INVARIANT** below; a change requires re-freezing this doc.

All authority is **server-derived**. The browser references a candidate only by
opaque `checkpointId` and an approval only by opaque `approvalId`; the gateway
facade derives every other field from durable rows keyed by the server-owned
principal. See `apps/gateway/src/engineer-publication-facade.ts` (R2 fix) and
`CandidateNotFoundError` at `apps/gateway/src/engineer-publication-facade.ts:88`
(the single not-found shape — no ownership oracle).

## 0. Authoritative-lane ruling (Fable, orchestrator)

**INVARIANT (authoritative lane):** The **P8 `PublicationAuthorityService`**
(candidate → approval → publication, with single-use approvals + reconciliation)
is the **authoritative** publication lane. The legacy
`EngineerPublicationManager` (git-operations model, currently wired into the run
flow) is **superseded**; R3 bridges the primary UI + run flow onto the P8 lane
and retires the legacy path (or reduces it to a thin adapter that delegates to
P8). No new code may build on the legacy manager. R3 owns the cutover; until it
lands, the legacy path stays intact but frozen (no new features). Rationale: the
P8 lane is the only one carrying the audited single-use-approval and
reconciliation-not-redispatch guarantees; two live publication systems is itself
a release blocker.

---

## 1. Organization + repository ownership (durable rows)

Authoritative DDL: `packages/engineer/src/database-schema.ts`
- Default single-tenant org id: `ENGINEER_DEFAULT_ORG_ID` — `database-schema.ts:2955`
- Tenant `org_id` column (NOT NULL, DEFAULTs to the single-tenant org):
  `V34_ORG_ID_COLUMN_DDL` — `database-schema.ts:3104`
- Run ownership: `engineer_runs.user_id` (owner) + `.repository_id` +
  (v34) `.org_id`; repository identity lives in `repository_connections`
  (`id`, `user_id`, `provider`, `owner`, `name`) — `database-schema.ts:822` FK targets.
- Verified-candidate ownership row: `verified_candidate_checkpoints` —
  `database-schema.ts:822`: `requester_user_id`, `repository_id`, `org_id`
  (org_id added by v34; read at `packages/engineer/src/ledger.ts:7475`).
- Tenant DAL owner/org scoping: `packages/engineer/src/tenant-dal.ts` (every read
  is `... AND org_id=?`, e.g. `tenant-dal.ts:113,151,170,228`).

Ownership derivation (R2): the facade derives the owner from the durable
checkpoint row and compares to `principal.ownerId`; a mismatch is the same
not-found shape as an unknown checkpoint.

**INVARIANT (ownership):** A publication candidate/approval is visible/usable
ONLY to the principal whose `ownerId` equals the durable
`verified_candidate_checkpoints.requester_user_id` (and, for R4, the row's
`org_id` equals the principal's tenant). Cross-owner and unknown collapse to one
404 `CANDIDATE_NOT_FOUND`. R3/R4 must NOT introduce any code path that derives
ownership/org from a request body, header, or URL segment.

**INVARIANT (org):** `org_id` is NOT NULL on every tenant-owned table and is
never client-supplied. R4 owns per-tenant org derivation; the single-tenant
default org id constant is frozen at `database-schema.ts:2955`.

---

## 2. Candidate / checkpoint identifiers (checkpointId ↔ checkpointHash binding)

Authoritative TS types: `packages/engineer/src/publication-authority.ts`
- `CandidateLineage` — `publication-authority.ts:33` (`"ORIGINAL" | "P7_REPLACEMENT"`)
- `PublicationCandidate` — `publication-authority.ts:37`
  (`checkpointId`, `checkpointHash`, `lineage`, `lineageVerified`)
- `HashSchema` (`^sha256:[a-f0-9]{64}$`) — `publication-authority.ts:158`
- `CommitSchema` (40- or 64-hex) — `publication-authority.ts:159`
- `SelectionInputSchema` (strict) — `publication-authority.ts:162`

Durable binding: `verified_candidate_checkpoints.id` **is** the `checkpointId`
and `.checkpoint_hash` **is** the `checkpointHash`; the pair is unique via
`uq_verified_candidate_checkpoint_pair_v26` — `database-schema.ts:1396`. The row
is immutable (triggers `prevent_verified_candidate_checkpoints_update/delete_v21`).

Server derivation (R2): given `checkpointId`, the facade reads
`verified_candidate_checkpoints` and derives `checkpointHash`, `repositoryId`,
`resultCommitSha`, `candidateRunId (= run_id)`. A body value for any of these is
ignored; the derived value always wins. A checkpoint that is not a PROMOTED
`verified_candidate_checkpoints` row owned by the principal → 404.

Lineage derivation (R2): a candidate whose `run_id` is a
`resolution_replacements.replacement_run_id` (`database-schema.ts:2659`) is
`P7_REPLACEMENT`; otherwise `ORIGINAL`. The publication root run + parent
ORIGINAL selection of a `P7_REPLACEMENT` are derived from
`candidate_lineage_attestations` (`database-schema.ts:1214`, `child_checkpoint_id`
→ `root_run_id`) — never the frozen resolution `source_run_id` (the v37 freeze
trigger `freeze_source_pub_candidate_selection_v37` at `database-schema.ts:3342`
forbids a source run as a selection `run_id`). A `P7_REPLACEMENT` is gated by the
real `ResolutionLineageVerifier` (`packages/engineer/src/resolution-lineage.ts:103`,
seam `CompanionLineageVerifier` at `publication-authority.ts:65`); absent/throw/
false ⇒ `lineage_verified=0` ⇒ ineligible.

**INVARIANT (identifier binding):** `(checkpointId, checkpointHash)` are bound by
the durable checkpoint row; a client may supply only `checkpointId`. The
`checkpointHash` used anywhere in the publication path is derived, never trusted
from a body. `lineage` is derived, never client-claimed. R3 may read
`PublicationCandidate` but must not add a code path that accepts a client-supplied
`checkpointHash`, `repositoryId`, `resultCommitSha`, `candidateRunId`, or `lineage`.

Durable selection row + projection/immutability triggers:
`publication_candidate_selections_v33` — `database-schema.ts:2774`; projection
trigger `require_pub_candidate_selection_projection_v33` — `database-schema.ts:2799`.

---

## 3. Approval identity format (requester vs approver)

Authoritative TS types + Zod: `packages/engineer/src/publication-authority.ts`
- Request BODY (browser choice only, NO actor fields): `ApprovalDecisionBodySchema`
  (strict) — `publication-authority.ts:181` (`checkpointHash`, `decision`,
  `policyVersion`, optional `rationale`, ignored `approverRole`).
- Server-authenticated context (never client-writable): `ApproverAuthContextSchema`
  (strict) — `publication-authority.ts:199` (`approverActorId`,
  `implementationActorId`, `evidenceRoot`, `expiresAt`).
- Approve derivation: `PublicationAuthorityService.approve` —
  `publication-authority.ts:376` (requester = selection's recorded
  `requester_user_id`; approver from context; `requester === approver` ⇒
  `SelfApprovalError` 403).
- Facade context build (server-derived; body `checkpointHash` OVERRIDDEN with the
  derived value): `apps/gateway/src/engineer-publication-facade.ts` `approve`.

Durable approval row + three-identity CHECKs + binding trigger:
`publication_approvals_v33` — `database-schema.ts:2806`
(`requester_actor_id`/`approver_actor_id`/`implementation_actor_id`,
`CHECK(requester_actor_id <> approver_actor_id)` at `:2831`, binding trigger
`require_pub_approval_binding_v33` at `:2838`).

Identity source: `deriveEngineerPrincipal` — `apps/gateway/src/engineer-identity.ts:31`
(`ownerId` = requester, `reviewerId` = approver, `safetyIdentifier` =
implementation actor).

**INVARIANT (approval identity):** requester = selection's durable
`requester_user_id`; approver = server principal's `reviewerId`; implementation =
principal's `safetyIdentifier`. All three are derived; a request body carries only
`decision`/`policyVersion`/`rationale`. Self-approval is rejected on ACTOR IDENTITY
(not role).

> ⚠️ **FORMAT-FROZEN-BUT-NOT-FIXED — single-install-secret identity.**
> `deriveEngineerPrincipal` (`engineer-identity.ts:31`) derives BOTH `ownerId`
> (requester) and `reviewerId` (approver) from the **same** `gatewayIdentitySecret`.
> On a single install the "two humans" are two HMAC derivations of one secret, so
> the requester≠approver control is structurally satisfied but NOT a real
> two-person control. The **format** (distinct `requester_actor_id` vs
> `approver_actor_id`, three-identity CHECKs) is frozen here; the **real** fix
> (independent approver identity / true multi-party authority) is owned by
> **R4/R6** and MUST preserve this frozen format.

---

## 4. Publication + attestation EVENT schemas (durable rows emitted along the path)

Publication state machine + views: `packages/engineer/src/publication-authority.ts`
- `PublicationState` — `publication-authority.ts:34`
  (`PREFLIGHT | DISPATCHED | RECEIPTED | RECONCILING | FAILED`)
- `PublicationView` — `publication-authority.ts:45` (`publicationId`, `state`,
  optional `receipt{prUrl,commitSha}`, optional `reconciliation{reason,observedRemoteState}`)
- `StartPublicationInputSchema` (strict) — `publication-authority.ts:207`
  (`runId`, `approvalId`, `operation:"BRANCH_PR"`, `idempotencyKey`)
- `ActuatorOutcome` — `publication-authority.ts:94` (`RECEIPT | AMBIGUOUS | FAILED`)

Durable rows (all append-only, immutability-triggered) —
`packages/engineer/src/database-schema.ts` migration v33:
- `publication_candidate_selections_v33` — `:2774`
- `publication_approvals_v33` — `:2806`
- `publication_git_operations_v33` — `:2846` (state transitions PREFLIGHT→DISPATCHED→
  RECEIPTED/RECONCILING/FAILED; single-use approval via
  `uq_pub_git_operation_approval_v33`)
- `publication_remote_receipts_v33` — `:2885`
- `publication_reconciliations_v33` — `:2903` (RECONCILING is durable; only an
  explicit typed resolution succeeds it — `resolveReconciliation`,
  `publication-authority.ts:528`)

v35 provenance attestation record: `provenance_attestations` —
`database-schema.ts:3294` (`statement_hash` PK; `approval_decision_id` UNIQUE via
`uq_provenance_attestation_approval_v35` at `:3310`; FK
`(subject_checkpoint_id, subject_checkpoint_hash)` → `verified_candidate_checkpoints`;
`org_id` NOT NULL). Facade emission seam (fail-closed + compensation):
`PublicationFacadeDeps.decideApprove` — `apps/gateway/src/engineer-publication-facade.ts:107`;
fail-closed error `PublicationAttestationUnavailableError` at `:71`.

**INVARIANT (dispatch/reconcile — R3):** DISPATCHED is committed BEFORE the remote
call; an ambiguous/uncertain outcome parks in RECONCILING with a durable record
and is NEVER auto-redispatched (`dispatch`/`resume`/`settleOutcome` —
`publication-authority.ts:547,594,605`). R3 builds dispatch/reconciliation against
`PublicationState` + `PublicationView` + the v33 operation/receipt/reconciliation
rows and must not add a state transition outside the frozen enum or a path that
re-issues a committed DISPATCHED.

**INVARIANT (attestation — R4):** a REQUIRED v35 attestation is emitted+persisted
in the approval's own transaction or the approve fails closed; if emission throws
post-commit the P8 approval is compensated (INVALIDATED) so no consumable approval
survives without its attestation. `approval_decision_id` is UNIQUE (one attestation
per decision). R4 owns durable enforcement; the record shape above is frozen.

---

## 5. Audit-export contract (export row shape + feeding durable tables)

Authoritative TS types + Zod: `packages/engineer/src/audit-export.ts`
- `AuditEntrySchema` (strict) — `audit-export.ts:29` (`kind: EVENT|EVIDENCE|ATTESTATION`,
  `id`, `sequence`, `tenantId`, `runId`, `recordedAt`, `payload`)
- `AuditExportPage` — `audit-export.ts:48` (`pageChecksum`, `previousPageChecksum` chain)
- `AuditExport` — `audit-export.ts:57` (`schemaVersion`, `policyVersion`,
  `tenantId`, `runId`, `entryCount`, `pageSize`, `pageCount`, `contentDigest`, `pages`)
- Assembly + redaction + checksum chain: `exportAuditChain` — `audit-export.ts:134`
  (redacts secrets/paths/storage refs before hashing; `contentDigest` independent
  of `pageSize`).

Feeding durable tables (org-scoped reads): `packages/engineer/src/tenant-dal.ts`
`readRunAuditEntries` — `tenant-dal.ts:198`:
- `run_state_events` → `kind:"EVENT"` (`tenant-dal.ts:204`)
- `verified_candidate_checkpoints` → `kind:"ATTESTATION"` (`tenant-dal.ts:228`)
- `promotion_provenance_attestations` → `kind:"ATTESTATION"` (`tenant-dal.ts:253`)

Every feed query is `... AND org_id=?` (tenant isolation).

**INVARIANT (audit export — R4):** the export row shape (`AuditEntry`/`AuditExport`)
and its schema/policy versions are frozen; entries are redacted before the
checksum chain is computed; every feed is org-scoped. R4 may add feeding tables
(e.g. the v33 publication rows / v35 attestations) but must map them into the
frozen `AuditEntry` shape with `kind ∈ {EVENT,EVIDENCE,ATTESTATION}` and keep the
redaction-before-hash + org-scoping invariants.

---

## What R2 explicitly did NOT close (hand-off notes)

1. **Single-install-secret approver identity** — §3: format frozen, NOT a real
   two-person control. Owned by R4/R6.
2. **P7_REPLACEMENT happy-path publication topology** — R2 derives lineage and the
   root/parent from `candidate_lineage_attestations` and **fails closed** when the
   durable lineage attestation or parent ORIGINAL selection is absent. The full
   durable derivation + enforcement of the replacement→root publication topology
   (and its interaction with the v37 source-freeze) is R3/R4 work. R2 guarantees
   only that a client can neither claim a lineage nor publish a replacement-run
   checkpoint as ORIGINAL.
3. **v35 attestation `resultTreeHash` sourcing** — still returns null (unsourced);
   attestation remains formally deferred unless `ENGINEER_PROVENANCE_ATTESTATION_REQUIRED`
   is set AND a signer is configured (then it fails closed). Real git-tree sourcing
   is downstream work.
   > **SUPERSEDED (R7-5, 2026-07-19):** this frozen R2 note no longer describes the
   > runtime. `resultTreeHash` is now SOURCED (`GitService.resolveResultTreeHash`,
   > wired via `resultTreeHashFor`) and attestation is REQUIRED BY DEFAULT — the
   > `ENGINEER_PROVENANCE_ATTESTATION_REQUIRED` flag is honored only as a loud `=0`
   > opt-out. See KNOWN-LIMITATIONS.md / ARCHITECTURE.md for the current posture.
