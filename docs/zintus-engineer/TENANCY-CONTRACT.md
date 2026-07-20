# Engineer Tenancy Contract — FROZEN (R8-5)

STATUS: **FROZEN** 2026-07-20 (base: R8-1 committed adb4d897; tenancy migration = **v39**).
This is the single authoritative contract for the single-tenant → enterprise multi-tenant
conversion. Every bucket agent MUST obey it verbatim. Do NOT re-derive any primitive; if a rule
here is wrong, STOP and escalate to the orchestrator — do not improvise, because a local improvisation
is exactly how a cross-tenant hole is born.

## 0. THE SECURITY PROPERTY (what every bucket is protecting)
For any two orgs A and B: a principal authenticated to org B can NEVER read, list, update, delete,
infer the existence of, replay, approve, publish, revoke, or export ANY data belonging to org A —
including artifact FILE BYTES, checkpoints, lineage, approvals, receipts, and audit exports. A missed
query predicate is not a bug, it is a breach. When unsure whether a site needs scoping, it needs scoping.

## 1. ARCHITECTURE (PINNED — do not deviate)
**ledger-instance-per-org.** `EngineerLedger` already holds a fixed `tenantOrgId` field and its
constructor already rejects a non-default org. We EXTEND that seam:
- Constructor takes `orgId: string` (default stays `ENGINEER_DEFAULT_ORG_ID`).
- Constructor VALIDATES orgId against `orgs(id)` — row must exist and be active. No silent trust.
- `this.tenantOrgId` is the SOLE org source inside the ledger. NO method re-derives org from an
  argument, a row, a join, or a caller-supplied value. If a method needs the org, it reads
  `this.tenantOrgId`. Full stop.
- The gateway composition root builds the correct ledger per authenticated request from
  `resolveOrgContext()` (§3).

Consequence: per-site conversion is MECHANICAL — every tenant-table statement gains
`AND org_id = @tenantOrgId` (reads/updates/deletes) or `org_id` in the column list bound to
`this.tenantOrgId` (inserts). One org source, minimal judgement per site.

## 2. DAL PREDICATE + NOTFOUND FUNNEL (anti-oracle — MANDATORY wording)
- Every read/update/delete on a TENANT-OWNED table (the 69 tables in TENANT_OWNED_TABLES) carries
  `AND org_id = @tenantOrgId`.
- Every insert into a tenant-owned table sets `org_id = @tenantOrgId` explicitly (never relies on the
  DEFAULT, never takes org from an argument).
- **Anti-oracle rule:** a row that EXISTS but belongs to another org MUST be indistinguishable from a
  row that does not exist. Both return the IDENTICAL `EngineerNotFoundError` (same code, same message
  template, same shape). NEVER a "forbidden"/"unauthorized" variant for cross-org — that difference is
  an existence oracle. A write/update/delete targeting a foreign id = the same NotFound.
- Global/shared (non-tenant-owned) tables: leave unscoped ONLY if the table is genuinely org-agnostic
  (schema constants, migration bookkeeping). If in doubt, treat as tenant-owned and escalate.

## 3. resolveOrgContext(principal) → { orgId, actor }  (single seam, gateway)
Derives org from the authenticated principal via `org_memberships` (actor_id → org_id, status
'active'). No caller derives org any other way. Missing/inactive membership → AuthorizationError
(NOT NotFound — an authn/authz failure is distinct from a data-absence result).

## 4. assertAuthority(action, actor)  (REVIVE the dead RBAC matrix)
`tenant-roles.ts` (ROLE_GRANTS / roleCan / actorCan) currently has ZERO live call sites. Wire
`assertAuthority(action)` at the ENTRY of every public ledger/gateway method that performs a
privileged action (create run, plan, approve, publish, revoke, export, provision actor, issue
directive). Deny-by-default: unknown action OR ungranted role → AuthorizationError. A mutation that
flips a single grant MUST red a test.

## 5. assertDistinctApprovalActors(requesterId, approverId)  (structural two-person)
BOTH approval paths — the v33 publication lane AND legacy decideApproval — call it. The requester
identity is read from a DURABLE column written at request time (not reconstructed, not
provisioning-dependent). approverId ≠ requesterId enforced STRUCTURALLY (throws), identity-based
(same human via two roles still fails).

## 6. REVOCATION (make it enforced, not data-only)
Approval/authority revocation currently sets data with no enforcement. A revoked approval/authority
MUST be re-checked at the moment of use (publish/execute) and BLOCK the action. Revocation is
org-scoped like everything else.

## 7. MIGRATION v39 (enforcement only — NOT a schema build)
All 69 tenant tables already have org_id + org indexes (v34). v39 adds ONLY what enforcement needs:
any NOT-NULL/FK tightening on org_id not already present, plus the durable requester-id column for §5
if absent. Append-only; immutable; MUST ship its own hardcoded-historical fixture proving an at-rest
v38 DB upgrades clean (R8-1 discipline — frozen literal, not the mutable constant).

## 8. KNOWN DANGEROUS ID-KEYED SITES (call-outs — these are where the breach hides)
- `getVerifiedCandidateCheckpoint(checkpointId)` (ledger.ts:7201) — id-only, NO org filter.
- ARTIFACT BYTE READS (ledger.ts 1652 / 1706 / 2267 / 2496) — `readFileSync(storage_reference)` by
  id: a foreign artifactId returns another org's FILE BYTES. Scope the row lookup by org BEFORE the
  byte read.
- JOIN lineage lookups keyed only by childRunId (engineer_run_lineage / hardening_child_*).
- approval-request / decision by id (7327 / 7398 / 7875).
- resolution_replacements / cases / directives (877 / 894 / 917).
These are the sites the original "~120" undercounted. Real surface: ~218 id-keyed of ~503 unscoped of
~611 total this.db.* calls in ledger.ts.

## 9. CENTRAL CROSS-TENANT NEGATIVE-TEST MATRIX (ONE agent owns it — NOT per bucket)
Existing tenant-isolation tests cover only the ~8-method DAL, NOT the real EngineerLedger. The central
agent builds a two-org fixture (orgA, orgB) and, for EVERY converted bucket's public methods, proves
orgB's principal CANNOT touch orgA data across all verbs in §0, and that every cross-org attempt
returns the IDENTICAL NotFound (no oracle). This suite is the RELEASE GATE for R8-5.

## 10. PER-BUCKET DUAL-FABLE + HONEST VERDICT
Every bucket: worker (RED-first) → Main Fable (drive + mutation) → Independent Fable (adversarial from
scratch). A bucket is DONE only on dual-agreement. FINAL R8-5 verdict names exactly which buckets are
proven-clean vs unverified. No "done" on green alone. This is standing law, not optional.
