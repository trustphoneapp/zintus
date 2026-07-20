/**
 * Typed client for P7 Resolution Desk (§2) and P8 Approval/publication (§3)
 * of docs/zintus-engineer/PHASE-CONTRACTS-P7-P10.md. This module calls only
 * routes named in §4's consumed-shape list. The browser never sends actor,
 * ownership, version-derivation, budget-eligibility, or CAS-authority fields
 * that the server is supposed to derive — every outgoing body below is
 * limited to exactly the fields the frozen contract documents as client
 * input.
 *
 * RESOLVED by supersession §5a (S1, 2026-07-19, commit 57e60752) from the
 * P9 slice-1 contract-gap report:
 *  1. `CanonicalBlocker` frozen exactly as this module's inferred shape.
 *  2. List/detail GET wrapper-object convention codified, not changed.
 *  3. `ResolutionCase` gained `pricingPolicyDigest` — the source route for
 *     the digest a corrected-run's `ReplacementBudget.pricingPolicyDigest`
 *     must echo (drift → `409 PRICING_POLICY_DRIFT`). Wired below.
 *  4. `approvalId` confirmed as first-class on approval records.
 *  5. Spend fields are `used/reserved/ambiguous/remaining` (the real
 *     `EngineerBudgetSnapshot`); "released" folds into settled/used and is
 *     not a separate field — already how this UI renders it.
 *
 * INTEGRATION PASS (2026-07-19, P9 integration step): §2 is now wired
 * against the REAL live routes in apps/gateway/src/handler.ts (the P7
 * resolutionDesk facade + packages/engineer/src/resolution-desk.ts), not
 * fixtures. Reading that implementation directly (not just the frozen
 * §2 prose) surfaced deltas from the doc that this module now follows,
 * documented inline at each call site:
 *  - `POST .../resolution-cases` truly sends no body (the route never
 *    calls `request.json()`); creation idempotency comes from the
 *    server keying the case on `source_run_id`, not from an
 *    Idempotency-Key. The response is `{case: ResolutionCase}` (wrapped),
 *    not the bare case.
 *  - `POST .../directives` and `POST .../apply` require the
 *    `Idempotency-Key` as an HTTP header (`request.headers.get(...)`),
 *    NOT as a body field — the directive body is parsed by a Zod
 *    `.strict()` schema (`DirectiveRequestSchema`) that has no
 *    `idempotencyKey` property, so the old fixture shape (idempotencyKey
 *    inside the JSON body) would 400 on every real directive-create call.
 *  - Mutation error bodies are `{error: {code, message, detail?}}` with
 *    `successor` (only used by the superseded legacy route) at the top
 *    level — `code` and the CAS `{expected, actual}` conflict are BOTH
 *    nested under `error`, not top-level `code`/`conflict` as the frozen
 *    §2 prose implies. Fixed in `request()` below; every
 *    `ResolutionApiError.code`/`.conflict` consumer downstream
 *    (`resolutionErrorDetail` in ResolutionDeskControls.tsx) now sees the
 *    real values instead of always-null.
 *
 * §3 (Approval/publication) is now WIRED against the live P8 publication
 * authority routes in apps/gateway/src/handler.ts (the
 * EngineerPublicationAuthorityFacade over packages/engineer/src/
 * publication-authority.ts). Reading that implementation directly (R3
 * integration) fixed three client/server disagreements that made a real
 * browser approve ALWAYS 400 and the publish gate never enable:
 *  - `createApproval` MUST send `policyVersion:
 *    "engineer-publication-authority-v33"` and MUST NOT send an
 *    `idempotencyKey` — the server body schema (`ApprovalDecisionBodySchema`)
 *    is Zod `.strict()`, so a missing policyVersion or an extra idempotencyKey
 *    both 400. The approval is single-use server-side; idempotency for the
 *    PUBLISH step comes from its Idempotency-Key header, not the approve body.
 *  - The approve response is the BARE `{approvalId, status}` the service
 *    returns (no `{approval: …}` envelope); the client returns it directly.
 *  - `POST .../publications` echoes `{publicationId, state}` (the
 *    PublicationView plus its id), read directly.
 */

/**
 * The single frozen publication-authority policy version
 * (`PUBLICATION_AUTHORITY_POLICY_VERSION` in
 * packages/engineer/src/publication-authority.ts). The approve body schema is
 * `z.literal(...)` on this exact value, so the client must send it verbatim.
 */
export const PUBLICATION_AUTHORITY_POLICY_VERSION = "engineer-publication-authority-v33";

import { GATEWAY_URL, gatewayAuthHeaders } from "./gateway";

// ---------------------------------------------------------------------------
// §2 — Resolution Desk
// ---------------------------------------------------------------------------

export type ResolutionCaseState =
  | "OPEN"
  | "DIRECTIVE_ISSUED"
  | "APPLYING"
  | "RESOLVED_CORRECTED"
  | "RESOLVED_REVERIFIED"
  | "REJECTED_CLOSED";

/** Frozen by §5a S1 exactly as this module inferred it; matches CanonicalBlockerSchema in packages/engineer/src/resolution-case.ts verbatim. */
export interface CanonicalBlocker {
  blockerId: string;
  kind: "BLOCKING" | "ADVISORY";
  reasonCode: string;
  description: string;
  sourceRef?: string | null;
}

/** Known members are documented in §2; unknown codes still render (humanized), never crash. */
export type TypedTransientCause = "PHASE3_UNEXPECTED_FAILURE" | (string & {});
export type IneligibleReason = "SOURCE_CLASS_EXCLUDED" | (string & {});

export interface ResolutionSpending {
  sourceActualUsd: number;
  priorReplacementActualUsd: number;
  ambiguousLiabilityUsd: number;
  cumulativeCeilingUsd: number;
}

export interface ResolutionCase {
  caseId: string;
  runId: string;
  caseVersion: number;
  state: ResolutionCaseState;
  blockers: CanonicalBlocker[];
  correctionEligible: boolean;
  reverifyEligibility: { eligible: boolean; reason: TypedTransientCause | IneligibleReason };
  spending: ResolutionSpending;
  /** §5a S1: the server's current pricing-policy digest. A corrected-run directive's ReplacementBudget.pricingPolicyDigest must equal this, or the server returns 409 PRICING_POLICY_DRIFT. */
  pricingPolicyDigest: string;
  preVerificationCandidate?: { present: true; digest: string };
  createdAt: string;
  expiresAt: string;
}

/**
 * The live route's per-case event payload (`resolution_events.payload_json`,
 * read verbatim by the gateway's `readCaseEvents` in apps/gateway/src/index.ts
 * and appended by `ResolutionDesk.appendEvent` in
 * packages/engineer/src/resolution-desk.ts). This is NOT the run-level
 * `RunEvent` shape (`previousState`/`nextState`/`reasonCode`/`timestamp`) —
 * it is the resolution-case ledger's own event: case-version transitions,
 * keyed by `eventType` (e.g. `CASE_OPENED`, `DIRECTIVE_ISSUED`,
 * `CASE_REJECTED`, `REPLACEMENT_PREPARING`, `REPLACEMENT_READY`) with a
 * hash chain (`previousEventHash`/`eventHash`). Fixed here from the P9
 * fixture build, which mistakenly reused `RunEvent`; the desk screen does
 * not currently render this field, so this is a type-level correction with
 * no behavior change.
 */
export interface ResolutionCaseEvent {
  eventId: string;
  caseId: string;
  sequence: number;
  previousEventHash: string | null;
  eventType: string;
  caseVersion: number;
  directiveId: string | null;
  actorType: string;
  actorId: string;
  createdAt: string;
  policyVersion: string;
  schemaVersion: number;
  eventHash: string;
  /** Event-type-specific extra fields (e.g. `caseHash`, `type`, `replacementRunId`) that vary by `eventType`. */
  [key: string]: unknown;
}

export interface ResolutionCaseDetail extends ResolutionCase {
  events: ResolutionCaseEvent[];
}

export type ResolutionDirectiveType = "CREATE_CORRECTED_RUN" | "CREATE_REVERIFY_RUN" | "REJECT_AND_CLOSE";

export interface ReplacementBudget {
  maxCostUsd: number;
  maxTokens: number;
  maxActiveSeconds: number;
  pricingPolicyDigest: string;
}

/**
 * Sentinel used only client-side to fail closed on the rare case whose own
 * `pricingPolicyDigest` is empty/missing (should not happen per §5a S1, but
 * the UI never sends a fabricated value if it does). Never sent to the
 * server as a real digest — `replacementBudgetFrom` refuses to build a
 * budget with this value.
 */
export const PRICING_POLICY_DIGEST_UNAVAILABLE = "__unavailable__";

export interface CreateResolutionDirectiveInput {
  type: ResolutionDirectiveType;
  caseVersion: number;
  sourceRunVersion: number;
  budget?: ReplacementBudget;
}

/**
 * The live `SignedDirective` shape (packages/engineer/src/resolution-case.ts)
 * returned inside `{directive, case}` by `POST .../directives`. Only the
 * fields the UI actually reads (`directiveId`, used to call apply) are
 * relied on; the rest are declared to match the real server response,
 * including the delta from the P9 fixture build: the server's `budget` uses
 * `maxCostMicrousd` (integer micro-USD), never the request-side `maxCostUsd`
 * float the client sends when issuing the directive.
 */
export interface ResolutionDirective {
  directiveId: string;
  directiveHash: string;
  caseId: string;
  caseHash: string;
  type: ResolutionDirectiveType;
  expectedCaseVersion: number;
  expectedSourceRunVersion: number;
  selectedBlockers: CanonicalBlocker[];
  budget: { maxCostMicrousd: number; maxTokens: number; maxActiveSeconds: number; pricingPolicyDigest: string } | null;
  ttlSeconds: number;
  createdAt: string;
  expiresAt: string;
}

export interface ResolutionDirectiveApplyResult {
  replacementRunId: string;
  state: "PREPARING" | "READY" | "FAILED";
}

// ---------------------------------------------------------------------------
// §3 — Approval / publication
// ---------------------------------------------------------------------------

export type PublicationCandidateLineage = "ORIGINAL" | "P7_REPLACEMENT";

export interface PublicationCandidate {
  checkpointId: string;
  checkpointHash: string;
  lineage: PublicationCandidateLineage;
  lineageVerified: boolean;
}

export type ApprovalDecision = "APPROVE" | "REJECT";

export interface CreateApprovalInput {
  checkpointHash: string;
  decision: ApprovalDecision;
  rationale?: string;
}

/**
 * The bare approve response the live service returns (§3):
 * `{approvalId, status}` — NOT the fuller `ResolutionApproval` envelope this
 * module used to (wrongly) unwrap. `status` is `APPROVED` for an APPROVE
 * decision, `REJECTED` for a REJECT; the publish gate keys on it.
 */
export interface PublicationApprovalResult {
  approvalId: string;
  status: "APPROVED" | "REJECTED";
}

/**
 * `approvalId` confirmed as first-class by §5a S1. The rest of this
 * envelope (the other "binds" fields) is still this module's inference —
 * still open, see the module header.
 */
export interface ResolutionApproval {
  approvalId: string;
  approver: string;
  requester: string;
  checkpointId: string;
  checkpointHash: string;
  evidenceRoot: string;
  repositoryId: string;
  baseCommitSha: string;
  policyVersion: string;
  expiresAt: string;
  status: "APPROVED" | "REJECTED";
  revision: number;
}

export type PublicationState = "PREFLIGHT" | "DISPATCHED" | "RECEIPTED" | "RECONCILING" | "FAILED";

export interface EngineerPublication {
  state: PublicationState;
  receipt?: { prUrl: string; commitSha: string };
  reconciliation?: { reason: string; observedRemoteState: string };
}

/** CONTRACT GAP — see module header: creation response envelope is inferred. */
export interface EngineerPublicationCreated extends EngineerPublication {
  publicationId: string;
}

export interface CreatePublicationInput {
  approvalId: string;
  operation: "BRANCH_PR";
}

/**
 * R7-2 durable current-publication projection (the refresh-hydration source).
 * WIRED to `GET /v1/engineer/runs/:runId/current-publication` in
 * apps/gateway/src/handler.ts (the EngineerPublicationAuthorityFacade over
 * packages/engineer/src/publication-authority.ts
 * `getCurrentPublicationView`). Everything the Approval & publication screen
 * must restore on a browser refresh — the active publication's state, its
 * approval, and the selected candidate — reconstructed from durable server rows
 * so React state is never the authority for an in-flight publication.
 */
export interface CurrentPublication {
  publicationId: string;
  runId: string;
  state: PublicationState;
  approvalId: string;
  approvalStatus: "APPROVED" | "REJECTED" | (string & {}) | null;
  checkpointId: string;
  checkpointHash: string;
  lineage: PublicationCandidateLineage;
  lineageVerified: boolean;
  receipt?: { prUrl: string; commitSha: string };
  reconciliation?: { reason: string; observedRemoteState: string };
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export interface ResolutionApiConflict { expected: unknown; actual: unknown }

export class ResolutionApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly conflict: ResolutionApiConflict | null;
  readonly successor: string | null;

  constructor(status: number, message: string, code: string | null, conflict: ResolutionApiConflict | null, successor: string | null) {
    super(message);
    this.name = "ResolutionApiError";
    this.status = status;
    this.code = code;
    this.conflict = conflict;
    this.successor = successor;
  }
}

/**
 * The live gateway's actual error envelope (see `mapResolutionDeskError` in
 * apps/gateway/src/handler.ts): `code` and any CAS-conflict `detail` are
 * BOTH nested under `error`, never top-level. Only the legacy
 * `410 GONE` corrected-run response puts `successor` at the top level, which
 * this module still reads from there since no §2 route this client calls
 * returns it any other way.
 */
interface ResolutionApiErrorBody {
  error?: string | { message?: string; code?: string; detail?: unknown; issues?: unknown };
  successor?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders(), ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as ResolutionApiErrorBody;
  if (!response.ok) {
    const errorField = body.error;
    const errorObject = errorField && typeof errorField === "object" ? errorField : null;
    const message = typeof errorField === "string" ? errorField : errorObject?.message ?? `Resolution request failed (${response.status})`;
    const code = errorObject && typeof errorObject.code === "string" ? errorObject.code : null;
    const detail = errorObject?.detail;
    const conflict = detail && typeof detail === "object" && "expected" in (detail as object) && "actual" in (detail as object)
      ? detail as ResolutionApiConflict
      : null;
    throw new ResolutionApiError(
      response.status,
      message,
      code,
      conflict,
      typeof body.successor === "string" ? body.successor : null,
    );
  }
  return body as unknown as T;
}

/** Deterministic idempotency keys: the same logical operation (same identifiers + versions) always yields the same key, so a double-click or a retried request replays exactly rather than mutating twice. Never a random value. */
function idempotencyKey(parts: Array<string | number>): string {
  return `ui:${parts.map((part) => String(part)).join(":")}`;
}

// ---------------------------------------------------------------------------
// §2 calls
// ---------------------------------------------------------------------------

/**
 * The live route (`POST /v1/engineer/runs/:runId/resolution-cases`) never
 * parses a request body — every authority field is derived server-side from
 * the durable run, matching §2's "Body: none" verbatim — and creation is
 * idempotent on the source run itself (a second call returns the existing
 * case rather than racing a second freeze), not on an Idempotency-Key. So
 * this sends no body and no Idempotency-Key header; both would be inert.
 * The response is `{case: ResolutionCase}` (wrapped), unwrapped here.
 */
export async function createResolutionCase(runId: string): Promise<ResolutionCase> {
  return (await request<{ case: ResolutionCase }>(`/v1/engineer/runs/${encodeURIComponent(runId)}/resolution-cases`, {
    method: "POST",
  })).case;
}

export async function listResolutionCases(runId: string): Promise<ResolutionCase[]> {
  return (await request<{ cases: ResolutionCase[] }>(`/v1/engineer/runs/${encodeURIComponent(runId)}/resolution-cases`)).cases;
}

export async function getResolutionCase(caseId: string): Promise<ResolutionCaseDetail> {
  const body = await request<{ case: ResolutionCase; events: ResolutionCaseEvent[] }>(`/v1/engineer/resolution-cases/${encodeURIComponent(caseId)}`);
  return { ...body.case, events: body.events };
}

/**
 * The live route reads the Idempotency-Key from the `Idempotency-Key` HTTP
 * header (never the body) and parses the body with a Zod `.strict()`
 * schema that has no `idempotencyKey` property — sending it in the body
 * (the P9 fixture build's shape) would 400 before the server even checks
 * idempotency. Fixed: key goes in the header; the body carries only the
 * §2-documented fields.
 */
export async function createResolutionDirective(caseId: string, input: CreateResolutionDirectiveInput): Promise<ResolutionDirective> {
  const key = idempotencyKey(["directive", caseId, input.caseVersion, input.sourceRunVersion, input.type]);
  return (await request<{ directive: ResolutionDirective; case: ResolutionCase }>(`/v1/engineer/resolution-cases/${encodeURIComponent(caseId)}/directives`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({
      type: input.type,
      caseVersion: input.caseVersion,
      sourceRunVersion: input.sourceRunVersion,
      ...(input.budget ? { budget: input.budget } : {}),
    }),
  })).directive;
}

/**
 * Same live-route correction as `createResolutionDirective`: the apply
 * route never parses a request body at all (idempotency comes solely from
 * the `Idempotency-Key` header), so the key is sent as a header, not a body
 * field.
 */
export async function applyResolutionDirective(directiveId: string): Promise<ResolutionDirectiveApplyResult> {
  const key = idempotencyKey(["directive-apply", directiveId]);
  return request<ResolutionDirectiveApplyResult>(`/v1/engineer/resolution-directives/${encodeURIComponent(directiveId)}/apply`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
  });
}

/**
 * Client-side mirror of the server's ceiling rule (§2: "server rejects when
 * prior actual + ambiguous + new cap exceeds the root/case cumulative
 * ceiling"). This NEVER replaces the server check — it only lets the
 * Resolution Desk warn before a submit that the server would reject with
 * `409 CEILING_EXCEEDED` anyway.
 */
export function projectsWithinCumulativeCeiling(spending: ResolutionSpending, newMaxCostUsd: number): boolean {
  const projected = spending.sourceActualUsd + spending.priorReplacementActualUsd + spending.ambiguousLiabilityUsd + newMaxCostUsd;
  return projected <= spending.cumulativeCeilingUsd;
}

// ---------------------------------------------------------------------------
// §3 calls — WIRED to the live P8 publication-authority routes in
// apps/gateway/src/handler.ts. Every body below carries ONLY the browser's
// choice; the server derives all authority (requester/approver/idempotency).
// ---------------------------------------------------------------------------

export async function getPublicationCandidates(runId: string): Promise<PublicationCandidate[]> {
  return (await request<{ candidates: PublicationCandidate[] }>(`/v1/engineer/runs/${encodeURIComponent(runId)}/publication-candidates`)).candidates;
}

/**
 * The live approve body is Zod `.strict()`: exactly `checkpointHash`,
 * `decision`, `policyVersion`, and optional `rationale`. It carries NO
 * `idempotencyKey` (single-use approval; the PUBLISH step is what is
 * idempotency-keyed). The response is the bare `{approvalId, status}` the
 * service returns — returned directly, never unwrapped from an envelope.
 */
export async function createApproval(checkpointId: string, input: CreateApprovalInput): Promise<PublicationApprovalResult> {
  return request<PublicationApprovalResult>(`/v1/engineer/publication-candidates/${encodeURIComponent(checkpointId)}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      checkpointHash: input.checkpointHash,
      decision: input.decision,
      policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION,
      ...(input.rationale ? { rationale: input.rationale } : {}),
    }),
  });
}

export async function createPublication(runId: string, input: CreatePublicationInput): Promise<EngineerPublicationCreated> {
  const key = idempotencyKey(["publication", runId, input.approvalId, input.operation]);
  return request<EngineerPublicationCreated>(`/v1/engineer/runs/${encodeURIComponent(runId)}/publications`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ approvalId: input.approvalId, operation: input.operation, idempotencyKey: key }),
  });
}

/**
 * Advances a PREFLIGHT publication to DISPATCHED and drives the credentialed
 * branch/PR effect. Idempotent on the server (a re-dispatch of a DISPATCHED
 * operation never re-issues the remote effect; it reconciles). The response
 * is the resulting `{publicationId, state}` PublicationView.
 */
export async function dispatchPublication(publicationId: string): Promise<EngineerPublicationCreated> {
  return request<EngineerPublicationCreated>(`/v1/engineer/publications/${encodeURIComponent(publicationId)}/dispatch`, {
    method: "POST",
  });
}

export async function getPublication(publicationId: string): Promise<EngineerPublication> {
  return request<EngineerPublication>(`/v1/engineer/publications/${encodeURIComponent(publicationId)}`);
}

/**
 * R7-2: read-only durable projection of the run's CURRENT publication. The
 * Approval & publication screen hydrates from this on load/refresh so a
 * mid-publication refresh restores the EXACT durable publication (state +
 * approval + selected candidate) instead of falling back to the candidate list.
 * Returns `null` when the run has no active publication (or is unknown /
 * cross-owner — the server returns the same `{ publication: null }` none-shape).
 */
export async function getCurrentPublication(runId: string): Promise<CurrentPublication | null> {
  return (await request<{ publication: CurrentPublication | null }>(`/v1/engineer/runs/${encodeURIComponent(runId)}/current-publication`)).publication;
}
