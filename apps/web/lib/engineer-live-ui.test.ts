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
    expect(source).toContain("HUMAN_DECISION_STATES.has(run.state)");
  });

  it("invalidates artifact preview state and remounts the viewer when run identity changes", () => {
    expect(source).toContain("requestGeneration.current += 1");
    expect(source).toContain("setSelected(null)");
    expect(source).toContain("setPreview(null)");
    expect(source).toContain("<ArtifactViewer key={run.runId}");
  });

  it("renders budget mutations only from the gateway capability projection", () => {
    expect(source).toContain('if (!run || !budget || topUpBudgetCapability?.availability !== "AVAILABLE" || topUpPendingRef.current) return');
    expect(source).toContain("topUpPendingRef.current = true");
    expect(source).toContain('"Applying one top-up…"');
    expect(source).toContain('const topUpBudgetCapability = actionCapability("TOP_UP_BUDGET")');
    expect(source).toContain('const canTopUpPausedBudget = topUpBudgetCapability?.availability === "AVAILABLE"');
    expect(source).toContain('{canTopUpPausedBudget ? <BudgetTopUp');
    expect(source).toContain('topUpBudgetCapability?.message ?? "This run\'s budget cannot be increased."');
    expect(source).not.toContain('canRetryLegacyReservation');
  });

  it("locks run mutations before awaiting and exposes action-specific progress", () => {
    expect(source).toContain('actionLockRef.current.run("run-control"');
    expect(source).toContain('withRunMutation("freeze-start"');
    expect(source).toContain('withRunMutation(`decision:${decisionId}`');
    expect(source).toContain('pendingAction === "freeze-start" ? "Starting…"');
    expect(source).toContain('pendingAction === "human-review:retry" ? "Retrying review…"');
    expect(source).toContain('capability.action === "RETRY_REVIEWER"');
    expect(source).toContain('const humanReviewCanRetry = reviewerRetryCapability?.availability === "AVAILABLE"');
    expect(source).not.toContain('resolveHumanReview("approve")');
    expect(source).not.toContain("Continue to approval");
    expect(source).toContain('"Retry reviewer from checkpoint"');
    expect(source).toContain('resolveEngineerDecision(run, decisionId, optionId, "Selected through the Zintus decision inbox.")');
    expect(source).toContain('watch(run.runId, events.at(-1)?.sequence ?? 0);');
    expect(source).toContain('const decisionApplyInFlight = pendingAction?.startsWith("decision:") ?? false;');
    expect(source).toContain("Applying your choice");
    expect(source).toContain("!decisionApplyInFlight && !activity?.active");
  });

  it("keeps emergency cancellation outside planning's action lock and visible while paused", () => {
    expect(source).toContain("Cancellation is an emergency stop authority");
    expect(source).toContain('setPendingAction("cancel")');
    expect(source).not.toContain('latestState !== "PAUSED_BUDGET" && !NON_CANCELLABLE_PUBLICATION_STATES');
    expect(source).not.toContain('latestState !== "HUMAN_APPROVAL_PENDING" && !NON_CANCELLABLE_PUBLICATION_STATES');
  });

  it("refreshes the authoritative snapshot on promotion and approval SSE events", () => {
    expect(source).toContain('event.reasonCode === "VERIFIED_CANDIDATE_PROMOTED"');
    expect(source).toContain("void refresh(runId)");
  });

  it("hydrates a durable snapshot immediately after starting and unlocks Diff/Evidence from authoritative state on reconnect", () => {
    expect(source).toContain("const latestSequence = await refresh(queued.runId); watch(queued.runId, latestSequence);");
    expect(source).toContain('test(latestState) || events.some((event) => ["IMPLEMENTING"');
    expect(source).toContain('test(latestState) || events.some((event) => ["FAST_CHECKS"');
    expect(source).toContain('event.nextState)) void refresh(runId);');
    expect(source).toContain("with the current run state but without its already-durable history");
    expect(source).toContain("watch(run.runId, latestSequence)");
  });

  it("shows durable verification failure reasons at the human gate instead of a generic recovery story", () => {
    expect(source).toContain("const humanReviewFailureReasons = failures");
    expect(source).toContain('aria-label="Verification blockers"');
    expect(source).toContain("Verification needs your decision");
  });

  it("explains when a run is a signed bounded correction instead of presenting it as unrelated", () => {
    expect(source).toContain("const isResolutionReplacement = runCapabilities?.budget.isResolutionReplacement ?? false;");
    expect(source).toContain("This run continues a prior verified record");
    expect(source).toContain("signed Resolution Desk directive");
  });

  it("hands a machine-only REVIEW_APPROVED run off to the authoritative P8 publication screen (no invented human approval)", () => {
    expect(source).toContain("getEngineerPublicationReadiness()");
    expect(source).toContain('latestState === "REVIEW_APPROVED" && !approval ? <PublicationEntryNotice runId={run.runId} readiness={publicationReadiness} /> : null');
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
    expect(source).toContain("listEngineerRepositories()");
    expect(source).toContain("Engineer-admitted repositories");
    expect(source).toContain("Connector access alone never authorizes code execution.");
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

  it("retains the durable active-run pointer if a transient reopen fails", () => {
    expect(source).toContain("A gateway restart or transient handshake failure must never orphan a");
    expect(source).toContain("Unable to reopen this run yet:");
    expect(source).not.toContain("window.localStorage.removeItem(RUN_STORAGE_KEY);\n      void loadDashboard();");
  });

  it("clears the create idempotency identity before pre-filling a fresh bounded request", () => {
    expect(source).toContain("A caller-generated ID is an idempotency identity");
    expect(source).toContain("createRunIdRef.current = null;\n    returnToRuns();");
  });

  it("keeps diff review copying and patch download entirely in the browser", () => {
    expect(source).toContain('navigator.clipboard?.writeText');
    expect(source).toContain("Copy all changes");
    expect(source).toContain("Copy diff");
    expect(source).toContain("Copy file content");
    expect(source).toContain('downloadBlob("zintus-engineer.patch.diff"');
    expect(source).toContain("No code changes yet");
    expect(source).toContain('no gateway request or model cost');
  });
});
