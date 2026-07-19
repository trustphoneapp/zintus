import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApprovalRationaleControls,
  LineageBadge,
  PREFLIGHT_MISMATCH_ERROR,
  PublicationCandidateList,
  PublicationEmptyState,
  PublicationErrorNotice,
  PublicationErrorState,
  PublicationStateTimeline,
  SELF_APPROVAL_ERROR,
} from "../app/(app)/engineer/publication/PublicationControls";
import type { EngineerBudgetSnapshot } from "./engineer";
import type { PublicationCandidate } from "./engineer-resolution";

const original: PublicationCandidate = { checkpointId: "cp_1", checkpointHash: `sha256:${"a".repeat(64)}`, lineage: "ORIGINAL", lineageVerified: true };
const replacement: PublicationCandidate = { checkpointId: "cp_2", checkpointHash: `sha256:${"b".repeat(64)}`, lineage: "P7_REPLACEMENT", lineageVerified: false };

describe("LineageBadge — original vs P7 replacement, with a verified marker", () => {
  it("labels an original, verified candidate", () => {
    const markup = renderToStaticMarkup(<LineageBadge candidate={original} />);
    expect(markup).toContain("Original");
    expect(markup).toContain("Verified");
    expect(markup).not.toContain("Unverified");
  });

  it("labels a P7 replacement with an unverified-lineage warning", () => {
    const markup = renderToStaticMarkup(<LineageBadge candidate={replacement} />);
    expect(markup).toContain("P7 replacement");
    expect(markup).toContain("Unverified lineage");
  });
});

describe("PublicationCandidateList", () => {
  it("renders every candidate's lineage badge and full identifiers", () => {
    const markup = renderToStaticMarkup(<PublicationCandidateList candidates={[original, replacement]} selectedCheckpointId={null} onSelect={() => {}} />);
    expect(markup).toContain(original.checkpointId);
    expect(markup).toContain(replacement.checkpointId);
    expect(markup).toContain(original.checkpointHash);
  });

  it("marks the selected candidate with aria-pressed", () => {
    const markup = renderToStaticMarkup(<PublicationCandidateList candidates={[original, replacement]} selectedCheckpointId="cp_2" onSelect={() => {}} />);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("falls back to a plain empty message when there are no candidates", () => {
    const markup = renderToStaticMarkup(<PublicationCandidateList candidates={[]} selectedCheckpointId={null} onSelect={() => {}} />);
    expect(markup).toContain("No eligible publication candidates");
  });
});

describe("Self-approval and preflight-mismatch errors — cause, safe next action, and spend always stated", () => {
  it("self-approval error states nothing was spent", () => {
    const markup = renderToStaticMarkup(<PublicationErrorNotice {...SELF_APPROVAL_ERROR()} />);
    expect(markup).toContain("cannot approve your own request");
    expect(markup).toContain("SELF_APPROVAL");
    expect(markup).toContain("Nothing");
    expect(markup).toContain('role="alert"');
  });

  it("preflight-mismatch error states the approval was invalidated and nothing was spent", () => {
    const markup = renderToStaticMarkup(<PublicationErrorNotice {...PREFLIGHT_MISMATCH_ERROR()} />);
    expect(markup).toContain("PREFLIGHT_MISMATCH");
    expect(markup).toContain("invalidated");
    expect(markup).toContain("no remote change was made");
  });

  it("ApprovalRationaleControls surfaces the self-approval error inline next to the controls", () => {
    const markup = renderToStaticMarkup(<ApprovalRationaleControls pendingAction={null} disabled={false} rationale="" onRationaleChange={() => {}} selfApprovalError onApprove={() => {}} onReject={() => {}} />);
    expect(markup).toContain("cannot approve your own request");
  });

  it("ApprovalRationaleControls shows per-action pending labels", () => {
    const markup = renderToStaticMarkup(<ApprovalRationaleControls pendingAction="approval:approve" disabled rationale="" onRationaleChange={() => {}} selfApprovalError={false} onApprove={() => {}} onReject={() => {}} />);
    expect(markup).toContain("Approving…");
    expect(markup).toContain(">Reject<");
  });
});

describe("PublicationStateTimeline — real discrete stages, RECONCILING explained in plain words, never a fake percentage", () => {
  it("renders PREFLIGHT/DISPATCHED/RECEIPTED as discrete steps with the current one marked, no percentage", () => {
    const markup = renderToStaticMarkup(<PublicationStateTimeline state="DISPATCHED" />);
    expect(markup).toContain('data-status="complete"');
    expect(markup).toContain('data-status="current"');
    expect(markup).toContain('data-status="pending"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).not.toMatch(/%/);
    expect(markup).not.toContain("<progress");
  });

  it("shows the receipt link and commit once RECEIPTED", () => {
    const markup = renderToStaticMarkup(<PublicationStateTimeline state="RECEIPTED" receipt={{ prUrl: "https://github.com/o/r/pull/9", commitSha: "e".repeat(40) }} />);
    expect(markup).toContain("https://github.com/o/r/pull/9");
    expect(markup).toContain("e".repeat(40));
  });

  it("RECONCILING explains that remote effects and spend may exist and that Zintus will not auto-retry", () => {
    const markup = renderToStaticMarkup(<PublicationStateTimeline state="RECONCILING" reconciliation={{ reason: "AMBIGUOUS_REMOTE_OUTCOME", observedRemoteState: "PR_PRESENT_UNKNOWN_SHA" }} />);
    expect(markup).toContain("remote outcome unknown");
    expect(markup).toContain("may or may not exist");
    expect(markup).toContain("will not automatically retry");
    expect(markup).toContain("AMBIGUOUS_REMOTE_OUTCOME");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("RECONCILING shows the run's reserved/settled/uncertain spend when the budget is available", () => {
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
    const markup = renderToStaticMarkup(<PublicationStateTimeline state="RECONCILING" budget={budget} />);
    expect(markup).toContain("$1.00");
    expect(markup).toContain("awaiting provider reconciliation");
  });

  it("FAILED renders as a full error notice with cause/next-action/spend, not a bare word", () => {
    const markup = renderToStaticMarkup(<PublicationStateTimeline state="FAILED" />);
    expect(markup).toContain("Publication failed");
    expect(markup).toContain("Safe next action");
    expect(markup).toContain("Was anything spent?");
  });
});

describe("Publication empty/error states", () => {
  it("empty state is a plain, non-alarming message", () => {
    const markup = renderToStaticMarkup(<PublicationEmptyState />);
    expect(markup).toContain("No eligible publication candidates");
  });

  it("error state surfaces the message with an alert role", () => {
    const markup = renderToStaticMarkup(<PublicationErrorState message="The Approval and publication screen is unavailable" />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("unavailable");
  });
});

describe("Publication screen responsive/style contract", () => {
  const css = readFileSync(join(import.meta.dir, "..", "app", "globals.css"), "utf8");

  it("collapses the error-detail definition list at the 720px breakpoint", () => {
    expect(css).toMatch(/@media \(max-width: 720px\)[^{]*\{[^}]*\.engineer-action-error-detail[^}]*grid-template-columns:\s*1fr/);
  });

  it("distinguishes verified from unverified lineage with the shared green/warn tokens, not a bespoke color", () => {
    expect(css).toMatch(/\.engineer-publication-lineage--verified[^}]*var\(--color-green\)/);
    expect(css).toMatch(/\.engineer-publication-lineage--unverified[^}]*var\(--c-warn\)/);
  });
});
