import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { sha256 } from "./hash.js";

// ---------------------------------------------------------------------------
// P7 companion-aware replacement-lineage verifier (Day 3 pair 2).
//
// A candidate checkpoint minted by a P7 *replacement* run must never be trusted
// through the legacy same-run verifier alone: that path (ledger
// getVerifiedCandidateCheckpoint) is entirely run-scoped and has no concept of
// the resolution chain, so a replacement-run checkpoint today passes identical
// scrutiny to an untampered original. This verifier closes that hole by walking
// the complete durable authority chain
//
//   replacement run id  ->  resolution_replacements (READY)
//                       ->  resolution_directives   (signature, TTL at apply)
//                       ->  resolution_cases        (case hash, resolved)
//                       ->  frozen source run
//
// and returning a typed verdict. Every checkpoint promotion / read, approval,
// and publication path for a replacement run must consult it; a missing or
// invalid link NEVER falls back to legacy same-run verification (fail closed).
//
// The exported class satisfies the shape the P8 publication lane stubbed as
// `CompanionLineageVerifier.verifyReplacementLineage(input) -> boolean`, so P8
// can drop this implementation into that seam with zero call-site changes.
// ---------------------------------------------------------------------------

export type ReplacementKind = "CORRECTED" | "REVERIFY";

export type LineageRejectReason =
  | "SIGNING_AUTHORITY_UNAVAILABLE"
  | "NOT_A_REPLACEMENT"
  | "REPLACEMENT_NOT_READY"
  | "DIRECTIVE_MISSING"
  | "DIRECTIVE_LINK_MISMATCH"
  | "DIRECTIVE_TAMPERED"
  | "DIRECTIVE_SIGNATURE_INVALID"
  | "DIRECTIVE_EXPIRED_AT_APPLY"
  | "KIND_MISMATCH"
  | "CASE_MISSING"
  | "CASE_HASH_MISMATCH"
  | "CASE_TAMPERED"
  | "CASE_NOT_RESOLVED"
  | "SOURCE_RUN_MISSING";

export interface LineageChain {
  readonly replacementRunId: string;
  readonly replacementId: string;
  readonly caseId: string;
  readonly directiveId: string;
  readonly sourceRunId: string;
  readonly kind: ReplacementKind;
}

export type LineageVerdict =
  | ({ readonly verified: true } & LineageChain)
  | { readonly verified: false; readonly reason: LineageRejectReason };

/**
 * The P8 seam shape (`CompanionLineageVerifier`). Kept structurally identical to
 * `publication-authority-migration-draft.ts` so P8 imports this class unchanged.
 */
export interface CompanionLineageVerifierInput {
  readonly runId: string;
  readonly candidateRunId: string;
  readonly parentSelectionId: string;
  readonly checkpointId: string;
  readonly checkpointHash: string;
  readonly resultCommitSha: string;
}

interface ReplacementRow {
  id: string; case_id: string; directive_id: string; directive_hash: string;
  kind: string; state: string; created_at: string;
}
interface DirectiveRow {
  id: string; case_id: string; case_hash: string; type: string;
  signature: string; directive_json: string; created_at: string; expires_at: string;
}
interface CaseRow {
  id: string; case_hash: string; source_run_id: string; state: string; case_json: string;
}

const DIRECTIVE_TYPE_TO_KIND: Record<string, ReplacementKind | undefined> = {
  CREATE_CORRECTED_RUN: "CORRECTED",
  CREATE_REVERIFY_RUN: "REVERIFY",
};

const RESOLVED_CASE_STATES: ReadonlySet<string> = new Set(["RESOLVED_CORRECTED", "RESOLVED_REVERIFIED"]);

export class ResolutionLineageVerifier {
  constructor(private readonly db: Database, private readonly signingSecret: string) {}

  /**
   * Walk the full replacement authority chain for `candidateRunId` and return a
   * typed verdict. Fail closed on every missing or invalid link — there is no
   * path that returns `verified: true` without a READY replacement bound to a
   * signature-valid, apply-time-live directive under a resolved, hash-consistent
   * case with a present frozen source run.
   */
  verify(candidateRunId: string): LineageVerdict {
    if (!this.signingSecret) return { verified: false, reason: "SIGNING_AUTHORITY_UNAVAILABLE" };

    const replacement = this.db.query(
      "SELECT id,case_id,directive_id,directive_hash,kind,state,created_at FROM resolution_replacements WHERE replacement_run_id=?",
    ).get(candidateRunId) as ReplacementRow | null;
    if (!replacement) return { verified: false, reason: "NOT_A_REPLACEMENT" };
    if (replacement.state !== "READY") return { verified: false, reason: "REPLACEMENT_NOT_READY" };

    const directive = this.db.query(
      "SELECT id,case_id,case_hash,type,signature,directive_json,created_at,expires_at FROM resolution_directives WHERE id=?",
    ).get(replacement.directive_id) as DirectiveRow | null;
    if (!directive) return { verified: false, reason: "DIRECTIVE_MISSING" };

    // The replacement pins the exact directive identity+hash it was created from.
    if (directive.case_id !== replacement.case_id) return { verified: false, reason: "DIRECTIVE_LINK_MISMATCH" };

    // Recompute the directive hash from its own canonical content and re-verify
    // the gateway-held HMAC over it: any byte change to the signed authority, or
    // a forged signature, is rejected.
    const directiveVerdict = this.verifyDirectiveIntegrity(directive, replacement.directive_hash);
    if (directiveVerdict) return { verified: false, reason: directiveVerdict };

    // TTL-at-apply re-derivation: the replacement must have been scaffolded
    // within the directive's live window. This is the durable proof the apply
    // respected the 900s TTL (wall-clock at verification time is always past it).
    if (replacement.created_at < directive.created_at || replacement.created_at > directive.expires_at) {
      return { verified: false, reason: "DIRECTIVE_EXPIRED_AT_APPLY" };
    }

    const kind = DIRECTIVE_TYPE_TO_KIND[directive.type];
    if (!kind || kind !== replacement.kind) return { verified: false, reason: "KIND_MISMATCH" };

    const caseRow = this.db.query(
      "SELECT id,case_hash,source_run_id,state,case_json FROM resolution_cases WHERE id=?",
    ).get(directive.case_id) as CaseRow | null;
    if (!caseRow) return { verified: false, reason: "CASE_MISSING" };
    if (caseRow.case_hash !== directive.case_hash) return { verified: false, reason: "CASE_HASH_MISMATCH" };

    // Recompute the case authority hash from its projection: a tampered
    // case_json / case_hash pair (the case authority bytes) is rejected.
    if (!this.caseHashConsistent(caseRow)) return { verified: false, reason: "CASE_TAMPERED" };
    if (!RESOLVED_CASE_STATES.has(caseRow.state)) return { verified: false, reason: "CASE_NOT_RESOLVED" };

    const source = this.db.query("SELECT id FROM engineer_runs WHERE id=?").get(caseRow.source_run_id) as { id: string } | null;
    if (!source) return { verified: false, reason: "SOURCE_RUN_MISSING" };

    return {
      verified: true,
      replacementRunId: candidateRunId,
      replacementId: replacement.id,
      caseId: caseRow.id,
      directiveId: directive.id,
      sourceRunId: caseRow.source_run_id,
      kind,
    };
  }

  /**
   * P8 `CompanionLineageVerifier` seam. Returns a bare boolean (fail closed on
   * any thrown error) so the publication draft can consume it unchanged. Only
   * the replacement run identity is authority-bearing here; P8 binds the
   * checkpoint/selection identity separately.
   */
  verifyReplacementLineage(input: CompanionLineageVerifierInput): boolean {
    try {
      return this.verify(input.candidateRunId).verified;
    } catch {
      return false;
    }
  }

  private verifyDirectiveIntegrity(directive: DirectiveRow, expectedHash: string): LineageRejectReason | null {
    let content: Record<string, unknown>;
    try {
      const parsed = JSON.parse(directive.directive_json) as Record<string, unknown>;
      // The signed content is the directive projection minus its own identity fields.
      const { directiveId: _id, directiveHash: _hash, ...rest } = parsed;
      content = rest;
    } catch {
      return "DIRECTIVE_TAMPERED";
    }
    const recomputedHash = sha256(content);
    if (recomputedHash !== expectedHash) return "DIRECTIVE_TAMPERED";
    const expectedSignature = createHmac("sha256", this.signingSecret).update(expectedHash, "utf8").digest("hex");
    if (!constantTimeEquals(expectedSignature, directive.signature)) return "DIRECTIVE_SIGNATURE_INVALID";
    return null;
  }

  private caseHashConsistent(caseRow: CaseRow): boolean {
    try {
      const parsed = JSON.parse(caseRow.case_json) as Record<string, unknown>;
      if (parsed.caseHash !== caseRow.case_hash) return false;
      const { caseHash: _drop, ...unhashed } = parsed;
      return sha256(unhashed) === caseRow.case_hash;
    } catch {
      return false;
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Exported for callers that only need the canonical rejection vocabulary. */
export function isLineageVerified(verdict: LineageVerdict): verdict is { verified: true } & LineageChain {
  return verdict.verified;
}
