import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "app", "(app)", "engineer", "page.tsx"), "utf8");

describe("Engineer live UI lifecycle guards", () => {
  it("preserves the initial snapshot but uses the lightweight projection on hot SSE events", () => {
    expect(source).toContain("getEngineerSnapshot(runId)");
    expect(source).toContain("void refreshLiveSummary(runId)");
    expect(source).not.toContain("setTimeout(() => { refreshTimerRef.current = null; void refresh(runId);");
  });

  it("does not reopen event streams for paused or terminal runs", () => {
    expect(source).toContain('snapshot.status.run.state !== "PAUSED_BUDGET" && !TERMINAL.has(snapshot.status.run.state)');
    expect(source).toContain("watch(resumed.runId, latestSequence)");
  });

  it("invalidates artifact preview state and remounts the viewer when run identity changes", () => {
    expect(source).toContain("requestGeneration.current += 1");
    expect(source).toContain("setSelected(null)");
    expect(source).toContain("setPreview(null)");
    expect(source).toContain("<ArtifactViewer key={run.runId}");
  });

  it("locks a budget top-up synchronously and exposes an applying state", () => {
    expect(source).toContain('if (!run || !budget || run.state !== "PAUSED_BUDGET" || topUpPendingRef.current) return');
    expect(source).toContain("topUpPendingRef.current = true");
    expect(source).toContain('"Applying one top-up…"');
    expect(source).toContain("Allowance added once. New ceiling:");
    expect(source).toContain("No action needed · active top-ups are locked");
    expect(source).toContain("Allowance was added exactly once, but resume did not complete");
    expect(source).toContain('topUpNotice ? "Allowance already added"');
    expect(source).toContain("canRetryLegacyReservation || Boolean(budget?.topUpPendingResume)");
  });

  it("locks run mutations before awaiting and exposes action-specific progress", () => {
    expect(source).toContain('actionLockRef.current.run("run-control"');
    expect(source).toContain('withRunMutation("freeze-start"');
    expect(source).toContain('withRunMutation(`decision:${decisionId}`');
    expect(source).toContain('pendingAction === "freeze-start" ? "Starting…"');
    expect(source).toContain('pendingAction === "human-review:retry" ? "Retrying review…"');
    expect(source).not.toContain('resolveHumanReview("approve")');
    expect(source).not.toContain("Continue to approval");
    expect(source).toContain('"Retry reviewer from checkpoint"');
    expect(source).toContain('resolveEngineerDecision(run, decisionId, optionId, "Selected through the Zintus decision inbox.")');
  });

  it("refreshes the authoritative snapshot on promotion and approval SSE events", () => {
    expect(source).toContain('event.reasonCode === "VERIFIED_CANDIDATE_PROMOTED"');
    expect(source).toContain("void refresh(runId)");
  });

  it("hands a machine-only REVIEW_APPROVED run off to the authoritative P8 publication screen (no invented human approval)", () => {
    expect(source).toContain('latestState === "REVIEW_APPROVED" && !approval ? <PublicationEntryNotice runId={run.runId} /> : null');
    expect(source).not.toContain("The candidate passed human review");
    expect(source).not.toContain('<span className="engineer-kicker">Review approved</span>');
  });

  it("no longer carries the legacy approval candidate-stale conflict machinery (R8-3 P1 #3)", () => {
    // R8-3 removed the legacy human-gate approval WRITE controls from the UI. The
    // candidate-stale conflict scoping existed only to disable / refresh those
    // approval buttons on a candidate change, so it is gone with them — recovery
    // for a stranded run runs exclusively through the Resolution Desk.
    expect(source).not.toContain("candidateStaleRunId");
    expect(source).not.toContain("setCandidateStaleRunId");
    expect(source).not.toContain("candidateConflictAppliesToRun");
    expect(source).not.toContain("ApprovalDecisionControls");
  });

  it("separates active reservations from ambiguous provider outcomes", () => {
    expect(source).toContain("budget.reserved.costUsd - budget.ambiguous.costUsd");
    expect(source).toContain("awaiting provider reconciliation");
    expect(source).toContain("will not replay it automatically");
  });

  it("bounds browser folder inventory before traversing a large repository", () => {
    expect(source).toContain("FOLDER_INVENTORY_MAX_FILES = 5_000");
    expect(source).toContain("FOLDER_INVENTORY_MAX_ENTRIES = 10_000");
    expect(source).toContain("FOLDER_INVENTORY_MAX_DEPTH = 32");
    expect(source).toContain('item.name === ".git" || item.name === "node_modules"');
    expect(source).toContain("FOLDER_TREE_MAX_NODES = 160");
    expect(source).toContain("<FolderTree nodes={folderSnapshot.tree}");
  });

  it("renders compact controls from real connector and workflow state", () => {
    expect(source).toContain("listGithubConnectorRepositories()");
    expect(source).toContain("getGithubBranchCommit(owner, name, candidate.defaultBranch)");
    expect(source).toContain("<BudgetSlider index={budgetPresetIndex}");
    expect(source).toContain("const targetIndex = chip.label === \"Recommended\" ? recommendedIndex : chip.presetIndex");
    expect(source).toContain("stage={stage}");
    expect(source).toContain("const visibleEvidenceErrors = reachedVerification ? (data?.errors ?? []) : []");
    expect(source).toContain("engineer-run-task${expanded ? \" expanded\" : \"\"}");
  });

  it("reconnects automatically when the local gateway starts after the page", () => {
    expect(source).toContain('if (gatewayState !== "offline") return');
    expect(source).toContain("window.setInterval(reconnect, 3_000)");
    expect(source).toContain('window.addEventListener("focus", reconnect)');
    expect(source).toContain('window.removeEventListener("focus", reconnect)');
  });
});
