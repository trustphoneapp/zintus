const CORRECTABLE_TERMINAL_STATES = new Set([
  "SECURITY_ESCALATION",
  "VERIFICATION_INCOMPLETE",
  "REJECTED",
  "FAILED",
]);

export interface EngineerCorrectionFinding {
  status?: string;
}

export interface EngineerCorrectionFailure {
  failureClass?: string;
  reasonCode?: string;
}

export type EngineerCorrectionRecovery = "corrected-run" | "new-bounded-run" | null;

/** Mirrors the gateway's fail-closed structured-correction eligibility policy. */
export function engineerCorrectionRecovery(
  state: string,
  findings: readonly EngineerCorrectionFinding[],
  failures: readonly EngineerCorrectionFailure[],
): EngineerCorrectionRecovery {
  if (!CORRECTABLE_TERMINAL_STATES.has(state)) return null;
  const hasOpenSecurityFinding = findings.some((finding) => finding.status === "OPEN");
  const hasVerificationFailure = failures.some((failure) =>
    failure.failureClass === "TEST_FAILURE" || /TEST|VERIFICATION/.test(failure.reasonCode ?? ""),
  );
  return hasOpenSecurityFinding || hasVerificationFailure ? "corrected-run" : "new-bounded-run";
}
