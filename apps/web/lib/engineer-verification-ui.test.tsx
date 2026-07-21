import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalDecisionControls, PublicationEntryNotice, VerifiedCandidateCard } from "../app/(app)/engineer/EngineerVerificationControls";
import type { VerifiedCandidateSummary } from "./engineer";

const candidate: VerifiedCandidateSummary = {
  checkpointId: "checkpoint_01JZINTUSMACHINEVERIFIED",
  checkpointHash: `sha256:${"a".repeat(64)}`,
  resultCommitSha: "b".repeat(40),
  classificationResult: "READY_WITH_ADVISORIES",
  requiredTestCount: 12,
  allRequiredChecksPassed: true,
  openBlockingCriticalCount: 0,
  environmentDigest: `sha256:${"c".repeat(64)}`,
  createdAt: "2026-07-18T12:00:00.000Z",
};

interface RenderedElement {
  attributes: Record<string, string | null>;
  text: string;
}

async function renderedElements(markup: string, selector: string, attributes: string[]) {
  const elements: RenderedElement[] = [];
  const rewriter = new HTMLRewriter().on(selector, {
    element(element) {
      const rendered: RenderedElement = { attributes: {}, text: "" };
      for (const attribute of attributes) rendered.attributes[attribute] = element.hasAttribute(attribute) ? (element.getAttribute(attribute) ?? "") : null;
      elements.push(rendered);
    },
    text(text) {
      elements.at(-1)!.text += text.text;
    },
  });
  await rewriter.transform(new Response(markup)).text();
  return elements;
}

describe("Engineer verified-candidate rendered UI", () => {
  it("renders the checkpoint hash, keeps the checkpoint ID separate, and exposes full identifiers in keyboard order", async () => {
    const markup = renderToStaticMarkup(<VerifiedCandidateCard candidate={candidate} />);
    const identifiers = await renderedElements(markup, ".engineer-verified-candidate-grid code", ["tabindex", "aria-label", "title"]);

    expect(markup).toContain("Checkpoint hash");
    expect(markup).toContain("Checkpoint ID");
    expect(markup).toContain(candidate.checkpointId);
    expect(identifiers.map((item) => item.attributes.tabindex)).toEqual(["0", "0", "0"]);
    expect(identifiers.map((item) => item.attributes["aria-label"])).toEqual([
      `Checkpoint hash: ${candidate.checkpointHash}`,
      `Result commit: ${candidate.resultCommitSha}`,
      `Environment: ${candidate.environmentDigest}`,
    ]);
    expect(identifiers.map((item) => item.attributes.title)).toEqual([
      candidate.checkpointHash,
      candidate.resultCommitSha,
      candidate.environmentDigest,
    ]);
    expect(identifiers.every((item) => item.text.includes("…"))).toBe(true);
  });

  it("uses native disabled controls and a polite live-region when the candidate changes", async () => {
    const markup = renderToStaticMarkup(<ApprovalDecisionControls disabled candidateChanged pendingAction={null} onApprove={() => {}} onRequestChanges={() => {}} onExtend={() => {}} onReject={() => {}} />);
    const buttons = await renderedElements(markup, "button", ["disabled"]);
    const notices = await renderedElements(markup, '[role="status"]', ["aria-live"]);

    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.attributes.disabled === "")).toBe(true);
    expect(notices).toEqual([{ attributes: { "aria-live": "polite" }, text: "Candidate changed—refresh before deciding." }]);
  });

  it("renders enabled native controls and no stale notice for an authoritative candidate", async () => {
    const markup = renderToStaticMarkup(<ApprovalDecisionControls disabled={false} candidateChanged={false} pendingAction="approval:extend" onApprove={() => {}} onRequestChanges={() => {}} onExtend={() => {}} onReject={() => {}} />);
    const buttons = await renderedElements(markup, "button", ["disabled"]);
    const notices = await renderedElements(markup, '[role="status"]', ["aria-live"]);

    expect(buttons.map((button) => button.attributes.disabled)).toEqual([null, null, null, null]);
    expect(buttons.map((button) => button.text)).toEqual(["Approve and publish", "Request changes", "Applying extension…", "Reject"]);
    expect(notices).toHaveLength(0);
  });

  it("hands a REVIEW_APPROVED run off to the P8 Approval and publication screen scoped to the run, without inventing that approval/publication already happened", () => {
    const markup = renderToStaticMarkup(<PublicationEntryNotice runId="run-42" readiness={{ state: "READY", message: "ready" }} />);

    expect(markup).toContain("Machine verified");
    // A real entry point into the authoritative P8 lane, scoped to this run.
    expect(markup).toContain('href="/engineer/publication?run=run-42"');
    expect(markup).toContain("Open Approval and publication");
    // Still honest: it invites approval, it does not claim approval already occurred.
    expect(markup).not.toContain("passed human review");
    expect(markup).not.toContain("has been published");
  });

  it("keeps a verified candidate local when the server withholds publication authority", () => {
    const markup = renderToStaticMarkup(<PublicationEntryNotice runId="run-42" readiness={{ state: "UNAVAILABLE", message: "Git credentials are not configured." }} />);

    expect(markup).toContain("Verified candidate retained locally");
    expect(markup).toContain("Git credentials are not configured.");
    expect(markup).toContain("No publication authority");
    expect(markup).not.toContain('href="/engineer/publication?run=run-42"');
  });
});

describe("Engineer verified-candidate deterministic style contract", () => {
  const css = readFileSync(join(import.meta.dir, "..", "app", "globals.css"), "utf8");
  const tokens = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "ui", "styles", "tokens.css"), "utf8");

  // Bun's web test environment has no layout engine. These assertions validate
  // the shipped responsive/style contract; browser geometry is audited live.
  it("uses a centrally defined semantic success token without an unresolved variable", () => {
    expect(tokens).toMatch(/--color-green:\s*[^;]+;/);
    expect(css).toContain(".engineer-verified-candidate { border-color: color-mix(in srgb, var(--color-green) 46%, var(--c-border)); }");
    expect(css).not.toContain("var(--c-success)");
  });

  it("keeps desktop columns, collapses at the narrow breakpoint, and wraps long identifiers", () => {
    expect(css).toMatch(/\.engineer-verified-candidate-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.engineer-verified-candidate-grid code[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/@media \(max-width: 820px\)[^{]*\{[^}]*\.engineer-verified-candidate-grid[^}]*grid-template-columns:\s*1fr/);
  });

  it("provides visible keyboard focus and honors reduced-motion preferences", () => {
    expect(css).toMatch(/\.engineer-verified-candidate :focus-visible[^}]*outline:\s*2px solid var\(--c-accent\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*animation-duration:\s*\.01ms !important;[^}]*transition-duration:\s*\.01ms !important;/);
  });
});
