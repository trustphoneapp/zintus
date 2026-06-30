/**
 * Per-artifact consent + spend quota — pure, DOM-free, unit-tested.
 *
 * The two deferred canvas features both let *model-authored* or *automated* code
 * spend the user's BYOK tokens: cheap-routed targeted edits, and the in-artifact
 * runtime LLM bridge (`postMessage` → router). The research was unambiguous —
 * neither ships without (a) explicit user consent before any spend and (b) a hard
 * per-artifact budget + rate limit, because a hostile or runaway artifact could
 * otherwise drain the key. This module is that gate: a deterministic decision
 * function plus immutable budget/consent records the UI and the bridge call
 * through. It never spends or calls anything itself — it only decides + records.
 */

/** A per-artifact spending budget within a rolling rate window. Immutable. */
export interface ArtifactBudget {
  /** Hard ceiling on TOTAL spend for this artifact (USD). */
  capUsd: number;
  /** Spent so far against the cap (USD). */
  spentUsd: number;
  /** Calls counted in the current rate window. */
  windowCalls: number;
  /** Epoch ms the current rate window started. */
  windowStartedAt: number;
}

/** Per-artifact consent the user granted for spends. */
export interface ArtifactConsent {
  /** The user explicitly allowed this artifact to spend. */
  granted: boolean;
  /** Spends at or below this run without a fresh confirm prompt (USD). */
  autoApproveUnderUsd?: number;
}

export type SpendDecision =
  | { allow: true; needsConfirm: boolean }
  | { allow: false; reason: "over-cap" | "rate-limited" | "no-consent" };

export const DEFAULT_ARTIFACT_CAP_USD = 0.5;
export const DEFAULT_RATE_LIMIT = 20; // calls per window
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/** A fresh budget. `capUsd` is clamped non-negative. */
export function newArtifactBudget(
  capUsd: number = DEFAULT_ARTIFACT_CAP_USD,
  now: number = Date.now(),
): ArtifactBudget {
  return {
    capUsd: Math.max(0, capUsd),
    spentUsd: 0,
    windowCalls: 0,
    windowStartedAt: now,
  };
}

/** Headroom left under the cap (never negative). */
export function remainingUsd(b: ArtifactBudget): number {
  return Math.max(0, b.capUsd - b.spentUsd);
}

interface DecideOpts {
  now?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  /** When false, consent isn't required (e.g. a user-initiated, already-confirmed
   *  re-bake). Defaults true — the safe posture for automated/bridge spends. */
  requireConsent?: boolean;
}

/**
 * Decide whether an ESTIMATED spend may proceed. Order of checks: over-cap →
 * rate-limited → consent. A granted spend still returns `needsConfirm` unless it
 * is at/under the user's auto-approve threshold. An expired rate window counts as
 * zero prior calls. `estUsd` is clamped non-negative.
 */
export function decideSpend(
  budget: ArtifactBudget,
  consent: ArtifactConsent,
  estUsd: number,
  opts?: DecideOpts,
): SpendDecision {
  const now = opts?.now ?? Date.now();
  const rateLimit = opts?.rateLimit ?? DEFAULT_RATE_LIMIT;
  const rateWindowMs = opts?.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const requireConsent = opts?.requireConsent ?? true;
  const est = Math.max(0, estUsd);

  if (budget.spentUsd + est > budget.capUsd) {
    return { allow: false, reason: "over-cap" };
  }

  const windowExpired = now - budget.windowStartedAt >= rateWindowMs;
  const effectiveCalls = windowExpired ? 0 : budget.windowCalls;
  if (effectiveCalls >= rateLimit) {
    return { allow: false, reason: "rate-limited" };
  }

  if (requireConsent && !consent.granted) {
    return { allow: false, reason: "no-consent" };
  }

  const autoApprove =
    consent.autoApproveUnderUsd != null && est <= consent.autoApproveUnderUsd;
  return { allow: true, needsConfirm: !autoApprove };
}

/**
 * Record an ACTUAL spend and count one call, returning a new budget. Rolls the
 * rate window when it has elapsed. `actualUsd` is clamped non-negative. This does
 * NOT enforce the cap (call {@link decideSpend} first) — it's the post-call ledger
 * update, and a real charge can legitimately differ from the estimate.
 */
export function applySpend(
  budget: ArtifactBudget,
  actualUsd: number,
  now: number = Date.now(),
  rateWindowMs: number = DEFAULT_RATE_WINDOW_MS,
): ArtifactBudget {
  const rolled = now - budget.windowStartedAt >= rateWindowMs;
  return {
    capUsd: budget.capUsd,
    spentUsd: budget.spentUsd + Math.max(0, actualUsd),
    windowCalls: (rolled ? 0 : budget.windowCalls) + 1,
    windowStartedAt: rolled ? now : budget.windowStartedAt,
  };
}

/** Grant (or update) consent for an artifact. */
export function grantConsent(autoApproveUnderUsd?: number): ArtifactConsent {
  return { granted: true, ...(autoApproveUnderUsd != null ? { autoApproveUnderUsd } : {}) };
}

/** Revoked / never-granted consent. */
export const NO_CONSENT: ArtifactConsent = { granted: false };

/** Human reason for a blocked decision (for the UI). */
export function denyReasonText(reason: Exclude<SpendDecision, { allow: true }>["reason"]): string {
  switch (reason) {
    case "over-cap":
      return "This would exceed the artifact's spending cap.";
    case "rate-limited":
      return "Too many calls from this artifact — try again shortly.";
    case "no-consent":
      return "Allow this artifact to spend tokens first.";
  }
}
