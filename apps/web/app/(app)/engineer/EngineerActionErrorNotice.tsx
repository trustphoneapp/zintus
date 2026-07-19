"use client";

/**
 * Shared error-surface contract for both P9 screens: every mutation error
 * states its cause, a safe next action, and whether anything was spent —
 * never a bare failure string. Introduced for the Approval/publication
 * screen (SELF_APPROVAL, PREFLIGHT_MISMATCH) and reused by the Resolution
 * Desk (CEILING_EXCEEDED, DIRECTIVE_EXPIRED, PRICING_POLICY_DRIFT,
 * CASE_VERSION_CONFLICT, IDEMPOTENCY_CONFLICT) for parity — see the P9
 * slice-2 report.
 */
export interface ActionErrorDetail {
  message: string;
  cause: string;
  nextAction: string;
  spent: string;
  code?: string | null;
}

export function ActionErrorNotice({ message, cause, nextAction, spent, code }: ActionErrorDetail) {
  return (
    <section className="engineer-card engineer-action-error" role="alert">
      <p className="engineer-error">{message}{code ? <code> {code}</code> : null}</p>
      <dl className="engineer-action-error-detail">
        <div><dt>Cause</dt><dd>{cause}</dd></div>
        <div><dt>Safe next action</dt><dd>{nextAction}</dd></div>
        <div><dt>Was anything spent?</dt><dd>{spent}</dd></div>
      </dl>
    </section>
  );
}
