"use client";

import type { EngineerBudgetSnapshot } from "@/lib/engineer";
import {
  PRICING_POLICY_DIGEST_UNAVAILABLE,
  ResolutionApiError,
  projectsWithinCumulativeCeiling,
  type CanonicalBlocker,
  type ReplacementBudget,
  type ResolutionCase,
  type ResolutionSpending,
} from "@/lib/engineer-resolution";
import { ActionErrorNotice, type ActionErrorDetail } from "../EngineerActionErrorNotice";

/**
 * Reason codes are server-authored and, per PHASE-CONTRACTS-P7-P10.md §2,
 * come from an open set (TypedTransientCause | IneligibleReason). Only the
 * two codes the contract text actually names get bespoke copy; every other
 * code still renders — humanized, never dropped or replaced with a generic
 * "unavailable" placeholder.
 */
const KNOWN_REASON_COPY: Record<string, string> = {
  PHASE3_UNEXPECTED_FAILURE: "Typed as a closed transient failure class during Phase 3 verification.",
  SOURCE_CLASS_EXCLUDED: "This source is an optional-hardening / v2 source, excluded from reverify eligibility in this release.",
};

export function humanizeResolutionCode(code: string): string {
  if (KNOWN_REASON_COPY[code]) return KNOWN_REASON_COPY[code];
  return code.split("_").filter(Boolean).map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" ");
}

const CASE_STATE_COPY: Record<ResolutionCase["state"], string> = {
  OPEN: "Open — awaiting your decision",
  DIRECTIVE_ISSUED: "Directive issued — preparing to apply",
  APPLYING: "Applying — creating the replacement run",
  RESOLVED_CORRECTED: "Resolved — corrected run created",
  RESOLVED_REVERIFIED: "Resolved — reverify run created",
  REJECTED_CLOSED: "Rejected and closed — no replacement run",
};

export function humanizeResolutionCaseState(state: ResolutionCase["state"]): string {
  return CASE_STATE_COPY[state];
}

/** The verbatim server-authored stop reason: every blocking blocker's own description, never paraphrased. */
export function ResolutionCaseStopReason({ resolutionCase }: { resolutionCase: ResolutionCase }) {
  const blocking = resolutionCase.blockers.filter((blocker) => blocker.kind === "BLOCKING");
  return (
    <section className="engineer-card engineer-resolution-stop-reason" aria-labelledby="resolution-stop-reason-heading">
      <div className="engineer-card-heading">
        <div>
          <span className="engineer-kicker">Stop reason</span>
          <h2 id="resolution-stop-reason-heading">{humanizeResolutionCaseState(resolutionCase.state)}</h2>
        </div>
        <span className="engineer-chip">Case v{resolutionCase.caseVersion}</span>
      </div>
      {blocking.length
        ? <ul className="engineer-resolution-blocker-list">
            {blocking.map((blocker) => <li key={blocker.blockerId}><code>{blocker.reasonCode}</code><p>{blocker.description}</p></li>)}
          </ul>
        : <p className="engineer-muted">No blocking blockers remain on this case.</p>}
    </section>
  );
}

export function BlockerSections({ blockers }: { blockers: CanonicalBlocker[] }) {
  const required = blockers.filter((blocker) => blocker.kind === "BLOCKING");
  const advisory = blockers.filter((blocker) => blocker.kind === "ADVISORY");
  return (
    <section className="engineer-card engineer-resolution-blockers" aria-labelledby="resolution-blockers-heading">
      <h2 id="resolution-blockers-heading">Blockers and recommendations</h2>
      <div className="engineer-resolution-blocker-columns">
        <div aria-labelledby="resolution-required-heading">
          <h3 id="resolution-required-heading">Required — {required.length}</h3>
          {required.length
            ? <ul className="engineer-resolution-blocker-list">{required.map((blocker) => <li key={blocker.blockerId}><code>{blocker.reasonCode}</code><p>{blocker.description}</p>{blocker.sourceRef ? <small>{blocker.sourceRef}</small> : null}</li>)}</ul>
            : <p className="engineer-muted">None.</p>}
        </div>
        <div aria-labelledby="resolution-advisory-heading">
          <h3 id="resolution-advisory-heading">Advisory — {advisory.length}</h3>
          {advisory.length
            ? <ul className="engineer-resolution-blocker-list engineer-resolution-blocker-list--advisory">{advisory.map((blocker) => <li key={blocker.blockerId}><code>{blocker.reasonCode}</code><p>{blocker.description}</p>{blocker.sourceRef ? <small>{blocker.sourceRef}</small> : null}</li>)}</ul>
            : <p className="engineer-muted">None.</p>}
        </div>
      </div>
    </section>
  );
}

export function ReverifyEligibilityNotice({ eligibility }: { eligibility: ResolutionCase["reverifyEligibility"] }) {
  return (
    <p className={`engineer-resolution-eligibility engineer-resolution-eligibility--${eligibility.eligible ? "eligible" : "ineligible"}`} role="status">
      {eligibility.eligible ? "Reverify eligible" : "Reverify not eligible"} — {humanizeResolutionCode(eligibility.reason)}
      {" "}<code>{eligibility.reason}</code>
    </p>
  );
}

export function ResolutionSpendingSummary({ spending }: { spending: ResolutionSpending }) {
  return (
    <section className="engineer-card engineer-evidence-grid" aria-label="Resolution case spending">
      <Metric label="Source run spend (settled)" value={`$${spending.sourceActualUsd.toFixed(2)}`} />
      <Metric label="Prior replacement spend (settled)" value={`$${spending.priorReplacementActualUsd.toFixed(2)}`} />
      <Metric label="Ambiguous liability (uncertain)" value={`$${spending.ambiguousLiabilityUsd.toFixed(2)}`} />
      <Metric label="Cumulative ceiling" value={`$${spending.cumulativeCeilingUsd.toFixed(2)}`} />
    </section>
  );
}

/**
 * The source run's own reserved/settled/uncertain figures (the existing
 * EngineerBudgetSnapshot). Anything that is neither still reserved nor
 * ambiguous has already been released back into "Settled" — this module
 * does not invent a separate "released" ledger line the API does not
 * expose (see the P9 slice-1 report's contract-clarification note on §4).
 */
export function RunBudgetSpendSummary({ budget }: { budget: EngineerBudgetSnapshot }) {
  const activeReservedCost = Math.max(0, budget.reserved.costUsd - budget.ambiguous.costUsd);
  return (
    <section className="engineer-card engineer-evidence-grid" aria-label="Source run budget">
      <Metric label="Settled" value={`$${budget.used.costUsd.toFixed(2)}`} />
      <Metric label="Reserved (active)" value={`$${activeReservedCost.toFixed(2)}`} />
      <Metric label="Uncertain" value={budget.ambiguous.costUsd > 0 ? `$${budget.ambiguous.costUsd.toFixed(2)} awaiting provider reconciliation` : "$0.00"} />
      <Metric label="Remaining" value={`$${budget.remaining.costUsd.toFixed(2)}`} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>;
}

export interface FreshBudgetFormValue { maxCostUsd: number; maxTokens: number; maxActiveSeconds: number }

export function FreshBudgetForm({ value, onChange, spending, disabled }: {
  value: FreshBudgetFormValue;
  onChange: (next: FreshBudgetFormValue) => void;
  spending: ResolutionSpending;
  disabled: boolean;
}) {
  const withinCeiling = projectsWithinCumulativeCeiling(spending, value.maxCostUsd);
  return (
    <div className="engineer-resolution-budget-form">
      <label>Fresh cost cap (USD)
        <input type="number" min={0} step={0.5} value={value.maxCostUsd} disabled={disabled}
          onChange={(event) => onChange({ ...value, maxCostUsd: Number(event.target.value) })} />
      </label>
      <label>Fresh token cap
        <input type="number" min={0} step={1000} value={value.maxTokens} disabled={disabled}
          onChange={(event) => onChange({ ...value, maxTokens: Number(event.target.value) })} />
      </label>
      <label>Fresh active-seconds cap
        <input type="number" min={0} step={60} value={value.maxActiveSeconds} disabled={disabled}
          onChange={(event) => onChange({ ...value, maxActiveSeconds: Number(event.target.value) })} />
      </label>
      {!withinCeiling
        ? <p className="engineer-error" role="alert">This cap would push prior actual + ambiguous + new cap past the cumulative ceiling (${spending.cumulativeCeilingUsd.toFixed(2)}). The server will reject this with CEILING_EXCEEDED; lower the cap before submitting.</p>
        : null}
      <p className="engineer-muted">This budget is fresh, human-set authority — it is never inherited from the source or any prior replacement run.</p>
    </div>
  );
}

/**
 * §5a S1 wires pricingPolicyDigest from the case itself. This throws rather
 * than building a budget with the client-only "unavailable" sentinel — the
 * corrected-run submit path is gated on `pricingPolicyDigestAvailable` in
 * `ResolutionDecisions` precisely so this can never be reached with an
 * empty digest from the real UI, but the guard stays fail-closed by
 * construction rather than trusting the caller.
 */
export function replacementBudgetFrom(value: FreshBudgetFormValue, pricingPolicyDigest: string): ReplacementBudget {
  if (!pricingPolicyDigest || pricingPolicyDigest === PRICING_POLICY_DIGEST_UNAVAILABLE) {
    throw new Error("Refusing to build a ReplacementBudget without a real pricing-policy digest.");
  }
  return { maxCostUsd: value.maxCostUsd, maxTokens: value.maxTokens, maxActiveSeconds: value.maxActiveSeconds, pricingPolicyDigest };
}

/**
 * Structured cause/next-action/spend detail for Resolution Desk mutation
 * errors, matching the treatment the Approval/publication screen already
 * has for SELF_APPROVAL/PREFLIGHT_MISMATCH (parity requested in the P9
 * slice-2 follow-up). Every code below either directly reflects §2's own
 * text or one of §5a S1's clarifications; an unrecognized code still
 * renders — humanized, with an honest "unknown from this screen" spend
 * line — rather than being dropped.
 */
export function resolutionErrorDetail(error: unknown): ActionErrorDetail {
  if (!(error instanceof ResolutionApiError)) {
    return {
      message: error instanceof Error ? error.message : "The action could not be completed.",
      cause: "An unexpected client-side or network failure occurred before the server could respond.",
      nextAction: "Reload the case and try again.",
      spent: "Unknown from this screen alone — no server response was received to confirm either way.",
    };
  }

  switch (error.code) {
    case "CEILING_EXCEEDED":
      return {
        message: error.message,
        cause: "This budget's cost cap would push prior actual + ambiguous spend past the case's cumulative ceiling.",
        nextAction: "Lower the fresh cost cap and resubmit.",
        spent: "Nothing new — the directive was rejected before any replacement run was created.",
        code: error.code,
      };
    case "DIRECTIVE_EXPIRED":
      return {
        message: error.message,
        cause: "The signed directive's fixed TTL elapsed before it was applied.",
        nextAction: "Choose the decision again to issue a fresh directive, then it applies immediately.",
        spent: "Nothing — no replacement run was created from the expired directive.",
        code: error.code,
      };
    case "PRICING_POLICY_DRIFT":
      return {
        message: error.message,
        cause: "The server's pricing policy changed after this screen last loaded the case's digest.",
        nextAction: "Reload the case to pick up the current pricing-policy digest, then resubmit.",
        spent: "Nothing — the directive was rejected before any replacement run was created.",
        code: error.code,
      };
    case "CASE_VERSION_CONFLICT":
      return {
        message: error.message,
        cause: error.conflict
          ? `This case changed since it was loaded (expected version ${JSON.stringify(error.conflict.expected)}, server has ${JSON.stringify(error.conflict.actual)}).`
          : "This case changed since it was last loaded — by another tab, another user, or a prior action of yours.",
        nextAction: "Reload the case to see its current state before deciding again.",
        spent: "Nothing new was created by this submission.",
        code: error.code,
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        message: error.message,
        cause: "This request's idempotency key was already used for a request with different bytes than this one.",
        nextAction: "Reload the case and retry as a fresh decision — do not resubmit the exact same click.",
        spent: "Unknown from this screen alone — check the case's event history before deciding again.",
        code: error.code,
      };
    default:
      if (error.conflict) {
        return {
          message: error.message,
          cause: `This case changed since it was loaded (expected ${JSON.stringify(error.conflict.expected)}, server has ${JSON.stringify(error.conflict.actual)}).`,
          nextAction: "Reload the case to see its current state before deciding again.",
          spent: "Nothing new was created by this submission.",
          code: error.code ?? undefined,
        };
      }
      return {
        message: error.message,
        cause: "Reason not further specified by the server.",
        nextAction: "Reload the case and retry; if this persists, treat it as a contract-change item for the integrator.",
        spent: "Unknown from this screen alone.",
        code: error.code ?? undefined,
      };
  }
}

export function ResolutionActionError({ error }: { error: unknown }) {
  return <ActionErrorNotice {...resolutionErrorDetail(error)} />;
}

export interface ResolutionDecisionsProps {
  resolutionCase: ResolutionCase;
  pendingAction: string | null;
  disabled: boolean;
  correctedEstimate: { lowerUsd: number; upperUsd: number } | null;
  budgetValue: FreshBudgetFormValue;
  onBudgetChange: (next: FreshBudgetFormValue) => void;
  pricingPolicyDigestAvailable: boolean;
  onCorrected: () => void;
  onReverify: () => void;
  onRejectClose: () => void;
}

/**
 * The three resolution decisions with their consequences stated inline.
 * `pricingPolicyDigestAvailable` reflects whether this case's own
 * `pricingPolicyDigest` (§5a S1) is present — the corrected-run budget
 * echoes it back verbatim. Absent only in the case that has not yet
 * reported one; the corrected-run submit stays disabled with an explicit
 * reason in that situation rather than sending a fabricated digest.
 */
export function ResolutionDecisions(props: ResolutionDecisionsProps) {
  const { resolutionCase, pendingAction, disabled, correctedEstimate, budgetValue, onBudgetChange, pricingPolicyDigestAvailable, onCorrected, onReverify, onRejectClose } = props;
  const withinCeiling = projectsWithinCumulativeCeiling(resolutionCase.spending, budgetValue.maxCostUsd);
  const correctedBlocked = disabled || !resolutionCase.correctionEligible || !withinCeiling || !pricingPolicyDigestAvailable;
  const reverifyBlocked = true;

  return (
    <section className="engineer-card engineer-resolution-decisions" aria-labelledby="resolution-decisions-heading">
      <h2 id="resolution-decisions-heading">Choose how to resolve this case</h2>
      <div className="engineer-decision-options" role="list">
        <div className={`engineer-decision-option${!resolutionCase.correctionEligible ? "" : " is-recommended"}`} role="listitem">
          <div className="engineer-decision-option-title"><strong>Corrected run</strong></div>
          <p>Creates a new replacement run that carries forward the request and acceptance criteria, addresses every open blocker in canonical order, and requires fresh verification. The source run and its evidence remain unchanged and immutable.</p>
          {correctedEstimate ? <small>Estimate: ${correctedEstimate.lowerUsd.toFixed(2)}–${correctedEstimate.upperUsd.toFixed(2)}</small> : null}
          <FreshBudgetForm value={budgetValue} onChange={onBudgetChange} spending={resolutionCase.spending} disabled={disabled || !resolutionCase.correctionEligible} />
          {!resolutionCase.correctionEligible ? <p className="engineer-muted">Not eligible: this case has no correction-eligible blockers.</p> : null}
          {!pricingPolicyDigestAvailable ? <p className="engineer-error" role="alert">Blocked: this case has not reported a pricing-policy digest yet. Reload the case; submission stays disabled until it has one.</p> : null}
          <button type="button" className="engineer-primary" disabled={correctedBlocked} onClick={onCorrected}>
            {pendingAction === "resolution:corrected" ? "Applying…" : "Create corrected run"}
          </button>
        </div>

        <div className="engineer-decision-option" role="listitem">
          <div className="engineer-decision-option-title"><strong>Reverify</strong></div>
          <p>Re-runs verification only, from the closed typed-transient allowlist. No corrective changes are made and no new budget is required.</p>
          <ReverifyEligibilityNotice eligibility={resolutionCase.reverifyEligibility} />
          <p className="engineer-muted">Coming next: reverify remains disabled until the retained candidate checkpoint is cryptographically bound to the replacement run.</p>
          <button type="button" disabled={reverifyBlocked} onClick={onReverify}>
            {pendingAction === "resolution:reverify" ? "Applying…" : "Create reverify run"}
          </button>
        </div>

        <div className="engineer-decision-option" role="listitem">
          <div className="engineer-decision-option-title"><strong>Reject and close</strong></div>
          <p>Closes this case with no replacement run. The source run and its evidence remain, but no further resolution action is possible from this case once closed.</p>
          <button type="button" className="danger" disabled={disabled} onClick={onRejectClose}>
            {pendingAction === "resolution:reject-close" ? "Applying…" : "Reject and close"}
          </button>
        </div>
      </div>
    </section>
  );
}

export function ResolutionEmptyState({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <section className="engineer-card engineer-gate">
      <div>
        <span className="engineer-kicker">Resolution Desk</span>
        <h2>No resolution case yet</h2>
        <p>This run has no open resolution case. Starting one installs a ledger-wide source freeze; do this only for a run that has actually stopped needing resolution — the server derives all eligibility server-side and will reject a case for a run that is not eligible.</p>
      </div>
      <button type="button" className="engineer-primary" disabled={starting} onClick={onStart}>{starting ? "Starting…" : "Start resolution case"}</button>
    </section>
  );
}

export function ResolutionErrorState({ message }: { message: string }) {
  return <section className="engineer-card"><p className="engineer-error" role="alert">{message}</p></section>;
}

export function ResolutionTerminalSummary({ resolutionCase, replacementRunId }: { resolutionCase: ResolutionCase; replacementRunId: string | null }) {
  return (
    <section className="engineer-card" aria-labelledby="resolution-terminal-heading">
      <span className="engineer-kicker">Resolved</span>
      <h2 id="resolution-terminal-heading">{humanizeResolutionCaseState(resolutionCase.state)}</h2>
      {replacementRunId ? <p><a href={`/engineer?run=${encodeURIComponent(replacementRunId)}`}>Open the replacement run →</a></p> : null}
      {/* R3 (Blocker 3): a resolved corrected/reverified replacement run is the
          new publication subject — hand off directly to the P8 Approval and
          publication screen scoped to that run. The screen shows an empty state
          until the replacement is verified and approvable, so this link is safe
          before the run reaches REVIEW_APPROVED. */}
      {replacementRunId ? <p><a href={`/engineer/publication?run=${encodeURIComponent(replacementRunId)}`}>Approve and publish the replacement →</a></p> : null}
      <p className="engineer-muted">This case is closed. No further mutation is possible from this screen.</p>
    </section>
  );
}
