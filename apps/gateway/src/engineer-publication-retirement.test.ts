import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineerRun } from "@zintus/engineer";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal } from "./engineer-identity.js";

// R5A: the legacy EngineerPublicationManager is RETIRED from every new-run
// authority path. P8 (PublicationAuthorityService) is the SOLE authoritative
// publication system for new runs. These tests drive that cutover: each fails
// (goes RED) if the legacy authority is re-wired into the run manager or if the
// composition root re-constructs / re-schedules it.

const repository = {
  repositoryId: "repo-1", provider: "local" as const, owner: "local", name: "fixture",
  baseBranch: "main", baseCommitSha: "1".repeat(40),
};
const preflight = { assertRunAdmission: async () => undefined, repository: () => repository } as never;

describe("R5A publication authority retirement", () => {
  test("one writer: REVIEW_APPROVED is stream-terminal without a legacy publication authority (P8 takes over)", () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });

    // Production (R5A) wiring: EngineerRunManager is constructed WITHOUT `publication`.
    const p8Only = new EngineerRunManager({ supervisor: {} as never, principal, preflight });
    expect(p8Only.reviewApprovedEndsStream()).toBe(true);

    // If the legacy authority were re-wired, the manager would keep the stream
    // open past REVIEW_APPROVED to drive its own HUMAN_APPROVAL_PENDING lane —
    // i.e. a SECOND writer. reviewApprovedEndsStream flips, so this asserts the
    // single-writer invariant directly.
    const legacyWired = new EngineerRunManager({
      supervisor: {} as never, principal, preflight,
      publication: { start: async () => ({ status: "AWAITING_APPROVAL" as const }) } as never,
    });
    expect(legacyWired.reviewApprovedEndsStream()).toBe(false);
  });

  test("new run's final decision never enters the legacy approval lane (no HUMAN_APPROVAL_PENDING)", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    const run: EngineerRun = {
      runId: "p8-only-final", userId: principal.ownerId, repository,
      requestOriginal: "change", requestNormalized: "change",
      state: "REVIEW_APPROVED", stateVersion: 8, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let open = true;
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run,
        resolveDecision: () => { open = false; return { resolutionId: "resolution-1" }; },
        listOpenDecisions: () => open ? [{ decisionId: "decision-1", classification: "DEFER" }] : [],
      } as never,
      // R5A: no `publication` — the legacy authority is retired from new runs.
      principal,
      preflight,
    });

    const result = await manager.resolveDecision(principal, run.runId, "decision-1", {
      expectedStateVersion: run.stateVersion,
      selectedOptionId: "recommended",
      rationale: "Apply the reviewed option.",
      idempotencyKey: "p8-only-final-once",
    });
    // The verified candidate is left at REVIEW_APPROVED for P8; no legacy approval
    // request/publication is created by the run manager.
    expect(result.publication).toBeNull();
    expect(manager.reviewApprovedEndsStream()).toBe(true);
  });

  test("the legacy approval WRITE path is refused on the P8-only run manager", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    const run: EngineerRun = {
      runId: "p8-only-approve", userId: principal.ownerId, repository,
      requestOriginal: "change", requestNormalized: "change",
      state: "REVIEW_APPROVED", stateVersion: 8, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    const manager = new EngineerRunManager({
      supervisor: { getRun: () => run, isOptionalHardeningChild: () => false } as never,
      principal,
      preflight,
    });
    const expected = {
      expectedVerifiedCheckpointId: "checkpoint-1",
      expectedVerifiedCheckpointHash: `sha256:${"c".repeat(64)}`,
      expectedApprovalRevision: 0,
    };
    await expect(manager.approve(principal, run.runId, "approve", expected))
      .rejects.toThrow(/publication is not configured/);
    await expect(manager.reject(principal, run.runId, "reject", expected))
      .rejects.toThrow(/publication is not configured/);
  });

  test("historical legacy-lane runs still read back approval/evidence/publication history (compatibility)", () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    // A run that already completed the legacy HUMAN_APPROVAL_PENDING lane before
    // the cutover: it carries a durable approval record, evidence, git ops.
    const historicalRun: EngineerRun = {
      runId: "legacy-hist", userId: principal.ownerId, repository,
      requestOriginal: "old change", requestNormalized: "old change",
      state: "COMPLETED", stateVersion: 22, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: now,
    };
    const historicalApproval = {
      approvalRequestId: "appr-legacy-1", runId: "legacy-hist", status: "APPROVED" as const,
      manifestHash: `sha256:${"a".repeat(64)}`, diffHash: `sha256:${"d".repeat(64)}`,
      evidenceBundleHash: `sha256:${"e".repeat(64)}`, approvalRevision: 3,
      verifiedCheckpointId: "checkpoint-legacy", verifiedCheckpointHash: `sha256:${"c".repeat(64)}`,
    };
    // Post-cutover manager: NO publication authority wired (production R5A).
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => historicalRun,
        latestApprovalRequest: () => historicalApproval,
        listEvidenceBundles: () => [{ evidenceBundleId: "bundle-legacy" }],
        listClaimEvidence: () => [{ claimId: "claim-legacy", status: "VERIFIED" }],
        listGitOperations: () => [{ gitOperationId: "op-legacy", kind: "PR_CREATED" }],
        listArtifacts: () => [{ artifactId: "art-legacy", type: "FINAL_DIFF", trusted: true, storageReference: "secret-ref" }],
        isOptionalHardeningChild: () => false,
      } as never,
      principal,
      preflight,
    });

    // Every read still resolves through the supervisor ledger — never the retired
    // publication manager — so historical evidence renders intact.
    const view = manager.approvalView("legacy-hist");
    expect(view.approval?.approvalRequestId).toBe("appr-legacy-1");
    expect(view.approval?.status).toBe("APPROVED");
    expect(manager.evidenceBundles("legacy-hist") as unknown).toEqual([{ evidenceBundleId: "bundle-legacy" }]);
    expect(manager.claims("legacy-hist") as unknown).toEqual([{ claimId: "claim-legacy", status: "VERIFIED" }]);
    expect(manager.gitOperations("legacy-hist") as unknown).toEqual([{ gitOperationId: "op-legacy", kind: "PR_CREATED" }]);
    const artifacts = manager.artifacts("legacy-hist");
    expect(artifacts).toHaveLength(1);
    // The private storage reference is still stripped from the read projection.
    expect((artifacts[0] as Record<string, unknown>).storageReference).toBeUndefined();
    expect((artifacts[0] as Record<string, unknown>).artifactId).toBe("art-legacy");
  });

  // Composition-root guard: the production gateway must not re-construct or
  // re-schedule the legacy publication authority. This mirrors the R3 source
  // guard (apps/web engineer-live-ui.test.ts) for a wiring decision that is only
  // observable at the composition root. It goes RED the moment the legacy manager
  // is reintroduced into index.ts.
  test("index.ts does not construct or wire the legacy publication authority into new runs", () => {
    const indexSource = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"), "utf8");
    // No legacy construction.
    expect(indexSource).not.toContain("new EngineerPublicationManager(");
    // No legacy wiring into the run manager.
    expect(indexSource).not.toContain("publication: engineerPublication");
    // No legacy recovery / approval-expiration timer.
    expect(indexSource).not.toContain(".recoverPending()");
    expect(indexSource).not.toContain(".sweepExpired()");
    expect(indexSource).not.toContain("engineerApprovalTimer");
    // P8 remains the authoritative publication system.
    expect(indexSource).toContain("createPublicationAuthorityService(");
  });
});
