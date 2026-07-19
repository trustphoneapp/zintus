# Phase contracts freeze — P7/P8/P9/P10 (2026-07-19)

Frozen by the main architecture thread (Sol) after the P6 GO ruling
(`eb8b7539`). This document exists so four lanes can build in parallel without
inventing conflicting schema or API shapes. It freezes *interfaces*; each
phase's internal design authority remains the implementation log (P7: Day 2C)
and, for P8–P10, the 2026-07-18 handoff scope as bounded here. Changes to this
file after lane launch require a logged supersession entry, not an edit.

## 1. Migration number allocation (binding)

The v14–v30 chain is applied and byte-immutable. Allocation:

| Version | Owner | Content |
|---|---|---|
| v31 | P7 | The four frozen resolution authority tables (cases, directives, events, replacements) + indexes + immutability/projection triggers, exactly as Day 2C freezes them. No fifth table. |
| v32 | reserved | Standalone checkpoint-v3 (explicitly deferred by Day 2C; no lane may claim it) |
| v33 | P8 | Publication-authority additions layered on the existing v24 lifecycle slice: approval records, publication candidate selections, git operation records, remote receipts, reconciliation records |
| v34 | P10 | Tenancy: org/actor/connector identity, retention, tenant budget authority columns + tables (additive only; no legacy-row rewrite; backfill = explicit DEFAULT single-tenant org) |
| v35 | P11 | Attestation storage (provisional; P11 confirms need before claiming) |

Lane rule: only the P7 lane (main tree) may touch
`ENGINEER_DATABASE_SCHEMA_VERSION` and `database-schema.ts`/
`database-migrations.ts`. The P10 lane authors v34 as a standalone unwired
draft module (`tenancy-migration-draft.ts` + tests against a scratch DB); it
is wired into the chain at integration, after v31/v33 land, by the
integrator. P8's v33 is likewise authored as a draft module in its worktree
and wired at integration immediately after v31.

## 2. P7 Resolution Desk — API contract (frozen)

All routes owner-scoped (existing gateway auth actor = owner; P10 later
narrows to roles without changing shapes). All mutating routes require an
`Idempotency-Key` and use compare-and-swap versions; a CAS miss returns `409`
with `{conflict: {expected, actual}}`; an exact byte-identical replay returns
the original response.

- `POST /v1/engineer/runs/:runId/resolution-cases`
  → creates the canonical case, installs the ledger-wide source freeze in the
  same transaction. Body: none (all authority derived server-side from the
  durable run). Response: `ResolutionCase`.
- `GET /v1/engineer/runs/:runId/resolution-cases` → list (newest first).
- `GET /v1/engineer/resolution-cases/:caseId` → `ResolutionCase` + events.
- `POST /v1/engineer/resolution-cases/:caseId/directives`
  Body: `{type: "CREATE_CORRECTED_RUN"|"CREATE_REVERIFY_RUN"|"REJECT_AND_CLOSE",
  caseVersion, sourceRunVersion, budget?: ReplacementBudget}`.
  Server canonicalizes, signs (gateway-held key), stamps fixed TTL. Only the
  three types exist; anything else is `400 UNSUPPORTED_DIRECTIVE`.
- `POST /v1/engineer/resolution-directives/:directiveId/apply`
  → fenced `PREPARING → READY|FAILED` replacement creation; atomic replacement
  link; returns `{replacementRunId, state}`. Expired directive: `410
  DIRECTIVE_EXPIRED`. Conflicting concurrent apply: exactly one wins, the
  loser gets the winner's result (exact replay) or `409` (different bytes).
- Legacy `POST /v1/engineer/runs/:id/corrected-run` (`handler.ts:3016`) →
  `410 GONE` with `{successor: "resolution-cases"}`. Old runs stay readable.

`ResolutionCase` (response shape): `{caseId, runId, caseVersion, state:
"OPEN"|"DIRECTIVE_ISSUED"|"APPLYING"|"RESOLVED_CORRECTED"|
"RESOLVED_REVERIFIED"|"REJECTED_CLOSED", blockers: CanonicalBlocker[],
correctionEligible: boolean, reverifyEligibility: {eligible: boolean,
reason: TypedTransientCause|IneligibleReason}, spending: {sourceActualUsd,
priorReplacementActualUsd, ambiguousLiabilityUsd, cumulativeCeilingUsd},
preVerificationCandidate?: {present: true, digest}, createdAt, expiresAt}`.

`ReplacementBudget`: `{maxCostUsd, maxTokens, maxActiveSeconds,
pricingPolicyDigest}` — fresh human authority, never inherited; server
rejects when prior actual + ambiguous + new cap exceeds the root/case
cumulative ceiling (`409 CEILING_EXCEEDED`).

Frozen semantics the shapes must never dilute: corrected directives select
every open blocker in canonical order (no subset parameter exists in the API
— deliberately); reverify is eligible only from the closed typed transient
allowlist with zero correction-eligible blockers; `PHASE3_UNEXPECTED_FAILURE`
must be typed before any reverify eligibility returns true (P1 inside the P7
lane); optional-hardening/v2 sources return `reverifyEligibility.eligible:
false, reason: "SOURCE_CLASS_EXCLUDED"` in release 1.

## 3. P8 Approval/publication — API contract (frozen shapes, draft depth)

- `GET /v1/engineer/runs/:runId/publication-candidates` → eligible candidates,
  each `{checkpointId, checkpointHash, lineage: "ORIGINAL"|"P7_REPLACEMENT",
  lineageVerified: boolean}`. Replacement lineage MUST be computed by the same
  companion-aware verifier P7 ships — the P8 lane imports it, never re-implements.
- `POST /v1/engineer/publication-candidates/:checkpointId/approvals`
  Body: `{checkpointHash, decision: "APPROVE"|"REJECT", rationale?}`.
  Server derives approver identity; requester === approver → `403
  SELF_APPROVAL`. Approval binds `{approver, requester, checkpointId,
  checkpointHash, evidenceRoot, repositoryId, baseCommitSha, policyVersion,
  expiresAt}` and is CAS-guarded on `(status, checkpointId, checkpointHash,
  revision)` like the existing promotion CAS.
- `POST /v1/engineer/runs/:runId/publications`
  Body: `{approvalId, operation: "BRANCH_PR"}` + `Idempotency-Key`.
  Preflight revalidates branch/base/repo immediately before Git effects; any
  mismatch → `409 PREFLIGHT_MISMATCH` and the approval is invalidated.
- `GET /v1/engineer/publications/:publicationId` → `{state: "PREFLIGHT"|
  "DISPATCHED"|"RECEIPTED"|"RECONCILING"|"FAILED", receipt?: {prUrl,
  commitSha}, reconciliation?: {reason, observedRemoteState}}`.
  Ambiguous remote outcome NEVER auto-replays: it parks in `RECONCILING`
  with a durable reconciliation record (this also closes the audit's
  double-PR window, finding 4).
- Hardening children: `publication-candidates` never lists a child candidate
  directly; only parent-linked upgraded candidates appear.

## 4. P9 UI — consumed-shape contract (frozen)

P9 consumes exactly: the run projection (existing), `ResolutionCase` (§2),
publication candidates/approvals/publications (§3), and the existing redacted
readiness projection. Binding rules: the browser submits choices; the server
derives actor, ownership, versions, budgets, eligibility (no client-supplied
authority fields — any request carrying one is `400`). Spend renders
reserved/settled/uncertain/released as distinct fields already present in the
run projection. Every mutating control uses the route's `Idempotency-Key`
semantics for double-click safety. No route outside this list may be invented
by the UI lane; a missing need is a contract-change request, not a workaround.

## 5. P10 tenancy — contract (frozen)

- Every tenant-owned table gains `org_id TEXT NOT NULL` (v34 backfills the
  single-tenant default org for all pre-v34 rows) + actor identity on every
  authority row + connector identity on repository rows + retention class.
- Access exclusively through a tenant-scoped DAL: every query carries
  `org_id`; a DAL constructor without an org context is a type error. Raw
  `db.query` outside the DAL module becomes lint-forbidden for tenant tables.
- Roles (enum, frozen): `REQUESTER, RESOLVER, APPROVER, SECURITY_REVIEWER,
  REPO_ADMIN, ORG_ADMIN, AUDITOR`. Deny-by-default matrix; AI agents get
  non-human actor identities with a human sponsor field.
- Cross-tenant identifiers return the same not-found shape as nonexistent
  ones (no existence oracle). Self-approval rejection (§3) must hold across
  role changes: the check binds actor identity, not current role.

## 5a. Supersession log

**S1 (2026-07-19, Sol, from P9 lane contract-gap reports):**
1. `CanonicalBlocker` is frozen as `{blockerId, kind: "BLOCKING"|"ADVISORY",
   reasonCode, description, sourceRef?}` (P9's inferred minimal shape adopted).
2. List/detail GET responses use the wrapper-object convention already
   established in `apps/web/lib/engineer.ts` — codified, not changed.
3. `ResolutionCase` response GAINS `pricingPolicyDigest` (the server's current
   pricing-policy digest). A directive's `ReplacementBudget.pricingPolicyDigest`
   must equal the case's current value; drift → `409 PRICING_POLICY_DRIFT`.
   This is the source route for the digest the UI must echo back.
4. `approvalId` is confirmed as a first-class field on approval records; the
   publications route body references it.
5. §4 correction: spend fields are `used/reserved/ambiguous/remaining` (the
   real `EngineerBudgetSnapshot`); "released" folds into settled/used and is
   not a separate field. The UI renders the four real fields.

## 6. Lane and integration rules

1. Lanes: P7 = main tree (integration spine). P8, P9, P10 = isolated
   worktrees; commit locally per slice with `[P8]`/`[P9]`/`[P10]` prefixes;
   never push; never touch `database-schema.ts` (§1).
2. Integration order: P7 → P8 (wire v33 + real lineage verifier) → P9 + P10.
   The integrator (Sol) re-runs full gates + an adversarial pass at every
   merge; lane-local green is necessary, never sufficient.
3. Every lane obeys the loop law: brutal honesty; pass counts are claims, not
   proof; each report states what was NOT proven.
