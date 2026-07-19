import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";

// ---------------------------------------------------------------------------
// P7 Developer Resolution Desk — canonical domain authority (Day 2C freeze).
//
// This module holds the *pure* authority for the append-only resolution lane:
// the canonical case/directive/replacement shapes, the closed reverify
// eligibility law, the root/case cumulative ceiling arithmetic, and the
// gateway-held directive signing. It never touches a database or a sandbox and
// deliberately owns no I/O, so every rule here is deterministically testable
// and the signing secret can be confined to the gateway process.
// ---------------------------------------------------------------------------

export const RESOLUTION_CASE_POLICY_VERSION = "engineer-resolution-case-v1" as const;
export const RESOLUTION_DIRECTIVE_POLICY_VERSION = "engineer-resolution-directive-v1" as const;
export const RESOLUTION_EVENT_POLICY_VERSION = "engineer-resolution-event-v1" as const;
export const RESOLUTION_REPLACEMENT_POLICY_VERSION = "engineer-resolution-replacement-v1" as const;
export const RESOLUTION_SCHEMA_VERSION = 1 as const;

/** Directives carry a fixed short life; changed limits conflict with replay. */
export const RESOLUTION_DIRECTIVE_TTL_SECONDS = 900 as const;
export const RESOLUTION_SIGNATURE_ALGORITHM = "HMAC-SHA256" as const;

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// --- Blocker vocabulary (S1-frozen minimal shape) --------------------------

/**
 * `CanonicalBlocker` is frozen by supersession S1 (2026-07-19) as the minimal
 * shape the P9 UI consumes: `{blockerId, kind, reasonCode, description,
 * sourceRef?}`. All correction / reverify classification is therefore derived
 * from `kind` (BLOCKING vs ADVISORY) plus `reasonCode` — there is no separate
 * category, severity, or typed-cause field on the blocker.
 */
export const CanonicalBlockerSchema = z.object({
  blockerId: z.string().min(1).max(200),
  kind: z.enum(["BLOCKING", "ADVISORY"]),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  description: z.string().min(1).max(2_000),
  sourceRef: z.string().min(1).max(400).optional(),
}).strict();
export type CanonicalBlocker = z.infer<typeof CanonicalBlockerSchema>;

/**
 * Closed, typed transient-cause allowlist. A blocker only authorizes reverify
 * when its `reasonCode` is exactly one of these with matching durable evidence.
 * Generic `PHASE3_UNEXPECTED_FAILURE` is not a member — it is untyped and stays
 * ineligible until a future slice types it.
 */
export const TypedTransientCauseSchema = z.enum([
  "PROVIDER_REQUEST_TIMEOUT",
  "PROVIDER_CONNECTION_RESET",
  "SANDBOX_PROVISION_TIMEOUT",
  "DEPENDENCY_FETCH_TIMEOUT",
  "INFRA_NETWORK_UNAVAILABLE",
]);
export type TypedTransientCause = z.infer<typeof TypedTransientCauseSchema>;
const TRANSIENT_CAUSES: ReadonlySet<string> = new Set(TypedTransientCauseSchema.options);

/**
 * Reason codes that can never be corrected, reverified, or waived — they
 * authorize only `REJECT_AND_CLOSE`. `PHASE3_UNEXPECTED_FAILURE` is here
 * because it is the erased, still-untyped Phase 3 cause (the P1).
 */
export const NON_RECOVERABLE_REASONS: ReadonlySet<string> = new Set([
  "PHASE3_UNEXPECTED_FAILURE",
  "RUNTIME_BUDGET_EXHAUSTED",
  "RETRY_BUDGET_EXHAUSTED",
  "MODEL_CALL_LIMIT_REACHED",
  "BUILDER_DISPATCH_FAILED",
  "BUILDER_FAILURE",
]);

export type ReasonClass = "TRANSIENT" | "NON_RECOVERABLE" | "CORRECTABLE";
export function classifyReason(reasonCode: string): ReasonClass {
  if (TRANSIENT_CAUSES.has(reasonCode)) return "TRANSIENT";
  if (NON_RECOVERABLE_REASONS.has(reasonCode)) return "NON_RECOVERABLE";
  return "CORRECTABLE";
}

export const IneligibleReasonSchema = z.enum([
  "SOURCE_CLASS_EXCLUDED",
  "NO_BLOCKERS",
  "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT",
  "NON_TRANSIENT_BLOCKER",
  "PHASE3_CAUSE_UNTYPED",
  "NO_PRE_VERIFICATION_CANDIDATE",
  "MULTIPLE_TRANSIENT_CAUSES",
]);
export type IneligibleReason = z.infer<typeof IneligibleReasonSchema>;

/**
 * Canonical order for corrected-directive blocker selection: BLOCKING before
 * ADVISORY, then reasonCode, then the stable blocker id. Every open blocker is
 * selected — there is deliberately no subset API — so the order only needs to
 * be total and reproducible.
 */
export function orderBlockersCanonically(blockers: readonly CanonicalBlocker[]): CanonicalBlocker[] {
  const kindRank = (kind: CanonicalBlocker["kind"]): number => (kind === "BLOCKING" ? 0 : 1);
  return [...blockers].sort((a, b) =>
    kindRank(a.kind) - kindRank(b.kind) ||
    a.reasonCode.localeCompare(b.reasonCode) ||
    a.blockerId.localeCompare(b.blockerId));
}

// --- Reverify eligibility (closed typed law) -------------------------------

export type ReverifyEligibility =
  | { eligible: true; reason: TypedTransientCause }
  | { eligible: false; reason: IneligibleReason };

export interface ReverifyInputs {
  readonly blockers: readonly CanonicalBlocker[];
  readonly sourceClassExcluded: boolean; // optional-hardening / v2 sources
  readonly preVerificationCandidatePresent: boolean;
}

/**
 * Reverify is eligible only from the closed typed transient allowlist with zero
 * correction-eligible blockers, a retained pre-verification candidate, and a
 * non-excluded source class. Every other shape — no blockers, correction-
 * eligible blockers, a non-transient blocker, generic untyped
 * `PHASE3_UNEXPECTED_FAILURE`, or a mix of transient causes — is refused with a
 * typed reason. This never returns `eligible: true` for an untyped Phase 3
 * failure.
 */
export function evaluateReverifyEligibility(inputs: ReverifyInputs): ReverifyEligibility {
  if (inputs.sourceClassExcluded) return { eligible: false, reason: "SOURCE_CLASS_EXCLUDED" };
  // Only BLOCKING items gate correction/reverify; advisories never block.
  const blocking = inputs.blockers.filter((blocker) => blocker.kind === "BLOCKING");
  if (blocking.length === 0) return { eligible: false, reason: "NO_BLOCKERS" };
  if (blocking.some((blocker) => classifyReason(blocker.reasonCode) === "CORRECTABLE")) {
    return { eligible: false, reason: "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT" };
  }
  // Every remaining blocking item is TRANSIENT or NON_RECOVERABLE.
  const causes = new Set<string>();
  for (const blocker of blocking) {
    if (classifyReason(blocker.reasonCode) === "NON_RECOVERABLE") {
      // Untyped PHASE3 workflow failures are the common erased case; report the
      // untyped reason specifically so a future typing slice is discoverable.
      if (blocker.reasonCode === "PHASE3_UNEXPECTED_FAILURE") return { eligible: false, reason: "PHASE3_CAUSE_UNTYPED" };
      return { eligible: false, reason: "NON_TRANSIENT_BLOCKER" };
    }
    causes.add(blocker.reasonCode);
  }
  if (causes.size !== 1) return { eligible: false, reason: "MULTIPLE_TRANSIENT_CAUSES" };
  if (!inputs.preVerificationCandidatePresent) return { eligible: false, reason: "NO_PRE_VERIFICATION_CANDIDATE" };
  return { eligible: true, reason: [...causes][0] as TypedTransientCause };
}

export interface FailureCauseInput {
  readonly reasonCode: string;
  readonly underlyingCause?: string;
}

/**
 * P7 (Day 3 pair 2) reverify consumption bridge. Resolve the blocker reasonCode
 * the reverify law consumes from a durable failure record. A generic
 * `PHASE3_UNEXPECTED_FAILURE` that carries a typed transient `underlyingCause`
 * from the closed allowlist surfaces AS that typed cause, so reverify can be
 * honestly unlocked; an absent or non-allowlisted cause stays
 * `PHASE3_UNEXPECTED_FAILURE` (reverify refused with `PHASE3_CAUSE_UNTYPED`).
 * Every other failure passes through unchanged — this bridge only types the
 * erased Phase-3 catch-all and never downgrades a real defect.
 */
export function reverifyBlockerReasonCode(input: FailureCauseInput): string {
  if (input.reasonCode !== "PHASE3_UNEXPECTED_FAILURE") return input.reasonCode;
  if (input.underlyingCause && TRANSIENT_CAUSES.has(input.underlyingCause)) return input.underlyingCause;
  return "PHASE3_UNEXPECTED_FAILURE";
}

export function isCorrectionEligible(blockers: readonly CanonicalBlocker[]): boolean {
  return blockers.some((blocker) => blocker.kind === "BLOCKING" && classifyReason(blocker.reasonCode) === "CORRECTABLE");
}

/**
 * P1 (Day 2C): deterministically type the erased Phase 3 underlying cause. The
 * live emission site currently records a generic `PHASE3_UNEXPECTED_FAILURE`
 * and hashes the real message away; this classifier is the typed vocabulary a
 * future slice threads in *before* erasure so reverify can be enabled honestly.
 * It returns `null` when the message cannot be typed — never a false positive.
 */
export function classifyPhase3UnderlyingCause(message: string): TypedTransientCause | null {
  const text = message.toLowerCase();
  if (/(provider|model|upstream).*(timeout|timed out)|request timed out/.test(text)) return "PROVIDER_REQUEST_TIMEOUT";
  if (/econnreset|connection reset|socket hang ?up/.test(text)) return "PROVIDER_CONNECTION_RESET";
  if (/sandbox.*(provision|start).*(timeout|timed out)|warm sandbox timeout/.test(text)) return "SANDBOX_PROVISION_TIMEOUT";
  if (/(dependency|package|lockfile|npm|registry).*(fetch|download).*(timeout|timed out|unreachable)/.test(text)) return "DEPENDENCY_FETCH_TIMEOUT";
  if (/enetunreach|network is unreachable|dns.*(fail|timeout)|getaddrinfo/.test(text)) return "INFRA_NETWORK_UNAVAILABLE";
  return null;
}

// --- Cumulative ceiling arithmetic -----------------------------------------

export interface CeilingInputs {
  readonly priorReplacementActualMicrousd: number;
  readonly ambiguousLiabilityMicrousd: number;
  readonly newCapMicrousd: number;
  readonly cumulativeCeilingMicrousd: number;
}

/** A fresh replacement cap is rejected when it would breach the root ceiling. */
export function isWithinCumulativeCeiling(inputs: CeilingInputs): boolean {
  return inputs.priorReplacementActualMicrousd + inputs.ambiguousLiabilityMicrousd + inputs.newCapMicrousd
    <= inputs.cumulativeCeilingMicrousd;
}

// --- Replacement budget (fresh human authority) ----------------------------

export const ReplacementBudgetSchema = z.object({
  maxCostUsd: z.number().nonnegative().finite(),
  maxTokens: z.number().int().nonnegative(),
  maxActiveSeconds: z.number().int().positive(),
  pricingPolicyDigest: HashSchema,
}).strict();
export type ReplacementBudget = z.infer<typeof ReplacementBudgetSchema>;

export function budgetMaxCostMicrousd(budget: ReplacementBudget): number {
  return Math.round(budget.maxCostUsd * 1_000_000);
}

// --- Directive type + request ----------------------------------------------

export const DirectiveTypeSchema = z.enum(["CREATE_CORRECTED_RUN", "CREATE_REVERIFY_RUN", "REJECT_AND_CLOSE"]);
export type DirectiveType = z.infer<typeof DirectiveTypeSchema>;

export const DirectiveRequestSchema = z.object({
  type: DirectiveTypeSchema,
  caseVersion: z.number().int().nonnegative(),
  sourceRunVersion: z.number().int().nonnegative(),
  budget: ReplacementBudgetSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.type === "CREATE_CORRECTED_RUN" && !request.budget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "corrected-run directives require a fresh replacement budget", path: ["budget"] });
  }
  if (request.type !== "CREATE_CORRECTED_RUN" && request.budget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only corrected-run directives carry a budget", path: ["budget"] });
  }
});
export type DirectiveRequest = z.infer<typeof DirectiveRequestSchema>;

/** Stable fingerprint of the client's intent — replay vs conflict pivots here. */
export function directiveRequestFingerprint(caseId: string, request: DirectiveRequest): `sha256:${string}` {
  return sha256({
    caseId,
    type: request.type,
    caseVersion: request.caseVersion,
    sourceRunVersion: request.sourceRunVersion,
    budget: request.budget ?? null,
  });
}

// --- Canonical directive + signing (gateway-held authority) ----------------

export interface DirectiveContentInput {
  readonly caseId: string;
  readonly caseHash: `sha256:${string}`;
  readonly type: DirectiveType;
  readonly expectedCaseVersion: number;
  readonly expectedSourceRunVersion: number;
  readonly selectedBlockers: readonly CanonicalBlocker[];
  readonly budget: ReplacementBudget | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SignedDirective {
  readonly directiveId: `sha256:${string}`;
  readonly directiveHash: `sha256:${string}`;
  readonly schemaVersion: 1;
  readonly policyVersion: typeof RESOLUTION_DIRECTIVE_POLICY_VERSION;
  readonly caseId: string;
  readonly caseHash: `sha256:${string}`;
  readonly type: DirectiveType;
  readonly expectedCaseVersion: number;
  readonly expectedSourceRunVersion: number;
  readonly selectedBlockers: CanonicalBlocker[];
  readonly budget: { maxCostMicrousd: number; maxTokens: number; maxActiveSeconds: number; pricingPolicyDigest: string } | null;
  readonly ttlSeconds: typeof RESOLUTION_DIRECTIVE_TTL_SECONDS;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signature: { algorithm: typeof RESOLUTION_SIGNATURE_ALGORITHM; keyId: string; value: string };
}

function directiveCanonicalContent(input: DirectiveContentInput): Record<string, unknown> {
  const selected = input.type === "CREATE_CORRECTED_RUN"
    ? orderBlockersCanonically(input.selectedBlockers)
    : [];
  return {
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    policyVersion: RESOLUTION_DIRECTIVE_POLICY_VERSION,
    caseId: input.caseId,
    caseHash: input.caseHash,
    type: input.type,
    expectedCaseVersion: input.expectedCaseVersion,
    expectedSourceRunVersion: input.expectedSourceRunVersion,
    selectedBlockers: selected,
    budget: input.budget
      ? {
        maxCostMicrousd: budgetMaxCostMicrousd(input.budget),
        maxTokens: input.budget.maxTokens,
        maxActiveSeconds: input.budget.maxActiveSeconds,
        pricingPolicyDigest: input.budget.pricingPolicyDigest,
      }
      : null,
    ttlSeconds: RESOLUTION_DIRECTIVE_TTL_SECONDS,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

/**
 * Server-side canonicalization + signing. The HMAC key never leaves this call:
 * callers pass the gateway-held secret, receive only the signed directive, and
 * the secret is confined to the gateway process (never model/sandbox context).
 * The signature binds the canonical directive hash, so any byte change breaks it.
 */
export function signDirective(input: DirectiveContentInput, secret: string, keyId: string): SignedDirective {
  const content = directiveCanonicalContent(input);
  const directiveHash = sha256(content);
  const directiveId = sha256({ directiveHash, keyId });
  const signature = createHmac("sha256", secret).update(directiveHash, "utf8").digest("hex");
  return {
    directiveId,
    directiveHash,
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    policyVersion: RESOLUTION_DIRECTIVE_POLICY_VERSION,
    caseId: input.caseId,
    caseHash: input.caseHash,
    type: input.type,
    expectedCaseVersion: input.expectedCaseVersion,
    expectedSourceRunVersion: input.expectedSourceRunVersion,
    selectedBlockers: content.selectedBlockers as CanonicalBlocker[],
    budget: content.budget as SignedDirective["budget"],
    ttlSeconds: RESOLUTION_DIRECTIVE_TTL_SECONDS,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    signature: { algorithm: RESOLUTION_SIGNATURE_ALGORITHM, keyId, value: signature },
  };
}

/** Constant-time-ish verification of a signed directive against the secret. */
export function verifyDirectiveSignature(directive: SignedDirective, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(directive.directiveHash, "utf8").digest("hex");
  const actual = directive.signature.value;
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

// --- Canonical case authority ----------------------------------------------

export interface CaseAuthorityInput {
  readonly caseId: `sha256:${string}`;
  readonly sourceRunId: string;
  readonly ownerUserId: string;
  readonly repositoryId: string;
  readonly sourceState: string;
  readonly sourceStateVersion: number;
  readonly baseCommitSha: string;
  readonly manifestHash: string;
  readonly requiredLaneContractHash: string;
  readonly blockers: readonly CanonicalBlocker[];
  readonly preVerificationCandidateDigest: `sha256:${string}` | null;
  readonly spendingMicrousd: {
    sourceActual: number;
    priorReplacementActual: number;
    ambiguousLiability: number;
    cumulativeCeiling: number;
  };
  readonly pricingPolicyDigest: `sha256:${string}`;
  readonly sourceClassExcluded: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CaseAuthority {
  readonly caseId: string;
  readonly caseHash: `sha256:${string}`;
  readonly json: string;
  readonly blockersJson: string;
  readonly correctionEligible: boolean;
  readonly reverifyEligibility: ReverifyEligibility;
}

/**
 * Build the immutable case authority (identity, source binding, ordered
 * blockers, eligibility, ceiling). `case_json`/`case_hash` cover only this
 * frozen authority; mutable lifecycle (state/version) lives outside it and is
 * fenced separately.
 */
export function buildCaseAuthority(input: CaseAuthorityInput): CaseAuthority {
  const blockers = orderBlockersCanonically(input.blockers);
  const correctionEligible = isCorrectionEligible(blockers);
  const reverifyEligibility = evaluateReverifyEligibility({
    blockers,
    sourceClassExcluded: input.sourceClassExcluded,
    preVerificationCandidatePresent: input.preVerificationCandidateDigest !== null,
  });
  const authority = {
    caseId: input.caseId,
    caseHash: "sha256:" + "0".repeat(64), // placeholder replaced below
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    policyVersion: RESOLUTION_CASE_POLICY_VERSION,
    sourceRunId: input.sourceRunId,
    ownerUserId: input.ownerUserId,
    repositoryId: input.repositoryId,
    sourceState: input.sourceState,
    sourceStateVersion: input.sourceStateVersion,
    baseCommitSha: input.baseCommitSha,
    manifestHash: input.manifestHash,
    requiredLaneContractHash: input.requiredLaneContractHash,
    blockers,
    blockerCount: blockers.length,
    correctionEligible: correctionEligible ? 1 : 0,
    reverifyEligible: reverifyEligibility.eligible ? 1 : 0,
    reverifyReason: reverifyEligibility.reason,
    preVerificationCandidatePresent: input.preVerificationCandidateDigest !== null ? 1 : 0,
    preVerificationCandidateDigest: input.preVerificationCandidateDigest,
    spendingMicrousd: input.spendingMicrousd,
    pricingPolicyDigest: input.pricingPolicyDigest,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const { caseHash: _placeholder, ...unhashed } = authority;
  const caseHash = sha256(unhashed);
  const withHash = { ...authority, caseHash };
  return {
    caseId: input.caseId,
    caseHash,
    json: canonicalJson(withHash),
    blockersJson: canonicalJson(blockers),
    correctionEligible,
    reverifyEligibility,
  };
}
