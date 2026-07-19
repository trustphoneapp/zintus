import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BlockerSections,
  FreshBudgetForm,
  ResolutionActionError,
  ResolutionCaseStopReason,
  ResolutionDecisions,
  ResolutionEmptyState,
  ResolutionErrorState,
  ResolutionSpendingSummary,
  ResolutionTerminalSummary,
  ReverifyEligibilityNotice,
  RunBudgetSpendSummary,
  humanizeResolutionCode,
  resolutionErrorDetail,
} from "../app/(app)/engineer/resolution/ResolutionDeskControls";
import { ResolutionApiError, type CanonicalBlocker, type ResolutionCase, type ResolutionSpending } from "./engineer-resolution";
import type { EngineerBudgetSnapshot } from "./engineer";

const spending: ResolutionSpending = { sourceActualUsd: 1, priorReplacementActualUsd: 0.5, ambiguousLiabilityUsd: 0.2, cumulativeCeilingUsd: 5 };

const blockers: CanonicalBlocker[] = [
  { blockerId: "b1", kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED", description: "The required auth test failed on the source run." },
  { blockerId: "b2", kind: "ADVISORY", reasonCode: "STYLE_NIT", description: "Prefer const over let here.", sourceRef: "src/auth.ts:42" },
];

const openCase: ResolutionCase = {
  caseId: "case_1",
  runId: "run_1",
  caseVersion: 2,
  state: "OPEN",
  blockers,
  correctionEligible: true,
  reverifyEligibility: { eligible: false, reason: "SOURCE_CLASS_EXCLUDED" },
  spending,
  pricingPolicyDigest: `sha256:${"d".repeat(64)}`,
  createdAt: "2026-07-19T00:00:00.000Z",
  expiresAt: "2026-07-20T00:00:00.000Z",
};

describe("humanizeResolutionCode", () => {
  it("gives bespoke plain-language copy for the two codes the contract names", () => {
    expect(humanizeResolutionCode("PHASE3_UNEXPECTED_FAILURE")).toContain("Phase 3 verification");
    expect(humanizeResolutionCode("SOURCE_CLASS_EXCLUDED")).toContain("optional-hardening");
  });

  it("still renders unknown codes, humanized, rather than dropping them", () => {
    expect(humanizeResolutionCode("SOME_FUTURE_CODE")).toBe("Some Future Code");
  });
});

describe("ResolutionCaseStopReason — exact stop reason", () => {
  it("renders every blocking blocker's server-authored description verbatim, not a paraphrase", () => {
    const markup = renderToStaticMarkup(<ResolutionCaseStopReason resolutionCase={openCase} />);
    expect(markup).toContain("The required auth test failed on the source run.");
    expect(markup).toContain("REQUIRED_TEST_FAILED");
    expect(markup).not.toContain("Prefer const over let here."); // advisory, not a stop reason
  });

  it("shows a plain message when no blocking blockers remain", () => {
    const markup = renderToStaticMarkup(<ResolutionCaseStopReason resolutionCase={{ ...openCase, blockers: [blockers[1]!] }} />);
    expect(markup).toContain("No blocking blockers remain");
  });
});

describe("BlockerSections — required vs advisory in separate sections", () => {
  it("splits blocking and advisory blockers into two labeled columns with correct counts", () => {
    const markup = renderToStaticMarkup(<BlockerSections blockers={blockers} />);
    expect(markup).toContain("Required — 1");
    expect(markup).toContain("Advisory — 1");
    expect(markup).toContain("src/auth.ts:42");
  });

  it("renders 'None.' for an empty side rather than omitting the section", () => {
    const markup = renderToStaticMarkup(<BlockerSections blockers={[blockers[0]!]} />);
    expect(markup).toContain("Advisory — 0");
    expect(markup).toContain("None.");
  });
});

describe("ReverifyEligibilityNotice — typed reason when ineligible", () => {
  it("shows the ineligible state with its exact reason code and a humanized explanation", () => {
    const markup = renderToStaticMarkup(<ReverifyEligibilityNotice eligibility={{ eligible: false, reason: "SOURCE_CLASS_EXCLUDED" }} />);
    expect(markup).toContain("Reverify not eligible");
    expect(markup).toContain("SOURCE_CLASS_EXCLUDED");
    expect(markup).toContain("optional-hardening");
  });

  it("shows the eligible state with its typed transient cause", () => {
    const markup = renderToStaticMarkup(<ReverifyEligibilityNotice eligibility={{ eligible: true, reason: "PHASE3_UNEXPECTED_FAILURE" }} />);
    expect(markup).toContain("Reverify eligible");
    expect(markup).toContain("PHASE3_UNEXPECTED_FAILURE");
  });
});

describe("ResolutionSpendingSummary and RunBudgetSpendSummary — distinct spend figures", () => {
  it("renders sourceActual, priorReplacementActual, ambiguousLiability, and cumulativeCeiling as four distinct figures", () => {
    const markup = renderToStaticMarkup(<ResolutionSpendingSummary spending={spending} />);
    expect(markup).toContain("$1.00");
    expect(markup).toContain("$0.50");
    expect(markup).toContain("$0.20");
    expect(markup).toContain("$5.00");
  });

  it("renders the run's reserved/settled/uncertain/remaining budget as distinct figures, not fake percentages", () => {
    const budget: EngineerBudgetSnapshot = {
      runId: "run_1", status: "ACTIVE",
      limits: { costUsd: 5, tokens: 300_000, timeSeconds: 3_600 },
      lifetimeLimits: { costUsd: 5, tokens: 300_000, timeSeconds: 3_600 },
      used: { costUsd: 1, tokens: 10_000, timeSeconds: 100 },
      reserved: { costUsd: 0.3, tokens: 5_000 },
      ambiguous: { costUsd: 0.1, tokens: 1_000 },
      remaining: { costUsd: 3.7, tokens: 285_000, timeSeconds: 3_500 },
      warningThreshold: 0.8, pauseReason: null, resumeState: null, topUpPendingResume: false, revision: 1, updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(<RunBudgetSpendSummary budget={budget} />);
    expect(markup).toContain("$1.00"); // settled
    expect(markup).toContain("$0.20"); // active reserved = reserved(0.3) - ambiguous(0.1)
    expect(markup).toContain("awaiting provider reconciliation");
    expect(markup).toContain("$3.70"); // remaining
    expect(markup).not.toMatch(/%\s*complete/i);
  });
});

describe("FreshBudgetForm — client-side ceiling pre-validation mirrors, never replaces, the server rule", () => {
  it("shows no warning when the projected total is within the cumulative ceiling", () => {
    const markup = renderToStaticMarkup(<FreshBudgetForm value={{ maxCostUsd: 2, maxTokens: 1000, maxActiveSeconds: 60 }} onChange={() => {}} spending={spending} disabled={false} />);
    expect(markup).not.toContain("CEILING_EXCEEDED");
  });

  it("warns, citing the exact server error code, when the projected total would exceed the ceiling", () => {
    const markup = renderToStaticMarkup(<FreshBudgetForm value={{ maxCostUsd: 10, maxTokens: 1000, maxActiveSeconds: 60 }} onChange={() => {}} spending={spending} disabled={false} />);
    expect(markup).toContain("CEILING_EXCEEDED");
    expect(markup).toContain("role=\"alert\"");
  });

  it("states the budget is fresh, human-set authority — never inherited", () => {
    const markup = renderToStaticMarkup(<FreshBudgetForm value={{ maxCostUsd: 1, maxTokens: 1, maxActiveSeconds: 1 }} onChange={() => {}} spending={spending} disabled={false} />);
    expect(markup).toContain("never inherited");
  });
});

describe("ResolutionDecisions — three decisions with consequences, gated by real eligibility", () => {
  const baseProps = {
    resolutionCase: openCase,
    pendingAction: null,
    disabled: false,
    correctedEstimate: { lowerUsd: 0.2, upperUsd: 0.8 },
    budgetValue: { maxCostUsd: 1, maxTokens: 1000, maxActiveSeconds: 60 },
    onBudgetChange: () => {},
    onCorrected: () => {},
    onReverify: () => {},
    onRejectClose: () => {},
  };

  it("renders all three decisions with consequence text and the corrected-run estimate", () => {
    const markup = renderToStaticMarkup(<ResolutionDecisions {...baseProps} pricingPolicyDigestAvailable />);
    expect(markup).toContain("Corrected run");
    expect(markup).toContain("Reverify");
    expect(markup).toContain("Reject and close");
    expect(markup).toContain("$0.20");
    expect(markup).toContain("$0.80");
    expect(markup).toContain("Closes this case with no replacement run.");
  });

  it("disables the reverify button when reverifyEligibility.eligible is false", () => {
    const markup = renderToStaticMarkup(<ResolutionDecisions {...baseProps} pricingPolicyDigestAvailable />);
    const reverifyButtonMatch = markup.match(/<button[^>]*>Create reverify run<\/button>/);
    expect(reverifyButtonMatch?.[0]).toContain("disabled");
  });

  it("blocks the corrected-run submit and explains why when the case has not reported a pricing-policy digest yet", () => {
    const markup = renderToStaticMarkup(<ResolutionDecisions {...baseProps} pricingPolicyDigestAvailable={false} />);
    expect(markup).toContain("has not reported a pricing-policy digest yet");
    const correctedButtonMatch = markup.match(/<button[^>]*>Create corrected run<\/button>/);
    expect(correctedButtonMatch?.[0]).toContain("disabled");
  });

  it("disables the corrected-run submit when the case is not correction-eligible, independent of the digest", () => {
    const markup = renderToStaticMarkup(<ResolutionDecisions {...baseProps} pricingPolicyDigestAvailable resolutionCase={{ ...openCase, correctionEligible: false }} />);
    expect(markup).toContain("Not eligible: this case has no correction-eligible blockers.");
  });

  it("shows the 'Applying…' pending state on the specific decision in flight, not the others", () => {
    const markup = renderToStaticMarkup(<ResolutionDecisions {...baseProps} pricingPolicyDigestAvailable pendingAction="resolution:reject-close" />);
    expect(markup).toContain("Applying…");
    expect(markup).toContain("Create reverify run"); // unaffected sibling keeps its normal label
  });
});

describe("resolutionErrorDetail — Resolution Desk error-surface parity with Approval/publication", () => {
  const apiError = (code: string | null, conflict: { expected: unknown; actual: unknown } | null = null, message = "server said no") =>
    new ResolutionApiError(409, message, code, conflict, null);

  it("CEILING_EXCEEDED states nothing new was spent", () => {
    const detail = resolutionErrorDetail(apiError("CEILING_EXCEEDED"));
    expect(detail.code).toBe("CEILING_EXCEEDED");
    expect(detail.cause).toContain("cumulative ceiling");
    expect(detail.nextAction).toContain("Lower");
    expect(detail.spent).toContain("Nothing new");
  });

  it("DIRECTIVE_EXPIRED states nothing was spent from the expired directive", () => {
    const detail = resolutionErrorDetail(apiError("DIRECTIVE_EXPIRED"));
    expect(detail.code).toBe("DIRECTIVE_EXPIRED");
    expect(detail.cause).toContain("TTL elapsed");
    expect(detail.spent).toContain("Nothing");
  });

  it("PRICING_POLICY_DRIFT tells the user to reload for the current digest", () => {
    const detail = resolutionErrorDetail(apiError("PRICING_POLICY_DRIFT"));
    expect(detail.code).toBe("PRICING_POLICY_DRIFT");
    expect(detail.cause).toContain("pricing policy changed");
    expect(detail.nextAction).toContain("Reload the case");
  });

  it("CASE_VERSION_CONFLICT interpolates the expected/actual conflict when present", () => {
    const detail = resolutionErrorDetail(apiError("CASE_VERSION_CONFLICT", { expected: 3, actual: 4 }));
    expect(detail.code).toBe("CASE_VERSION_CONFLICT");
    expect(detail.cause).toContain("expected version 3");
    expect(detail.cause).toContain("server has 4");
  });

  it("CASE_VERSION_CONFLICT still renders a sensible cause without a conflict payload", () => {
    const detail = resolutionErrorDetail(apiError("CASE_VERSION_CONFLICT"));
    expect(detail.cause).toContain("changed since it was last loaded");
  });

  it("IDEMPOTENCY_CONFLICT honestly states spend is unknown from this screen alone", () => {
    const detail = resolutionErrorDetail(apiError("IDEMPOTENCY_CONFLICT"));
    expect(detail.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(detail.spent).toContain("Unknown from this screen alone");
  });

  it("an unrecognized code with a conflict payload still surfaces the conflict, not a generic message", () => {
    const detail = resolutionErrorDetail(apiError("SOME_NEW_CODE", { expected: "a", actual: "b" }));
    expect(detail.cause).toContain('expected "a"');
    expect(detail.cause).toContain('server has "b"');
  });

  it("an unrecognized code with no conflict payload renders humanized, honest fallback copy — never dropped", () => {
    const detail = resolutionErrorDetail(apiError("SOME_NEW_CODE"));
    expect(detail.cause).toContain("Reason not further specified");
    expect(detail.spent).toContain("Unknown from this screen alone");
    expect(detail.code).toBe("SOME_NEW_CODE");
  });

  it("a non-API error (network/client failure) is handled without throwing and states spend is unknown", () => {
    const detail = resolutionErrorDetail(new Error("network down"));
    expect(detail.message).toBe("network down");
    expect(detail.spent).toContain("Unknown from this screen alone");
  });

  it("ResolutionActionError renders the mapped detail through the shared ActionErrorNotice", () => {
    const markup = renderToStaticMarkup(<ResolutionActionError error={apiError("CEILING_EXCEEDED")} />);
    expect(markup).toContain("CEILING_EXCEEDED");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Safe next action");
    expect(markup).toContain("Was anything spent?");
  });
});

describe("Resolution Desk terminal / empty / error states", () => {
  it("empty state offers to start a case and shows an 'Applying' equivalent while starting", () => {
    const idle = renderToStaticMarkup(<ResolutionEmptyState onStart={() => {}} starting={false} />);
    expect(idle).toContain("Start resolution case");
    const starting = renderToStaticMarkup(<ResolutionEmptyState onStart={() => {}} starting />);
    expect(starting).toContain("Starting…");
  });

  it("error state surfaces the message with an alert role", () => {
    const markup = renderToStaticMarkup(<ResolutionErrorState message="The Resolution Desk is unavailable" />);
    expect(markup).toContain("The Resolution Desk is unavailable");
    expect(markup).toContain('role="alert"');
  });

  it("terminal state links to the replacement run when one exists and states no further mutation is possible", () => {
    const withReplacement = renderToStaticMarkup(<ResolutionTerminalSummary resolutionCase={{ ...openCase, state: "RESOLVED_CORRECTED" }} replacementRunId="run_2" />);
    expect(withReplacement).toContain("/engineer?run=run_2");
    expect(withReplacement).toContain("No further mutation is possible");
  });

  it("terminal state for reject/close renders without a replacement-run link", () => {
    const rejected = renderToStaticMarkup(<ResolutionTerminalSummary resolutionCase={{ ...openCase, state: "REJECTED_CLOSED" }} replacementRunId={null} />);
    expect(rejected).not.toContain("Open the replacement run");
  });
});

describe("Resolution Desk responsive/reduced-motion style contract", () => {
  const css = readFileSync(join(import.meta.dir, "..", "app", "globals.css"), "utf8");

  it("collapses the two-column blocker grid at the 1024px breakpoint", () => {
    expect(css).toMatch(/@media \(max-width: 1024px\)[^{]*\{[^}]*\.engineer-resolution-blocker-columns[^}]*grid-template-columns:\s*1fr/);
  });

  it("collapses the three-column budget form at the 720px breakpoint", () => {
    expect(css).toMatch(/@media \(max-width: 720px\)[^{]*\{[^}]*\.engineer-resolution-budget-form[^}]*grid-template-columns:\s*1fr/);
  });

  it("inherits the shell-wide reduced-motion rule (every .engineer-screen descendant, including these new screens)", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .engineer-screen * { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; } }");
  });
});
