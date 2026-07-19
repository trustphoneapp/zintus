import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdvisoryChangedError, AdvisoryCursorInvalidError, AdvisoryIntegrityError, AdvisoryMaterializationRequiredError, AdvisoryTransitionInvalidError, HardeningAuthorityInvalidError, IdempotencyConflictError, InvalidTransitionError, VerifiedCandidateIntegrityError } from "./errors.js";
import { canonicalJson, sha256, sha256Bytes } from "./hash.js";
import { EngineerLedger, type OptionalHardeningStartPreparation } from "./ledger.js";
import { classifyReviewerOutput, ReviewClassificationBatchSchema } from "./review-classification.js";
import { createEngineerSupervisor } from "./supervisor.js";
import { transitionToPlanReadyForTest } from "./test-planning-evidence.js";
import {
  ReviewerInputSchema,
  TaskManifestContentSchema,
  TaskManifestSchema,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  type RepositoryReference,
  type TaskManifestContent,
} from "./contracts.js";
import { ReviewFindingRecordSchema, ReviewerSessionRecordSchema, SecurityFindingRecordSchema } from "./verification-contracts.js";
import { LocalArtifactStore } from "./artifact-store.js";
import type { ArtifactRecord } from "./execution-contracts.js";
import { Database } from "bun:sqlite";
import { SECURITY_POLICY_VERSION } from "./required-lane-policy-versions.js";
import {
  TEST_BASELINE_POLICY_VERSION,
  TestBaselineManifestSchema,
  TestIntegrityComparisonSchema,
} from "./test-integrity.js";
import { buildVerificationCoverageMatrix } from "./verification-contracts.js";
import { buildAdversarialCoverageReport } from "./adversarial-coverage.js";
import { TestAdvisorySchema } from "./terra-advisors.js";
import { buildFinalChangeScopeAttestation } from "./final-change-scope.js";
import { scanDiffForSecurity } from "./deterministic-security-scan.js";
import type { CheckpointAttestor, PromoteVerifiedCandidateInput } from "./verified-candidate-checkpoint.js";
import type {
  ApprovalRequestRecord,
  NewApprovalDecisionRecord,
  NewApprovalRequestRecord,
  NewGitOperationRecord,
} from "./control-contracts.js";
import { ENGINEER_DATABASE_MIGRATION_22_SQL } from "./database-schema.js";
import { AdvisoryBacklogItemSchema, createAdvisoryBacklogEvent,
  HardeningQuoteSchema, HardeningQuoteSizingAuthoritySchema,
  hardeningChildRunId, OptionalHardeningChildAuthoritySchema } from "./advisory-hardening-contracts.js";
import { createSignedHardeningSeedAttestation } from "./hardening-start-contracts.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import { DockerSandboxManager, NETWORK_POLICY_VERSION, SANDBOX_POLICY_VERSION } from "./sandbox-manager.js";
import { EngineerExecutionManager } from "./execution-manager.js";
import { EngineerVerificationManager } from "./verification-manager.js";
import { REVIEWER_POLICY_VERSION, reviewerStaticRequestPrefix } from "./isolated-reviewer.js";
import { builderStaticRequestPrefix, type ResponsesTransport } from "./codex-builder.js";
import { createHardeningPromptCacheMaterial } from "./hardening-prompt-cache.js";
import {
  createHardeningBudgetReconciliation,
  hardeningModelPartitionedCostMicrousd,
} from "./hardening-budget-contracts.js";
import { EngineerWorkerLeaseManager, type WorkerLeaseGrant } from "./worker-lease.js";

const timestamp = "2026-07-17T18:00:00.000Z";
const hardeningPromptCacheSecret = "test-hardening-prompt-cache-secret-0000000000000000";
const offsetFuture = "2026-07-17T14:00:01.000-04:00";
const offsetEarlier = "2026-07-17T19:59:59.000+02:00";

async function raceApprovalExtensions(input: {
  dbPath: string;
  now: string;
  candidates: Array<{ decision: NewApprovalDecisionRecord; deadlineAt: string }>;
}): Promise<Array<{ ok: boolean; value?: ApprovalRequestRecord; error?: string }>> {
  const source = `
    import { createEngineerSupervisor } from "./packages/engineer/src/supervisor.ts";
    const input = JSON.parse(process.env.ZINTUS_APPROVAL_RACE_INPUT);
    while (Date.now() < input.startAt) {}
    const supervisor = createEngineerSupervisor({ dbPath: input.dbPath, now: () => new Date(input.now) });
    try {
      const value = supervisor.extendApproval(input.decision, input.deadlineAt, []);
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      supervisor.close();
    }
  `;
  const startAt = Date.now() + 500;
  const processes = input.candidates.map((candidate) => Bun.spawn({
    cmd: [process.execPath, "-e", source],
    cwd: new URL("../../../", import.meta.url).pathname,
    env: {
      ...process.env,
      ZINTUS_APPROVAL_RACE_INPUT: JSON.stringify({
        dbPath: input.dbPath,
        now: input.now,
        startAt,
        decision: candidate.decision,
        deadlineAt: candidate.deadlineAt,
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  }));
  return Promise.all(processes.map(async (child) => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`approval race worker failed: ${stderr || stdout}`);
    const line = stdout.trim().split("\n").at(-1);
    if (!line) throw new Error(`approval race worker returned no result: ${stderr}`);
    return JSON.parse(line) as { ok: boolean; value?: ApprovalRequestRecord; error?: string };
  }));
}
const repository: RepositoryReference = {
  repositoryId: "repo-classified", provider: "local", owner: "local", name: "classified",
  baseBranch: "main", baseCommitSha: "a".repeat(40),
};

function manifest(runId: string, repositoryReference: RepositoryReference = repository): TaskManifestContent {
  return {
    manifestVersion: 1, runId, repository: repositoryReference,
    request: { original: "Implement it", normalized: "Implement it" },
    acceptanceCriteria: [{ criterionId: "must-1", statement: "It works", verificationMethod: "Run tests", priority: "MUST" }],
    testPlan: [{ testId: "test-1", criterionIds: ["must-1"], type: "UNIT", description: "Run tests", command: "bun test" }],
    allowedPaths: ["src/**"], deniedPaths: [".env*"], allowedCommands: ["bun test"], prohibitedCommands: [],
    riskTier: "MEDIUM", humanGateRequired: true,
    retryBudgets: { sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2, plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3 },
    timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 2, createdAt: timestamp,
  };
}

type DomainEvidenceMode =
  | "COVERAGE_VALID" | "COVERAGE_FORGED_CURRENT" | "COVERAGE_STALE" | "COVERAGE_UNSEEN" |
    "COVERAGE_FUTURE_OFFSET" | "COVERAGE_EARLIER_OFFSET"
  | "ADVERSARIAL_VALID" | "ADVERSARIAL_FORGED_CURRENT" | "ADVERSARIAL_STALE" |
    "ADVERSARIAL_DUPLICATE_ADVISORY" | "ADVERSARIAL_FUTURE_ADVISORY" | "ADVERSARIAL_UNSEEN"
  | "ADVERSARIAL_TRUSTED_ADVISORY"
  | "INTEGRITY_VALID" | "INTEGRITY_FORGED" | "INTEGRITY_FORGED_CURRENT" | "INTEGRITY_STALE" | "INTEGRITY_OLD_STAGE" |
    "INTEGRITY_DUPLICATE_BASELINE" | "INTEGRITY_DUPLICATE_STAGE" | "INTEGRITY_UNSEEN"
  | "INTEGRITY_RECREATED_BASELINE" | "INTEGRITY_LATER_FAILED" | "INTEGRITY_FUTURE_ACTIVITY"
  | "INTEGRITY_DUPLICATE_AUDIT_ASOF" | "INTEGRITY_FUTURE_DUPLICATE_AUDIT"
  | "SCOPE_VALID" | "SCOPE_FORGED" | "SCOPE_FORGED_CURRENT" | "SCOPE_STALE" |
    "SCOPE_FUTURE_GIT" | "SCOPE_OFFSET_EARLIER_GIT" | "SCOPE_INVALID_GIT" | "SCOPE_UNSEEN";

function setup(
  runId = "run-classified",
  evidenceMode: "NONE" | "VALID" | "SECURITY_VALID_FINDING" | "FORGED" | "SEMANTIC_FORGED" | "STALE" | "UNSEEN" |
    "INDEPENDENT_VALID" | "INDEPENDENT_FORGED" | "INDEPENDENT_STALE" | "INDEPENDENT_UNSEEN" |
    "INDEPENDENT_TAMPERED" | "INDEPENDENT_FUTURE_PASS" = "NONE",
  domainEvidenceMode?: DomainEvidenceMode,
  readyCandidate = false,
  readyWithAdvisory = false,
  advisoryFile = "src/index.ts",
  additionalAdvisoryFiles: string[] = [],
  existing?:{root:string;dbPath:string;supervisor:ReturnType<typeof createEngineerSupervisor>},
  runtime?:{repository:RepositoryReference;finalDiff:string;resultCommitSha:string;environmentDigest?:string},
) {
  const root = existing?.root??mkdtempSync(join(tmpdir(), "zintus-classified-review-"));
  const dbPath = existing?.dbPath??join(root, "engineer.db");
  let id = 0;
  const supervisor = existing?.supervisor??createEngineerSupervisor({ dbPath, idFactory: () => `id-${++id}`, now: () => new Date(timestamp) });
  const repositoryForRun=runtime?.repository??repository;
  if(!existing){const received = supervisor.receiveRequest({ runId, userId: "user", repository:repositoryForRun, request: "Implement it" });
    const planned = transitionToPlanReadyForTest({supervisor,received,normalizedRequest:"Implement it",manifest:manifest(runId,repositoryForRun),key:runId});
    supervisor.freezePlan({runId,expectedStateVersion:planned.stateVersion,manifest:manifest(runId,repositoryForRun),actorId:"planner",idempotencyKey:`${runId}:freeze`});}
  const frozen = supervisor.getManifest(runId)!;
  const contract = supervisor.getRequiredLaneContract(runId)!;
  const criterionId=frozen.acceptanceCriteria[0]!.criterionId,testId=frozen.testPlan[0]!.testId;
  const testCommand=frozen.testPlan[0]!.command!;const named=(value:string)=>existing?`${runId}-${value}`:value;
  const finalDiff = runtime?.finalDiff??(evidenceMode === "SECURITY_VALID_FINDING" ? [
    "diff --git a/src/index.ts b/src/index.ts", "--- a/src/index.ts", "+++ b/src/index.ts",
    "@@ -1,0 +1,1 @@", "+eval(userInput);",
  ].join("\n") : "diff");
  const currentDiffHash = sha256(finalDiff);
  const resultCommitSha = runtime?.resultCommitSha??"b".repeat(40);
  const { manifestHash: _manifestHash, ...frozenContent } = frozen;
  const staleContent = TaskManifestContentSchema.parse({
    ...frozenContent,
    request: { ...frozen.request, normalized: "A stale normalized request" },
  });
  const staleManifest = TaskManifestSchema.parse({ ...staleContent, manifestHash: sha256(staleContent) });
  const reviewAttempt = evidenceMode.startsWith("INDEPENDENT_") ? 2 : 1;
  const baselineContent = {
    policyVersion: TEST_BASELINE_POLICY_VERSION, runId,
    manifestHash: domainEvidenceMode === "INTEGRITY_STALE" ? staleManifest.manifestHash : frozen.manifestHash,
    baseCommitSha: frozen.repository.baseCommitSha, entries: [], createdAt: timestamp,
  };
  const baseline = TestBaselineManifestSchema.parse({ ...baselineContent, baselineHash: sha256(baselineContent) });
  const baselineStore = new LocalArtifactStore({
    root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => named("test-baseline"),
  });
  supervisor.recordArtifact(baselineStore.put({
    runId, type: "TEST_BASELINE_MANIFEST", bytes: canonicalJson(baseline), producerType: "SYSTEM",
    producerId: "engineer-supervisor-test-integrity", trusted: true,
  }));
  let comparisonBaseline = baseline;
  if (domainEvidenceMode === "INTEGRITY_DUPLICATE_BASELINE" ||
      domainEvidenceMode === "INTEGRITY_RECREATED_BASELINE") {
    const duplicateBaselineContent = {
      ...baselineContent,
      entries: [{
        path: "test/duplicate.test.ts", gitBlobObjectId: "c".repeat(40), contentSha256: sha256("duplicate"),
        byteLength: 9, fileMode: "100644", classification: "IMMUTABLE" as const,
      }],
    };
    const duplicateBaseline = TestBaselineManifestSchema.parse({
      ...duplicateBaselineContent, baselineHash: sha256(duplicateBaselineContent),
    });
    const duplicateBaselineStore = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => "test-baseline-duplicate",
    });
    supervisor.recordArtifact(duplicateBaselineStore.put({
      runId, type: "TEST_BASELINE_MANIFEST", bytes: canonicalJson(duplicateBaseline), producerType: "SYSTEM",
      producerId: "engineer-supervisor-test-integrity", trusted: true,
    }));
    if (domainEvidenceMode === "INTEGRITY_RECREATED_BASELINE") comparisonBaseline = duplicateBaseline;
  }
  const integrityContent = {
    policyVersion: TEST_BASELINE_POLICY_VERSION, runId, baselineHash: comparisonBaseline.baselineHash,
    stage: domainEvidenceMode === "INTEGRITY_OLD_STAGE" ? "PRE_VERIFICATION" : "PRE_REVIEW",
    immutableChanges: [], authorizedChanges: [], builderAuthoredTests: [],
    commandMutationChecks: domainEvidenceMode === "INTEGRITY_FORGED_CURRENT" ? 999 : 0,
    passed: true, comparedAt: timestamp,
  };
  const integrity = TestIntegrityComparisonSchema.parse({ ...integrityContent, comparisonHash: sha256(integrityContent) });
  const integrityStore = new LocalArtifactStore({
    root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => named("pre-review-integrity"),
  });
  const integrityArtifact = supervisor.recordArtifact(integrityStore.put({
    runId, type: "TEST_INTEGRITY_COMPARISON", bytes: canonicalJson(integrity), producerType: "SYSTEM",
    producerId: "engineer-supervisor-test-integrity", trusted: true,
  }));
  if (domainEvidenceMode !== "INTEGRITY_FORGED_CURRENT") {
    supervisor.recordTestIntegrityAttestation(integrityArtifact.artifactId, integrity);
  }
  const integrityEvidencePayload = domainEvidenceMode === "INTEGRITY_FORGED" ? (() => {
    const { comparisonHash: _comparisonHash, ...content } = integrity;
    const forgedContent = { ...content, commandMutationChecks: content.commandMutationChecks + 1 };
    return { ...forgedContent, comparisonHash: sha256(forgedContent) };
  })() : integrity;
  const integrityEvidence = TrustedEvidenceSchema.parse({
    evidenceId: domainEvidenceMode === "INTEGRITY_UNSEEN" ? "unseen-integrity" : integrityArtifact.artifactId,
    runId, eventType: "TEST_INTEGRITY_ATTESTATION", producerType: "SYSTEM",
    producerId: integrityArtifact.producerId, sha256: sha256(integrityEvidencePayload),
    payload: integrityEvidencePayload, createdAt: integrityArtifact.createdAt,
  });
  const additionalIntegrityEvidence = domainEvidenceMode === "INTEGRITY_DUPLICATE_STAGE" ? (() => {
    const duplicateStore = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => "pre-review-integrity-duplicate",
    });
    const artifact = supervisor.recordArtifact(duplicateStore.put({
      runId, type: "TEST_INTEGRITY_COMPARISON", bytes: canonicalJson(integrity), producerType: "SYSTEM",
      producerId: "engineer-supervisor-test-integrity", trusted: true,
    }));
    supervisor.recordTestIntegrityAttestation(artifact.artifactId, integrity);
    return [TrustedEvidenceSchema.parse({
      evidenceId: artifact.artifactId, runId, eventType: "TEST_INTEGRITY_ATTESTATION", producerType: "SYSTEM",
      producerId: artifact.producerId, sha256: artifact.sha256, payload: integrity, createdAt: artifact.createdAt,
    })];
  })() : [];
  if (domainEvidenceMode === "INTEGRITY_LATER_FAILED" || domainEvidenceMode === "INTEGRITY_FUTURE_ACTIVITY") {
    const laterAt = domainEvidenceMode === "INTEGRITY_FUTURE_ACTIVITY"
      ? offsetFuture : timestamp;
    let laterBaselineHash = integrityContent.baselineHash;
    if (domainEvidenceMode === "INTEGRITY_FUTURE_ACTIVITY") {
      const futureBaselineContent = {
        ...baselineContent, createdAt: laterAt,
        entries: [{
          path: "test/future.test.ts", gitBlobObjectId: "d".repeat(40), contentSha256: sha256("future"),
          byteLength: 6, fileMode: "100644", classification: "IMMUTABLE" as const,
        }],
      };
      const futureBaseline = TestBaselineManifestSchema.parse({
        ...futureBaselineContent, baselineHash: sha256(futureBaselineContent),
      });
      const futureBaselineStore = new LocalArtifactStore({
        root: join(root, "artifacts"), now: () => new Date(laterAt), idFactory: () => "test-baseline-future",
      });
      supervisor.recordArtifact(futureBaselineStore.put({
        runId, type: "TEST_BASELINE_MANIFEST", bytes: canonicalJson(futureBaseline), producerType: "SYSTEM",
        producerId: "engineer-supervisor-test-integrity", trusted: true,
      }));
      laterBaselineHash = futureBaseline.baselineHash;
    }
    const failedContent = {
      ...integrityContent, baselineHash: laterBaselineHash,
      immutableChanges: ["test/security.test.ts"], passed: false,
      comparedAt: laterAt,
    };
    const failedComparison = TestIntegrityComparisonSchema.parse({
      ...failedContent, comparisonHash: sha256(failedContent),
    });
    const failedStore = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(laterAt),
      idFactory: () => "pre-review-integrity-failed-latest",
    });
    const failedArtifact = supervisor.recordArtifact(failedStore.put({
      runId, type: "TEST_INTEGRITY_COMPARISON", bytes: canonicalJson(failedComparison), producerType: "SYSTEM",
      producerId: "engineer-supervisor-test-integrity", trusted: true,
    }));
    supervisor.recordTestIntegrityAttestation(failedArtifact.artifactId, failedComparison);
  }
  const domainEvidence = domainEvidenceMode ? (() => {
    if (domainEvidenceMode.startsWith("INTEGRITY_")) return [];
    if (domainEvidenceMode.startsWith("COVERAGE_")) {
      const exact = buildVerificationCoverageMatrix(frozen);
      const payload = domainEvidenceMode === "COVERAGE_STALE"
        ? buildVerificationCoverageMatrix(staleManifest)
        : domainEvidenceMode === "COVERAGE_FORGED_CURRENT"
          ? (() => {
            const { matrixHash: _matrixHash, ...content } = exact;
            const forgedContent = {
              ...content,
              criteria: content.criteria.map((criterion) => ({ ...criterion, testIds: [] })),
            };
            return { ...forgedContent, matrixHash: sha256(forgedContent) };
          })()
          : exact;
      const store = new LocalArtifactStore({
        root: join(root, "artifacts"),
        now: () => new Date(domainEvidenceMode === "COVERAGE_FUTURE_OFFSET" ? offsetFuture
          : domainEvidenceMode === "COVERAGE_EARLIER_OFFSET" ? offsetEarlier : timestamp),
        idFactory: () => "coverage-matrix",
      });
      const artifact = supervisor.recordArtifact(store.put({
        runId, type: "VERIFICATION_COVERAGE_MATRIX", bytes: canonicalJson(payload), producerType: "SYSTEM",
        producerId: "verification-coverage-policy", trusted: true,
      }));
      return [TrustedEvidenceSchema.parse({
        evidenceId: domainEvidenceMode === "COVERAGE_UNSEEN" ? "unseen-coverage" : artifact.artifactId,
        runId, eventType: "VERIFICATION_COVERAGE_MATRIX", producerType: "SYSTEM", producerId: artifact.producerId,
        sha256: artifact.sha256, payload, createdAt: artifact.createdAt,
      })];
    }
    if (domainEvidenceMode.startsWith("SCOPE_")) {
      const exactPayload = buildFinalChangeScopeAttestation({
        manifest: frozen, diff: finalDiff, resultCommitSha,
        credentialedGitOperationCount: domainEvidenceMode === "SCOPE_OFFSET_EARLIER_GIT" ? 1 : 0,
      });
      const durablePayload = domainEvidenceMode === "SCOPE_STALE"
        ? { ...exactPayload, manifestHash: staleManifest.manifestHash, diffHash: sha256("stale-diff") }
        : domainEvidenceMode === "SCOPE_FORGED_CURRENT"
          ? { ...exactPayload, changedPaths: ["src/forged.ts"] }
          : exactPayload;
      const store = new LocalArtifactStore({
        root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => named("scope-attestation"),
      });
      const artifact = supervisor.recordArtifact(store.put({
        runId, type: "FINAL_CHANGE_SCOPE_ATTESTATION", bytes: canonicalJson(durablePayload), producerType: "SYSTEM",
        producerId: "final-change-scope-policy", trusted: true,
      }));
      const evidencePayload = domainEvidenceMode === "SCOPE_FORGED"
        ? { ...durablePayload, changedPaths: ["src/forged.ts"] }
        : durablePayload;
      return [TrustedEvidenceSchema.parse({
        evidenceId: domainEvidenceMode === "SCOPE_UNSEEN" ? "unseen-scope" : artifact.artifactId,
        runId, eventType: "FINAL_CHANGE_SCOPE_ATTESTATION", producerType: "SYSTEM", producerId: artifact.producerId,
        sha256: sha256(evidencePayload), payload: evidencePayload, createdAt: artifact.createdAt,
      })];
    }
    const advisory = TestAdvisorySchema.parse({
      uncoveredCriterionIds: [], warnings: [], adversarialGaps: [],
    });
    const advisoryStore = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => "test-advisory",
    });
    const advisoryArtifact = supervisor.recordArtifact(advisoryStore.put({
      runId, type: "TEST_ADVISORY", bytes: canonicalJson(advisory), producerType: "SYSTEM",
      producerId: "tester-agent", trusted: domainEvidenceMode === "ADVERSARIAL_TRUSTED_ADVISORY",
    }));
    const testerExecution = {
      agentExecutionId: "tester-agent", runId, role: "TESTER", modelTier: "GPT-5.6_LUNA",
      inputHash: sha256({ manifest: frozen.manifestHash, diff: currentDiffHash, evidence: [] }),
      startedAt: timestamp,
    } as const;
    supervisor.recordAgentExecution({
      ...testerExecution, status: "RUNNING", outputArtifactId: null, completedAt: null,
    });
    supervisor.recordAgentExecution({
      ...testerExecution, status: "SUCCEEDED", outputArtifactId: advisoryArtifact.artifactId, completedAt: timestamp,
    });
    if (domainEvidenceMode === "ADVERSARIAL_DUPLICATE_ADVISORY" ||
        domainEvidenceMode === "ADVERSARIAL_FUTURE_ADVISORY") {
      const duplicateAt = domainEvidenceMode === "ADVERSARIAL_FUTURE_ADVISORY"
        ? offsetFuture : timestamp;
      const duplicateAdvisoryStore = new LocalArtifactStore({
        root: join(root, "artifacts"), now: () => new Date(duplicateAt), idFactory: () => "test-advisory-whitespace",
      });
      const duplicateArtifact = supervisor.recordArtifact(duplicateAdvisoryStore.put({
        runId, type: "TEST_ADVISORY", bytes: JSON.stringify(advisory, null, 2), producerType: "SYSTEM",
        producerId: "tester-agent-2", trusted: false,
      }));
      const duplicateExecution = {
        agentExecutionId: "tester-agent-2", runId, role: "TESTER", modelTier: "GPT-5.6_LUNA",
        inputHash: sha256({ manifest: frozen.manifestHash, diff: currentDiffHash, evidence: [] }),
        startedAt: duplicateAt,
      } as const;
      supervisor.recordAgentExecution({
        ...duplicateExecution, status: "RUNNING", outputArtifactId: null, completedAt: null,
      });
      supervisor.recordAgentExecution({
        ...duplicateExecution, status: "SUCCEEDED", outputArtifactId: duplicateArtifact.artifactId, completedAt: duplicateAt,
      });
    }
    const exact = buildAdversarialCoverageReport(frozen, advisory);
    const payload = domainEvidenceMode === "ADVERSARIAL_STALE"
      ? buildAdversarialCoverageReport(staleManifest, advisory)
      : domainEvidenceMode === "ADVERSARIAL_FORGED_CURRENT"
        ? (() => {
          const { reportHash: _reportHash, ...content } = exact;
          const forgedContent = { ...content, warnings: ["Invented current-manifest warning."] };
          return { ...forgedContent, reportHash: sha256(forgedContent) };
        })()
        : exact;
    const reportStore = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => "adversarial-report",
    });
    const artifact = supervisor.recordArtifact(reportStore.put({
      runId, type: "ADVERSARIAL_COVERAGE_REPORT", bytes: canonicalJson(payload), producerType: "SYSTEM",
      producerId: "adversarial-coverage-policy", trusted: true,
    }));
    return [TrustedEvidenceSchema.parse({
      evidenceId: domainEvidenceMode === "ADVERSARIAL_UNSEEN" ? "unseen-adversarial" : artifact.artifactId,
      runId, eventType: "ADVERSARIAL_COVERAGE_REPORT", producerType: "SYSTEM", producerId: artifact.producerId,
      sha256: artifact.sha256, payload, createdAt: artifact.createdAt,
    })];
  })() : [];
  const durableSecurityFindings = evidenceMode === "SECURITY_VALID_FINDING"
    ? scanDiffForSecurity({ runId, diff: finalDiff, createdAt: timestamp, idFactory: () => "real-security-finding" })
    : evidenceMode === "SEMANTIC_FORGED" ? [SecurityFindingRecordSchema.parse({
    securityFindingId: "semantic-forged-finding", runId, severity: "HIGH", category: "UNSAFE_EVAL",
    description: "A fabricated finding for a safe diff.", file: "src/index.ts", lineStart: 1, lineEnd: 1,
    evidenceIds: [], status: "OPEN", createdAt: timestamp,
  })] : [];
  const durableSecurityPayload = {
    policyVersion: SECURITY_POLICY_VERSION, runId,
    diffHash: evidenceMode === "STALE" ? sha256("stale-diff") : currentDiffHash,
    findings: durableSecurityFindings,
  };
  const securityEvidence = evidenceMode === "NONE" ? [] : (() => {
    if (evidenceMode.startsWith("INDEPENDENT_")) return [];
    const store = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => "security-report",
    });
    const artifact = supervisor.recordArtifact(store.put({
      runId, type: "SECURITY_REPORT", bytes: canonicalJson(durableSecurityPayload),
      producerType: "SYSTEM", producerId: "deterministic-security-scanner", trusted: true,
    }));
    const evidencePayload = evidenceMode === "FORGED"
      ? { ...durableSecurityPayload, diffHash: sha256("forged-diff") }
      : durableSecurityPayload;
    return [TrustedEvidenceSchema.parse({
      evidenceId: evidenceMode === "UNSEEN" ? "unseen-security" : artifact.artifactId,
      runId, eventType: "SECURITY_REPORT", producerType: "SYSTEM",
      producerId: artifact.producerId, sha256: sha256(evidencePayload), payload: evidencePayload, createdAt: artifact.createdAt,
    })];
  })();
  const independentArtifacts = evidenceMode.startsWith("INDEPENDENT_") ? (() => {
    const store = new LocalArtifactStore({
      root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: (() => {
        let artifact = 0;
        return () => named(artifact++ === 0 ? "verification-stdout" : "verification-stderr");
      })(),
    });
    return [
      supervisor.recordArtifact(store.put({ runId, type: "COMMAND_STDOUT", bytes: "ok", producerType: "EXECUTOR", producerId: named("executor-1"), trusted: true })),
      supervisor.recordArtifact(store.put({ runId, type: "COMMAND_STDERR", bytes: "", producerType: "EXECUTOR", producerId: named("executor-1"), trusted: true })),
    ] as const;
  })() : null;
  const independentEvidence = independentArtifacts ? (() => {
    const payload = {
      policyVersion: contract.policyBindings.verificationPolicyVersion, testId, criterionIds: [criterionId],
      type: frozen.testPlan[0]!.type, command: testCommand, commandExecutionId: named("command-1"), status: "SUCCEEDED", exitCode: 0,
      timedOut: false,
      stdoutArtifact: { artifactId: independentArtifacts[0].artifactId, sha256: independentArtifacts[0].sha256 },
      stderrArtifact: { artifactId: independentArtifacts[1].artifactId, sha256: independentArtifacts[1].sha256 },
      environmentDigest: runtime?.environmentDigest??sha256("environment"), commitSha: resultCommitSha,
    };
    const evidencePayload = evidenceMode === "INDEPENDENT_FORGED" ? { ...payload, command: "bun test --forged" } : payload;
    return [TrustedEvidenceSchema.parse({
      evidenceId: evidenceMode === "INDEPENDENT_UNSEEN" ? named("verification-unseen") : named("verification-1"),
      runId, eventType: "INDEPENDENT_VERIFICATION", producerType: "EXECUTOR",
      producerId: named("executor-1"), sha256: sha256(evidencePayload), payload: evidencePayload, createdAt: timestamp,
    })];
  })() : [];
  const trustedEvidence = [integrityEvidence, ...additionalIntegrityEvidence, ...securityEvidence, ...independentEvidence, ...domainEvidence];
  const providerFindingId = "provider-finding-1";
  const findingContent = {
    severity: "HIGH" as const, category: "CORRECTNESS", file: advisoryFile,
    description: "Model claim", requiredChange: "Inspect it",
  };
  const finding = ReviewFindingRecordSchema.parse({
    reviewerSessionId: named("review-1"),
    findingId: sha256({ namespace: "review-finding-record-v1", reviewerSessionId: named("review-1"), providerFindingId }),
    fingerprint: sha256({
      severity: findingContent.severity, category: findingContent.category.toLowerCase(), file: findingContent.file,
      description: findingContent.description.toLowerCase(), requiredChange: findingContent.requiredChange.toLowerCase(),
    }),
    ...findingContent, lineStart: 1, lineEnd: 1, criterionIds: [criterionId], evidenceIds: [], status: "OPEN",
  });
  const advisoryFinding = ReviewFindingRecordSchema.parse({ ...finding, criterionIds: [] });
  const advisoryFindings = [advisoryFinding, ...additionalAdvisoryFiles.map((file,index)=>{
    const extraProviderId=`provider-finding-${index+2}`;const extraContent={...findingContent,file,description:`Model claim ${index+2}`};
    return ReviewFindingRecordSchema.parse({...finding,...extraContent,criterionIds:[],findingId:sha256({namespace:"review-finding-record-v1",reviewerSessionId:"review-1",providerFindingId:extraProviderId}),
      fingerprint:sha256({severity:extraContent.severity,category:extraContent.category.toLowerCase(),file:extraContent.file,description:extraContent.description.toLowerCase(),requiredChange:extraContent.requiredChange.toLowerCase()})});})];
  const outputFindings = readyCandidate && readyWithAdvisory ? advisoryFindings : [finding];
  const reviewerInputContent = {
    reviewSessionId: named("review-1"), runId, reviewAttempt, manifest: frozen, manifestHash: frozen.manifestHash,
    finalDiff, diffHash: currentDiffHash, trustedEvidence, riskAssessment: null,
    resultCommitSha, reviewPolicyVersion: "reviewer-v1", createdAt: timestamp,
  };
  const reviewerInput = ReviewerInputSchema.parse({
    ...reviewerInputContent, evidenceBundleHash: reviewerEvidenceBundleHash(reviewerInputContent),
  });
  const output = {
    decision: readyCandidate ? "APPROVE" as const : "HUMAN_REVIEW_REQUIRED" as const,
    requirementCoverage: [{
      criterionId, status: readyCandidate ? "SATISFIED" as const : "UNVERIFIED" as const,
      evidenceIds: readyCandidate ? [named("verification-1")] : [], explanation: readyCandidate ? "Independent test passed." : "No proof",
    }],
    findings: readyCandidate && !readyWithAdvisory ? [] : outputFindings.map((outputFinding,index)=>({
      findingId: index===0?providerFindingId:`provider-finding-${index+1}`, severity: outputFinding.severity, category: outputFinding.category, file: outputFinding.file,
      lineStart: outputFinding.lineStart, lineEnd: outputFinding.lineEnd, description: outputFinding.description, requiredChange: outputFinding.requiredChange,
      criterionIds: outputFinding.criterionIds, evidenceIds: outputFinding.evidenceIds,
    })),
    unsupportedClaims: [], residualRisks: [], reviewedDiffHash: reviewerInput.diffHash,
    reviewedEvidenceBundleHash: reviewerInput.evidenceBundleHash,
    reviewPolicyVersion: "reviewer-v1",
  };
  const rawBytes = JSON.stringify(output);
  const artifactStore = new LocalArtifactStore({ root: join(root, "artifacts"), now: () => new Date(timestamp), idFactory: () => named("raw-output") });
  const rawArtifact = supervisor.recordArtifact(artifactStore.put({
    runId, type: "REVIEWER_RAW_OUTPUT", bytes: rawBytes, producerType: "SYSTEM", producerId: named("review-1"), trusted: true,
  }));
  if(!existing)supervisor.close();
  const stateDb = new Database(dbPath);
  const preReviewRun = stateDb.query("SELECT state, state_version, manifest_hash FROM engineer_runs WHERE id = ?")
    .get(runId) as { state: string; state_version: number; manifest_hash: string };
  if(preReviewRun.state!=="REVIEWING")stateDb.query(`INSERT INTO run_state_events
    (event_id, run_id, sequence, previous_state, next_state, reason_code, actor_type, actor_id,
     timestamp, evidence_ids_json, manifest_hash, state_version, idempotency_key)
    VALUES (?, ?, ?, ?, 'REVIEWING', 'TEST_REVIEW_READY', 'SUPERVISOR', 'test-review-fixture', ?, '[]', ?, ?, ?)`)
    .run(`${runId}-review-ready-event`, runId, preReviewRun.state_version + 1, preReviewRun.state,
      timestamp, preReviewRun.manifest_hash, preReviewRun.state_version + 1, `${runId}:review-ready`);
  if(preReviewRun.state!=="REVIEWING")stateDb.query("UPDATE engineer_runs SET state = 'REVIEWING', state_version = state_version + 1 WHERE id = ?").run(runId);
  for (const securityFinding of durableSecurityFindings) {
    stateDb.query(`INSERT INTO security_findings
      (id, run_id, severity, category, description, file, line_start, line_end,
       evidence_ids_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      securityFinding.securityFindingId, securityFinding.runId, securityFinding.severity,
      securityFinding.category, securityFinding.description, securityFinding.file,
      securityFinding.lineStart, securityFinding.lineEnd, canonicalJson(securityFinding.evidenceIds),
      securityFinding.status, securityFinding.createdAt,
    );
  }
  if (domainEvidenceMode === "INTEGRITY_DUPLICATE_AUDIT_ASOF" ||
      domainEvidenceMode === "INTEGRITY_FUTURE_DUPLICATE_AUDIT") {
    stateDb.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES (?, ?, 'TEST_INTEGRITY_ATTESTED', 'SUPERVISOR', 'engineer-supervisor-test-integrity', ?, ?)`).run(
      `duplicate-integrity-audit-${runId}`, runId, canonicalJson({
        artifactId: integrityArtifact.artifactId, comparisonHash: integrity.comparisonHash,
        baselineHash: integrity.baselineHash, stage: integrity.stage, passed: integrity.passed,
      }), domainEvidenceMode === "INTEGRITY_FUTURE_DUPLICATE_AUDIT" ? offsetFuture : timestamp,
    );
  }
  if (domainEvidenceMode === "SCOPE_FUTURE_GIT" || domainEvidenceMode === "SCOPE_OFFSET_EARLIER_GIT" ||
      domainEvidenceMode === "SCOPE_INVALID_GIT") {
    // This row models pre-v22 historical scope evidence. Temporarily remove
    // only the new-write guard, then restore its exact installed definition.
    stateDb.exec("DROP TRIGGER require_new_git_checkpoint_v22");
    stateDb.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference,
       started_at, completed_at, error_code)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, NULL, NULL)`).run(
      "future-git-operation", runId, "PUSH", "human", "future-git-key",
      frozen.repository.baseCommitSha, "STARTED",
      domainEvidenceMode === "SCOPE_OFFSET_EARLIER_GIT" ? offsetEarlier
        : domainEvidenceMode === "SCOPE_INVALID_GIT" ? "not-a-time" : offsetFuture,
    );
    const legacyGitGuard = ENGINEER_DATABASE_MIGRATION_22_SQL.match(
      /CREATE TRIGGER require_new_git_checkpoint_v22[\s\S]*?\n\s*END;/,
    )?.[0];
    if (!legacyGitGuard) throw new Error("v22 Git guard fixture is unavailable");
    stateDb.exec(legacyGitGuard);
  }
  if (independentArtifacts) {
    stateDb.query(`INSERT INTO sandboxes
      (id, run_id, workspace_identity, image_digest, environment_digest, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(named("sandbox-1"), runId, `workspace-${runId}`, sha256("image"), runtime?.environmentDigest??sha256("environment"), "ACTIVE", timestamp);
    stateDb.query(`INSERT INTO command_executions
      (id, run_id, sandbox_id, command, executor_id, exit_code, started_at, finished_at,
       stdout_artifact_id, stderr_artifact_id, environment_digest, commit_sha, status, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        named("command-1"), runId, named("sandbox-1"), testCommand, named("executor-1"), 0, timestamp, timestamp,
        independentArtifacts[0].artifactId, independentArtifacts[1].artifactId, runtime?.environmentDigest??sha256("environment"), resultCommitSha,
        "SUCCEEDED", named("command-key"),
      );
    stateDb.query(`INSERT INTO test_executions
      (id, run_id, command_execution_id, type, verification_pass, random_seed, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(named("verification-1"), runId, named("command-1"), frozen.testPlan[0]!.type, 1, "PASSED", timestamp, timestamp);
    stateDb.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        named("verification-audit"), runId, "VERIFICATION_EXECUTED", "EXECUTOR", named("executor-1"),
        canonicalJson({ verificationExecutionId: named("verification-1"), testId, criterionIds: [criterionId], commandExecutionId: named("command-1"), type: frozen.testPlan[0]!.type, status: "PASSED" }), timestamp,
      );
    if (evidenceMode === "INDEPENDENT_STALE") {
      stateDb.query(`INSERT INTO test_executions
        (id, run_id, command_execution_id, type, verification_pass, random_seed, status, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run("verification-newer", runId, "command-1", "UNIT", 2, "PASSED", timestamp, timestamp);
      stateDb.query(`INSERT INTO audit_events
        (id, run_id, action, actor_type, actor_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "verification-newer-audit", runId, "VERIFICATION_EXECUTED", "EXECUTOR", "executor-1",
        canonicalJson({ verificationExecutionId: "verification-newer", testId: "test-1", criterionIds: ["must-1"], commandExecutionId: "command-1", type: "UNIT", status: "PASSED" }), timestamp,
      );
    }
    if (evidenceMode === "INDEPENDENT_FUTURE_PASS") {
      stateDb.query(`INSERT INTO test_executions
        (id, run_id, command_execution_id, type, verification_pass, random_seed, status, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
        "verification-future", runId, "command-1", "UNIT", 2, "PASSED",
        offsetFuture, offsetFuture,
      );
    }
    if (evidenceMode === "INDEPENDENT_TAMPERED") {
      writeFileSync(independentArtifacts[0].storageReference, "tampered executor output");
    }
  }
  stateDb.close();
  const session = ReviewerSessionRecordSchema.parse({
    reviewerSessionId: named("review-1"), runId, attempt: reviewAttempt, modelTier: "GPT-5.6_SOL", resolvedModel: "gpt-5.6",
    inputHash: sha256(reviewerInput), manifestHash: frozen.manifestHash, diffHash: output.reviewedDiffHash,
    evidenceBundleHash: output.reviewedEvidenceBundleHash, policyVersion: output.reviewPolicyVersion,
    cacheKey: sha256("cache"), cacheHit: null, startedAt: timestamp, completedAt: timestamp,
    decision: output.decision, isolationVerified: true, output,
  });
  const rawOutput = {
    artifactId: rawArtifact.artifactId, sha256: rawArtifact.sha256,
    byteLength: rawArtifact.sizeBytes, mediaType: "application/json" as const,
  };
  const classifiedFindings = readyCandidate ? (readyWithAdvisory ? advisoryFindings : []) : [finding];
  const batch = classifyReviewerOutput({ contract, manifest: frozen, session, findings: classifiedFindings, trustedEvidence, rawOutput });
  const authority = { reviewerInput, rawOutputArtifact: rawArtifact };
  return { root, dbPath, frozen, contract, finding, findings: classifiedFindings, session, batch, rawOutput, rawArtifact, reviewerInput, authority };
}

const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256", keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

function promotionFixture(runId: string, readyWithAdvisory = false, advisoryFile = "src/index.ts", additionalAdvisoryFiles: string[] = [],
  existing?:{root:string;dbPath:string;supervisor:ReturnType<typeof createEngineerSupervisor>;artifactStore?:LocalArtifactStore},
  runtime?:{repository:RepositoryReference;finalDiff:string;resultCommitSha:string;environmentDigest?:string}) {
  let artifactSequence=0;
  const existingStore=existing?.artifactStore??(existing?new LocalArtifactStore({
    root:join(existing.root,"artifacts"),now:()=>new Date(timestamp),idFactory:()=>`${runId}-artifact-${++artifactSequence}`}):undefined);
  if(existingStore)existing!.supervisor.configureArtifactReadAuthority(existingStore);
  const value = setup(runId, "INDEPENDENT_VALID", "SCOPE_VALID", true, readyWithAdvisory, advisoryFile, additionalAdvisoryFiles, existing,runtime);
  const supervisor = existing?.supervisor??createEngineerSupervisor({
    dbPath: value.dbPath, idFactory: () => `${runId}-promotion-id`, now: () => new Date(timestamp), checkpointAttestor,
    hardeningPromptCacheSecret,
  });
  const builderStore = existingStore??new LocalArtifactStore({
    root: join(value.root, "artifacts"), now: () => new Date(timestamp), idFactory: () => `${runId}-artifact-${++artifactSequence}`,
  });
  supervisor.configureArtifactReadAuthority(builderStore);
  supervisor.recordClassifiedReviewerSession(value.session, value.findings, value.batch, value.authority);
  const claim = supervisor.recordClaimEvidence({
    claimId: `${runId}-claim`, runId, criterionId: value.contract.requiredCriterionIds[0]!, claim: "The required behavior is verified.",
    status: "VERIFIED", evidenceIds: ["verification-1"], notes: "Bound to the required test.", createdAt: timestamp,
  });
  const builderArtifact = supervisor.recordArtifact(builderStore.put({
    runId, type: "BUILDER_RESULT", bytes: canonicalJson({
      runId, manifestHash: value.frozen.manifestHash, model: "gpt-5.6-terra", responseIds: [`${runId}-response`],
      changedFiles: [], diff: value.reviewerInput.finalDiff, diffHash: value.reviewerInput.diffHash,
      requestedCommands: [], commandExecutionIds: [], implementationSummary: "complete",
      unresolvedLimitations: [], completedAt: timestamp,
    }),
    producerType: "SYSTEM", producerId: "codex-builder-adapter", trusted: false,
  }));
  const builder = {
    agentExecutionId: `${runId}-builder`, runId, role: "BUILDER" as const, modelTier: "GPT-5.6_TERRA" as const,
    status: "RUNNING" as const, inputHash: sha256(`${runId}-builder-input`), outputArtifactId: null,
    startedAt: timestamp, completedAt: null,
  };
  supervisor.claimBuilderDispatch(builder, { ownerId: `${runId}-worker`, fencingToken: 1 });
  supervisor.recordAgentExecution({ ...builder, status: "SUCCEEDED", outputArtifactId: builderArtifact.artifactId, completedAt: timestamp });
  const scope = value.reviewerInput.trustedEvidence.find((item) => item.eventType === "FINAL_CHANGE_SCOPE_ATTESTATION")!;
  const independent = value.reviewerInput.trustedEvidence.find((item) => item.eventType === "INDEPENDENT_VERIFICATION")!;
  const db = new Database(value.dbPath);
  const scopeRow = db.query("SELECT type, size_bytes FROM artifacts WHERE id = ?").get(scope.evidenceId) as { type: string; size_bytes: number };
  db.close();
  const bundle = {
    bundleVersion: 2, runId, reviewerSessionId: value.session.reviewerSessionId,
    classificationHash: value.batch.classificationHash, classificationResult: value.batch.result,
    manifestHash: value.frozen.manifestHash, baseCommitSha: value.frozen.repository.baseCommitSha,
    resultCommitSha: value.reviewerInput.resultCommitSha,
    environmentDigest: String(independent.payload.environmentDigest),
    artifacts: [{
      artifactId: scope.evidenceId, type: scopeRow.type, sha256: scope.sha256, createdAt: scope.createdAt,
      producer: scope.producerId, sizeBytes: scopeRow.size_bytes,
    }],
    claims: [{ claimId: claim.claimId, claim: claim.claim, status: claim.status, evidenceIds: claim.evidenceIds, notes: claim.notes }],
    finalDecision: "APPROVE", createdAt: timestamp,
  };
  const evidenceBundle = supervisor.recordEvidenceBundle({
    evidenceBundleId: `${runId}-bundle`, bundle, bundleHash: sha256(bundle),
  });
  const run = supervisor.getRun(runId);
  const promotion: PromoteVerifiedCandidateInput = {
    runId, reviewerSessionId: value.session.reviewerSessionId, classificationHash: value.batch.classificationHash,
    evidenceBundleId: evidenceBundle.evidenceBundleId, attestor: checkpointAttestor,
  };
  return { ...value, supervisor, run, promotion, builderArtifact, artifactStore: builderStore };
}

async function hardeningConsentFixture(runId:string,additionalAdvisoryFiles:string[]=[],runtime?:{repository:RepositoryReference;finalDiff:string;resultCommitSha:string;environmentDigest?:string}){
  const value=promotionFixture(runId,true,"src/index.ts",additionalAdvisoryFiles,undefined,runtime);
  await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
  const parent=value.supervisor.getRun(runId);
  const advisories=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,runId)).items;
  const advisoryIds=advisories.map((item)=>item.advisoryId).sort();
  const quote=await value.supervisor.createHardeningQuoteForOwner(value.run.userId,{runId,advisoryIds,
    expectedParentStateVersion:parent.stateVersion,idempotencyKey:`${runId}-quote`});
  const consent=await value.supervisor.acceptHardeningConsentForOwner(value.run.userId,runId,{quoteId:quote.quoteId,quoteHash:quote.quoteHash,
    authorizedBudget:{costMicrousd:quote.estimate.maxCostMicrousd,tokens:quote.estimate.maxTokens,timeSeconds:quote.estimate.maxTimeSeconds},
    acknowledgements:{separateRun:true,parentCandidateUnchanged:true,noAutomaticRepair:true,noOverages:true},
    expectedParentStateVersion:parent.stateVersion,idempotencyKey:`${runId}-consent`});
  return {...value,parent,advisories,quote,consent};
}

function hardeningStartFenceInput(value:Awaited<ReturnType<typeof hardeningConsentFixture>>,prepared:OptionalHardeningStartPreparation,ownerId="test-hardening-worker"){
  return {requesterUserId:value.run.userId,rootRunId:prepared.lineage.rootRunId,parentRunId:value.run.runId,
    childRunId:prepared.operation.childRunId,repositoryId:prepared.lineage.repositoryId,parentCheckpointId:prepared.parentCheckpoint.checkpointId,
    parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,lineageId:prepared.lineage.lineageId,lineageHash:prepared.lineage.lineageHash,
    quoteId:prepared.lineage.quoteId,quoteHash:prepared.lineage.quoteHash,consentId:prepared.lineage.consentId,consentHash:prepared.lineage.consentHash,
    operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,idempotencyKey:prepared.operation.idempotencyKey,ownerId,leaseMs:120_000};
}

async function commitHardeningStartFixture(value:Awaited<ReturnType<typeof hardeningConsentFixture>>,parentRunId:string,childRunId:string,
  input:import("./hardening-start-contracts.js").HardeningStartRequest,prepared:OptionalHardeningStartPreparation,
  signedSeed:Awaited<ReturnType<typeof createSignedHardeningSeedAttestation>>){
  const fence=value.supervisor.claimOptionalHardeningStart(hardeningStartFenceInput(value,prepared));
  const preview=value.supervisor.previewOptionalHardeningStart({...prepared,signedSeed});if(preview.status!=="READY")throw new Error("test hardening manifest unavailable");
  const sandbox={sandboxId:`seed-sandbox-${childRunId}`,runId:childRunId,workspaceIdentity:`seed-workspace-${childRunId}`,imageReference:"oven/bun:test",
    imageDigest:signedSeed.attestation.imageDigest,environmentDigest:signedSeed.attestation.environmentDigest,networkPolicyVersion:"offline-v1",
    sandboxPolicyVersion:"test-v1",status:"READY" as const,source:"COLD" as const,createdAt:prepared.operation.createdAt,destroyedAt:null};
  const store=new LocalArtifactStore({root:join(value.root,"artifacts"),now:()=>new Date(timestamp),idFactory:()=>`checkpoint-${childRunId}`});
  const checkpoint=store.put({runId:childRunId,type:"SANDBOX_WORKSPACE_CHECKPOINT",bytes:canonicalJson({manifestHash:preview.manifest.manifestHash,sandbox}),
    producerType:"SYSTEM",producerId:"engineer-execution-manager",trusted:true});
  let id=0;const committer=createEngineerSupervisor({dbPath:value.dbPath,idFactory:()=>`atomic-${childRunId}-${++id}`,now:()=>new Date(timestamp),checkpointAttestor});
  committer.configureArtifactReadAuthority(value.artifactStore);
  try{return await committer.commitOptionalHardeningStartForOwner(value.run.userId,parentRunId,childRunId,input,prepared.operation,signedSeed,
    {claimId:fence.fence.claimId,fenceToken:fence.fence.fenceToken,generation:fence.fence.generation},{sandbox,checkpoint});}finally{committer.close();}
}

async function signedHardeningSeedFixture(prepared:OptionalHardeningStartPreparation,tag:string){
  return createSignedHardeningSeedAttestation({schemaVersion:1,policyVersion:"engineer-hardening-seed-attestation-v1",
    attestationType:"HARDENING_SEED_VERIFIED",operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,
    rootRunId:prepared.lineage.rootRunId,parentRunId:prepared.lineage.parentRunId,childRunId:prepared.lineage.childRunId,
    requesterUserId:prepared.lineage.requesterUserId,repositoryId:prepared.lineage.repositoryId,lineageId:prepared.lineage.lineageId,
    lineageHash:prepared.lineage.lineageHash,parentCheckpointId:prepared.parentCheckpoint.checkpointId,
    parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,baseCommitSha:prepared.seed.baseCommitSha,
    seedResultCommitSha:prepared.seed.seedResultCommitSha,seedTreeHash:sha256(`${tag}-tree`),seedDiffHash:prepared.seed.diffHash,
    imageDigest:sha256(`${tag}-image`),environmentDigest:prepared.seed.environmentDigest,dependencyHash:sha256(`${tag}-dependencies`),
    createdAt:prepared.operation.createdAt},checkpointAttestor);
}

async function pendingSettledHardeningBuilderFixture(tag:string){
  const value=await hardeningConsentFixture(`run-hardening-terminal-${tag}`);
  const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
    {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
  const startInput={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,
    lineageHash:creation.lineage.lineageHash,idempotencyKey:`terminal-${tag}-start`};
  const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,
    creation.child.childRunId,startInput);
  const signedSeed=await signedHardeningSeedFixture(prepared,`terminal-${tag}`);
  await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,startInput,prepared,signedSeed);
  let transitionId=0;const supervisor=createEngineerSupervisor({dbPath:value.dbPath,
    idFactory:()=>`terminal-${tag}-transition-${++transitionId}`,now:()=>new Date(timestamp),
    checkpointAttestor,hardeningPromptCacheSecret});
  const recoveryLeaseManager=new EngineerWorkerLeaseManager({dbPath:join(value.root,"recovery-worker-leases.db"),
    tokenSecret:"terminal-recovery-worker-lease-secret-0000000000000000",maxConcurrentLeases:4,
    now:()=>new Date(timestamp),recoverExpiredLease:()=>undefined});
  supervisor.configureRecoveryWorkerLeaseAuthority(recoveryLeaseManager);
  let child=supervisor.getRun(creation.child.childRunId);
  for(const nextState of ["QUEUED","SANDBOX_READY","IMPLEMENTING"] as const){
    child=supervisor.transition({runId:child.runId,expectedStateVersion:child.stateVersion,nextState,
      reasonCode:`TERMINAL_TEST_${nextState}`,idempotencyKey:`terminal-${tag}:${nextState}:${child.stateVersion}`}).run;
  }
  const ledger=new EngineerLedger(value.dbPath,()=>new Date(timestamp),hardeningPromptCacheSecret);
  const agentExecutionId=`terminal-${tag}-builder`,routingDecisionId=`terminal-${tag}-route`;
  expect(ledger.claimBuilderDispatch({agentExecutionId,runId:child.runId,role:"BUILDER",modelTier:"GPT-5.6_TERRA",
    status:"RUNNING",inputHash:sha256(`terminal-${tag}-input`),outputArtifactId:null,startedAt:timestamp,completedAt:null}).won).toBe(true);
  ledger.recordModelRouting({routingDecisionId,runId:child.runId,agentExecutionId,agentRole:"BUILDER",
    logicalTier:"GPT-5.6_TERRA",resolvedModel:"gpt-5.6-terra",routingPolicyVersion:"engineer-model-routing-v2",
    fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp});
  const nowMs=Date.parse(timestamp),fence=ledger.acquireHardeningExecutionFence({childRunId:child.runId,
    ownerId:`terminal-${tag}-worker`,ttlMs:10_000,nowMs,idempotencyKey:`terminal-${tag}-fence`});
  const prefix=builderStaticRequestPrefix("gpt-5.6-terra");
  const reservation=ledger.reserveHardeningPaidCall({childRunId:child.runId,role:"BUILDER",modelTier:"GPT-5.6_TERRA",
    resolvedModel:"gpt-5.6-terra",routingDecisionId,agentExecutionId,inputTokenUpperBound:100,outputTokenCeiling:6_000,
    reservationIdempotencyKey:`terminal-${tag}-reservation`,requestHash:sha256(`terminal-${tag}-request`),
    cacheDescriptor:createHardeningPromptCacheMaterial({secret:hardeningPromptCacheSecret,requesterUserId:value.run.userId,
      childRunId:child.runId,role:"BUILDER",resolvedModel:"gpt-5.6-terra",promptOrReviewerPolicyVersion:"engineer-codex-builder-v3",
      staticPrefix:prefix,toolSchema:prefix.tools}).descriptor,fenceOwnerId:fence.ownerId,
    fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
  ledger.markHardeningPaidCallDispatching({childRunId:child.runId,reservationId:reservation.reservation.reservationId,
    requestHash:reservation.reservation.requestHash,clientRequestId:reservation.reservation.clientRequestId,
    fenceOwnerId:fence.ownerId,fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
  const providerResponse={id:`terminal-${tag}-response`,usage:{input_tokens:3,output_tokens:2,
    input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}};
  const store=new LocalArtifactStore({root:join(value.root,"artifacts"),now:()=>new Date(timestamp),
    idFactory:()=>`terminal-${tag}-provider-artifact`});
  ledger.configureHardeningArtifactReader((artifact)=>store.readVerifiedExact(artifact));
  supervisor.configureArtifactReadAuthority(store);
  const providerArtifact=ledger.recordArtifact(store.put({runId:child.runId,type:"MODEL_PROVIDER_RESPONSE",
    bytes:JSON.stringify(providerResponse),producerType:"SYSTEM",producerId:"engineer-provider-response-recorder",trusted:true}));
  const modelCall={modelCallId:`terminal-${tag}-call`,runId:child.runId,agentExecutionId,logicalTier:"GPT-5.6_TERRA" as const,
    resolvedModel:"gpt-5.6-terra",promptTemplateVersion:"engineer-codex-builder-v3",
    inputContextRefs:[ledger.getRun(child.runId).manifestHash!,sha256(`terminal-${tag}-provider-input`),
      reservation.reservation.requestHash,reservation.reservation.clientRequestId,providerResponse.id],
    outputSchemaVersion:null,cacheKey:reservation.reservation.promptCacheKeyHash,cacheHit:false,latencyMs:1,
    inputTokens:3,outputTokens:2,cachedInputTokens:0,cacheWriteInputTokens:0,retryCount:0,status:"SUCCEEDED" as const,
    createdAt:timestamp};
  ledger.recordHardeningPaidCallResponse({childRunId:child.runId,reservationId:reservation.reservation.reservationId,
    requestHash:reservation.reservation.requestHash,clientRequestId:reservation.reservation.clientRequestId,modelCall,
    providerResponseId:providerResponse.id,providerResponseArtifactId:providerArtifact.artifactId,fenceOwnerId:fence.ownerId,
    fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
  expect(ledger.settleHardeningPaidCall({childRunId:child.runId,reservationId:reservation.reservation.reservationId,
    modelCall,providerResponseId:providerResponse.id,providerResponseArtifactId:providerArtifact.artifactId,
    settlementIdempotencyKey:`terminal-${tag}-settlement`,fenceOwnerId:fence.ownerId,
    fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs})).toEqual({status:"SETTLED",stopReason:null});
  ledger.releaseHardeningExecutionFence({childRunId:child.runId,ownerId:fence.ownerId,fenceGeneration:fence.fenceGeneration,
    rawFenceToken:fence.rawFenceToken,nowMs});
  return {value,supervisor,ledger,recoveryLeaseManager,child,agentExecutionId,reservation,providerArtifact,modelCall,nowMs};
}

async function preReservationHardeningBuilderFixture(tag:string){
  const value=await hardeningConsentFixture(`run-hardening-pre-reservation-${tag}`);
  const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
    {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
  const startInput={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,
    lineageHash:creation.lineage.lineageHash,idempotencyKey:`pre-reservation-${tag}-start`};
  const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,
    creation.child.childRunId,startInput);
  const signedSeed=await signedHardeningSeedFixture(prepared,`pre-reservation-${tag}`);
  await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,startInput,prepared,signedSeed);
  let transitionId=0;
  const supervisor=createEngineerSupervisor({dbPath:value.dbPath,
    idFactory:()=>`pre-reservation-${tag}-transition-${++transitionId}`,now:()=>new Date(timestamp),
    checkpointAttestor,hardeningPromptCacheSecret});
  const recoveryLeaseManager=new EngineerWorkerLeaseManager({dbPath:join(value.root,"recovery-worker-leases.db"),
    tokenSecret:"pre-reservation-worker-lease-secret-000000000000000000",maxConcurrentLeases:4,
    now:()=>new Date(timestamp),recoverExpiredLease:()=>undefined});
  supervisor.configureRecoveryWorkerLeaseAuthority(recoveryLeaseManager);
  let child=supervisor.getRun(creation.child.childRunId);
  for(const nextState of ["QUEUED","SANDBOX_READY","IMPLEMENTING"] as const){
    child=supervisor.transition({runId:child.runId,expectedStateVersion:child.stateVersion,nextState,
      reasonCode:`PRE_RESERVATION_TEST_${nextState}`,
      idempotencyKey:`pre-reservation-${tag}:${nextState}:${child.stateVersion}`}).run;
  }
  const ledger=new EngineerLedger(value.dbPath,()=>new Date(timestamp),hardeningPromptCacheSecret);
  const agentExecutionId=`pre-reservation-${tag}-builder`;
  ledger.recordAgentExecution({agentExecutionId,runId:child.runId,role:"BUILDER",modelTier:"GPT-5.6_TERRA",
    status:"RUNNING",inputHash:sha256(`pre-reservation-${tag}-input`),outputArtifactId:null,
    startedAt:timestamp,completedAt:null});
  ledger.recordModelRouting({routingDecisionId:`pre-reservation-${tag}-route`,runId:child.runId,
    agentExecutionId,agentRole:"BUILDER",logicalTier:"GPT-5.6_TERRA",resolvedModel:"gpt-5.6-terra",
    routingPolicyVersion:"engineer-model-routing-v2",fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp});
  return {value,supervisor,ledger,recoveryLeaseManager,child,agentExecutionId,nowMs:Date.parse(timestamp)};
}

type RecoveryLeaseFixture={child:{runId:string};recoveryLeaseManager:EngineerWorkerLeaseManager};

function acquireFixtureRecoveryLease(fixture:RecoveryLeaseFixture,
  ownerId:string,idempotencyKey:string):WorkerLeaseGrant{
  return fixture.recoveryLeaseManager.acquire({resourceKey:`run:${fixture.child.runId}`,ownerId,ttlMs:30_000,idempotencyKey});
}

function releaseFixtureRecoveryLease(fixture:RecoveryLeaseFixture,
  lease:WorkerLeaseGrant,idempotencyKey:string):void{
  fixture.recoveryLeaseManager.release({leaseId:lease.lease.leaseId,ownerId:lease.lease.ownerId,
    fencingToken:lease.lease.fencingToken,leaseToken:lease.leaseToken,idempotencyKey});
}

function fixtureRecoveryProof(lease:WorkerLeaseGrant){
  return {leaseId:lease.lease.leaseId,ownerId:lease.lease.ownerId,
    fencingToken:lease.lease.fencingToken,leaseToken:lease.leaseToken};
}

describe("classified Reviewer ledger persistence", () => {
  test("revalidates real signed hardening Builder authority before reservation and dispatch with no provider work", async () => {
    for(const seam of ["BEFORE_RESERVATION","BEFORE_DISPATCH"] as const){
      const repositoryRoot=mkdtempSync(join(tmpdir(),`zintus-hardening-builder-race-${seam.toLowerCase()}-`));
      let value:Awaited<ReturnType<typeof hardeningConsentFixture>>|null=null;
      let workerLeases:EngineerWorkerLeaseManager|null=null;
      try{
        mkdirSync(join(repositoryRoot,"src"),{recursive:true});
        writeFileSync(join(repositoryRoot,"src/index.ts"),"export const value = 1;\n");
        execFileSync("git",["init","-q","-b","main",repositoryRoot]);
        execFileSync("git",["-C",repositoryRoot,"config","user.email","test@zintus.local"]);
        execFileSync("git",["-C",repositoryRoot,"config","user.name","Zintus Test"]);
        execFileSync("git",["-C",repositoryRoot,"add","."]);
        execFileSync("git",["-C",repositoryRoot,"commit","-qm","base"]);
        const baseCommitSha=execFileSync("git",["-C",repositoryRoot,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
        writeFileSync(join(repositoryRoot,"src/index.ts"),"export const value = 2;\n");
        execFileSync("git",["-C",repositoryRoot,"add","."]);
        execFileSync("git",["-C",repositoryRoot,"commit","-qm","verified parent candidate"]);
        const parentResultCommitSha=execFileSync("git",["-C",repositoryRoot,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
        const parentDiff=execFileSync("git",["-C",repositoryRoot,"diff","--binary",baseCommitSha,parentResultCommitSha,"--"],{encoding:"utf8"}).trim();
        execFileSync("git",["-C",repositoryRoot,"reset","--hard","-q",baseCommitSha]);
        const digest=`sha256:${"b".repeat(64)}`;
        const environmentDigest=sha256({imageDigest:digest,offlineDependencyHash:null,sandboxPolicyVersion:SANDBOX_POLICY_VERSION,
          networkPolicyVersion:NETWORK_POLICY_VERSION,limits:{cpus:2,memory:"2g",pids:256}});
        const repositoryReference:RepositoryReference={repositoryId:`repo-hardening-builder-race-${seam.toLowerCase()}`,
          provider:"local",owner:"local",name:"hardening-builder-race",baseBranch:"main",baseCommitSha};
        value=await hardeningConsentFixture(`run-hardening-builder-race-${seam.toLowerCase()}`,[],{
          repository:repositoryReference,finalDiff:parentDiff,resultCommitSha:parentResultCommitSha,environmentDigest,
        });
        value.supervisor.close();
        let supervisorId=0;
        value.supervisor=createEngineerSupervisor({dbPath:value.dbPath,
          idFactory:()=>`builder-race-${seam.toLowerCase()}-${++supervisorId}`,now:()=>new Date(timestamp),
          checkpointAttestor,hardeningPromptCacheSecret});
        value.supervisor.configureArtifactReadAuthority(value.artifactStore);
        const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
          {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
        const workspaceManager=new GitWorkspaceManager({workspaceRoot:join(value.root,`builder-race-${seam.toLowerCase()}-workspaces`)});
        const dockerSpawn=((_:string,args:readonly string[])=>{
          const stdout=args[0]==="image"?JSON.stringify([`oven/bun@${digest}`]):args[0]==="info"?"27.0.0":"1 pass";
          return {pid:1,status:0,signal:null,stdout,stderr:"",output:[null,stdout,""],error:undefined};
        }) as typeof import("node:child_process").spawnSync;
        const sandboxManager=new DockerSandboxManager({workspaceManager,imageReference:`oven/bun@${digest}`,
          imageDigest:digest,dockerSpawn});
        workerLeases=new EngineerWorkerLeaseManager({dbPath:join(value.root,`builder-race-${seam.toLowerCase()}-leases.db`),
          tokenSecret:`builder-race-${seam.toLowerCase()}-lease-secret-0000000000000000`,maxConcurrentLeases:2,
          now:()=>new Date(timestamp),recoverExpiredLease:()=>undefined});
        value.supervisor.configureRecoveryWorkerLeaseAuthority(workerLeases);
        let providerLookups=0,providerCreates=0,mutations=0,workspaceRoot="";
        const execution=new EngineerExecutionManager({supervisor:value.supervisor,sandboxManager,artifactStore:value.artifactStore,
          repositoryRootFor:(repositoryId)=>{expect(repositoryId).toBe(repositoryReference.repositoryId);return repositoryRoot;},
          transportForRun:()=>{providerLookups+=1;return {countInputTokens:async()=>1,create:async()=>{
            providerCreates+=1;throw new Error("provider must remain fenced");}};},
          builderOptions:{maxRounds:1},hardeningPromptCacheSecret,leaseManager:workerLeases,
          workerOwnerId:`builder-race-${seam.toLowerCase()}-worker`,now:()=>new Date(timestamp),
          afterHardeningBuilderAuthorityCheckedForTest:(stage)=>{
            if(stage===seam&&mutations===0){mutations+=1;
              writeFileSync(join(workspaceRoot,"src/index.ts"),`export const tamperedAt = ${JSON.stringify(seam)};\n`);}
          }});
        const startInput={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,
          lineageHash:creation.lineage.lineageHash,idempotencyKey:`builder-race-${seam.toLowerCase()}-start`};
        const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,
          creation.child.childRunId,startInput);
        const startClaim=value.supervisor.claimOptionalHardeningStart(hardeningStartFenceInput(value,prepared,
          `builder-race-${seam.toLowerCase()}-start-worker`));
        const signedSeed=await execution.materializeOptionalHardeningSeed(prepared,checkpointAttestor);
        const preview=value.supervisor.previewOptionalHardeningStart({...prepared,signedSeed});
        if(preview.status!=="READY")throw new Error("Builder race fixture could not freeze the child manifest");
        const durable=execution.prepareOptionalHardeningSeedCommit(creation.child.childRunId,preview.manifest.manifestHash);
        workspaceRoot=(JSON.parse(value.artifactStore.readVerifiedExact(durable.checkpoint).toString("utf8")) as {
          workspace:{workspaceRoot:string};
        }).workspace.workspaceRoot;
        const committed=await value.supervisor.commitOptionalHardeningStartForOwner(value.run.userId,value.run.runId,
          creation.child.childRunId,startInput,prepared.operation,signedSeed,{claimId:startClaim.fence.claimId,
            fenceToken:startClaim.fence.fenceToken,generation:startClaim.fence.generation},durable);
        execution.completeOptionalHardeningSeedCommit(creation.child.childRunId);
        const finalized=value.supervisor.finalizeOptionalHardeningStart(committed);
        expect(finalized).toMatchObject({status:"READY",run:{state:"PLAN_FROZEN"}});
        execution.enqueue(creation.child.childRunId);
        await expect(execution.runQueued(creation.child.childRunId)).rejects.toThrow("materialized seed diff mismatch");
        await execution.waitForIdle(creation.child.childRunId);
        expect({seam,mutations,providerLookups,providerCreates}).toEqual({seam,mutations:1,providerLookups:0,providerCreates:0});
        const db=new Database(value.dbPath,{readonly:true});
        const reservations=db.query(`SELECT status FROM hardening_child_model_reservations
          WHERE child_run_id=? AND role='BUILDER' ORDER BY created_at_ms,id`).all(creation.child.childRunId);
        const finalizations=db.query(`SELECT status,outcome FROM hardening_paid_call_finalizations
          WHERE child_run_id=? AND role='BUILDER' ORDER BY created_at_ms,id`).all(creation.child.childRunId);
        const active=db.query(`SELECT COUNT(*) AS count FROM hardening_child_model_reservations
          WHERE child_run_id=? AND status='RESERVED'`).get(creation.child.childRunId);
        db.close();
        expect({reservations,finalizations,active}).toEqual(seam==="BEFORE_RESERVATION"
          ?{reservations:[],finalizations:[],active:{count:0}}
          :{reservations:[{status:"VOID_UNSENT"}],finalizations:[{status:"APPLIED",outcome:"VOID_UNSENT"}],active:{count:0}});
      }finally{
        workerLeases?.close();
        value?.supervisor.close();
        if(value)rmSync(value.root,{recursive:true,force:true});
        rmSync(repositoryRoot,{recursive:true,force:true});
      }
    }
  },30_000);

  test("fails a marked hardening child closed when lineage/start authority is missing instead of ordinary fallback",async()=>{
    for(const missing of ["START_OPERATION","LINEAGE"] as const){
      const value=await hardeningConsentFixture(`run-hardening-marker-${missing.toLowerCase()}`),creation=
        await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
          {consentId:value.consent.consentId,consentHash:value.consent.consentHash}),startInput={
            expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,lineageHash:creation.lineage.lineageHash,
            idempotencyKey:`marker-${missing.toLowerCase()}-start`};
      const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,
        creation.child.childRunId,startInput),signedSeed=await signedHardeningSeedFixture(prepared,
          `marker-${missing.toLowerCase()}`);
      await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,startInput,prepared,signedSeed);
      expect(value.supervisor.isOptionalHardeningChild(creation.child.childRunId)).toBe(true);
      const db=new Database(value.dbPath);db.exec("PRAGMA foreign_keys=OFF");
      const table=missing==="START_OPERATION"?"hardening_start_operations":"engineer_run_lineage",triggers=
        db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as Array<{name:string}>;
      for(const trigger of triggers)db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"','""')}"`);
      db.query(`DELETE FROM "${table}" WHERE ${missing==="START_OPERATION"?"child_run_id":"child_run_id"}=?`).run(
        creation.child.childRunId);db.close();
      expect(()=>value.supervisor.isOptionalHardeningChild(creation.child.childRunId)).toThrow(
        HardeningAuthorityInvalidError);
      value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
    }
  },30_000);

  test("atomically persists normalized rows and classification and makes exact replay a no-op", () => {
    const value = setup();
    const ledger = new EngineerLedger(value.dbPath);
    expect(ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority)).toEqual(value.batch);
    const advanced = new Database(value.dbPath);
    advanced.query("UPDATE engineer_runs SET state = 'HUMAN_REVIEW_REQUIRED' WHERE id = ?").run(value.session.runId);
    advanced.close();
    expect(ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority)).toEqual(value.batch);
    expect(ledger.getReviewClassification(value.session.reviewerSessionId)).toEqual(value.batch);
    const records = ledger.exportRunRecords(value.session.runId);
    expect(records.reviewer_sessions).toHaveLength(1);
    expect(records.review_findings).toHaveLength(1);
    expect(records.review_classification_batches).toHaveLength(1);
    expect(records.review_finding_classifications).toHaveLength(1);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("keeps historical replay stable across future verification audits and rejects duplicate as-of authority", () => {
    const value = setup("run-verification-audit-asof", "INDEPENDENT_VALID");
    const ledger = new EngineerLedger(value.dbPath);
    expect(ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority)).toEqual(value.batch);
    const details = canonicalJson({
      verificationExecutionId: "verification-1", testId: "test-1", criterionIds: ["must-1"],
      commandExecutionId: "command-1", type: "UNIT", status: "PASSED",
    });
    const db = new Database(value.dbPath);
    db.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES (?, ?, 'VERIFICATION_EXECUTED', 'EXECUTOR', 'executor-1', ?, ?)`).run(
      "future-verification-audit", value.session.runId, details, offsetFuture,
    );
    db.query("UPDATE engineer_runs SET state = 'HUMAN_REVIEW_REQUIRED' WHERE id = ?").run(value.session.runId);
    db.close();
    expect(ledger.getReviewClassification(value.session.reviewerSessionId)).toEqual(value.batch);
    expect(ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority)).toEqual(value.batch);

    const duplicate = new Database(value.dbPath);
    duplicate.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES (?, ?, 'VERIFICATION_EXECUTED', 'EXECUTOR', 'executor-1', ?, ?)`).run(
      "duplicate-asof-verification-audit", value.session.runId, details, timestamp,
    );
    duplicate.close();
    expect(() => ledger.getReviewClassification(value.session.reviewerSessionId))
      .toThrow("reviewer-evidence-duplicate-audit");
    expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
      .toThrow("reviewer-evidence-duplicate-audit");
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("public Supervisor permits only exhaustive exact replay after the run advances", () => {
    const value = setup("run-supervisor-classified-replay", "INDEPENDENT_VALID");
    const supervisor = createEngineerSupervisor({
      dbPath: value.dbPath, idFactory: () => "supervisor-replay-id", now: () => new Date(timestamp),
    });
    expect(supervisor.recordClassifiedReviewerSession(
      value.session, [value.finding], value.batch, value.authority,
    )).toEqual(value.batch);
    const advanced = new Database(value.dbPath);
    advanced.query("UPDATE engineer_runs SET state = 'HUMAN_REVIEW_REQUIRED' WHERE id = ?").run(value.session.runId);
    advanced.close();
    expect(supervisor.recordClassifiedReviewerSession(
      value.session, [value.finding], value.batch, value.authority,
    )).toEqual(value.batch);
    const changed = classifyReviewerOutput({
      contract: value.contract, manifest: value.frozen, session: value.session, findings: [value.finding],
      trustedEvidence: value.reviewerInput.trustedEvidence,
      rawOutput: { ...value.rawOutput, artifactId: "changed-supervisor-replay", sha256: sha256("changed") },
    });
    expect(() => supervisor.recordClassifiedReviewerSession(
      value.session, [value.finding], changed, value.authority,
    )).toThrow(IdempotencyConflictError);
    supervisor.close();
    rmSync(value.root, { recursive: true, force: true });

    const fresh = setup("run-supervisor-non-reviewing-new", "INDEPENDENT_VALID");
    const freshDb = new Database(fresh.dbPath);
    freshDb.query("UPDATE engineer_runs SET state = 'HUMAN_REVIEW_REQUIRED' WHERE id = ?").run(fresh.session.runId);
    freshDb.close();
    const freshSupervisor = createEngineerSupervisor({
      dbPath: fresh.dbPath, idFactory: () => "fresh-supervisor-id", now: () => new Date(timestamp),
    });
    expect(() => freshSupervisor.recordClassifiedReviewerSession(
      fresh.session, [fresh.finding], fresh.batch, fresh.authority,
    )).toThrow(InvalidTransitionError);
    freshSupervisor.close();
    rmSync(fresh.root, { recursive: true, force: true });
  });

  test("rejects a validly hash-bound changed replay", () => {
    const value = setup();
    const ledger = new EngineerLedger(value.dbPath);
    ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority);
    const changed = classifyReviewerOutput({
      contract: value.contract, manifest: value.frozen, session: value.session, findings: [value.finding], trustedEvidence: [],
      rawOutput: { ...value.rawOutput, artifactId: "different-raw-output", sha256: sha256("different") },
    });
    expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], changed, value.authority))
      .toThrow(IdempotencyConflictError);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("hash-binds the caller provenance-conflict flag across initial write and replay", () => {
    const value = setup("run-provenance-flag");
    const conflictBatch = classifyReviewerOutput({
      contract: value.contract, manifest: value.frozen, session: value.session, findings: [value.finding],
      trustedEvidence: value.reviewerInput.trustedEvidence, rawOutput: value.rawOutput, provenanceConflict: true,
    });
    const ledger = new EngineerLedger(value.dbPath);
    expect(ledger.recordClassifiedReviewerSession(
      value.session, [value.finding], conflictBatch, { ...value.authority, provenanceConflict: true },
    )).toEqual(conflictBatch);
    expect(() => ledger.recordClassifiedReviewerSession(
      value.session, [value.finding], conflictBatch, { ...value.authority, provenanceConflict: false },
    )).toThrow("classified-reviewer-provenance");
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });

    const inverse = setup("run-provenance-flag-inverse");
    const inverseLedger = new EngineerLedger(inverse.dbPath);
    inverseLedger.recordClassifiedReviewerSession(inverse.session, [inverse.finding], inverse.batch, inverse.authority);
    expect(() => inverseLedger.recordClassifiedReviewerSession(
      inverse.session, [inverse.finding], inverse.batch, { ...inverse.authority, provenanceConflict: true },
    )).toThrow("classified-reviewer-provenance");
    inverseLedger.close();
    rmSync(inverse.root, { recursive: true, force: true });
  });

  test("uses the unique latest as-of domain artifact and ignores genuinely future duplicates", () => {
    const cases = [
      ["security", "VALID", undefined, "SECURITY_REPORT"],
      ["coverage", "NONE", "COVERAGE_VALID", "VERIFICATION_COVERAGE_MATRIX"],
      ["adversarial", "NONE", "ADVERSARIAL_VALID", "ADVERSARIAL_COVERAGE_REPORT"],
      ["scope", "NONE", "SCOPE_VALID", "FINAL_CHANGE_SCOPE_ATTESTATION"],
    ] as const;
    for (const [label, evidenceMode, domainMode, eventType] of cases) {
      const value = setup(`run-domain-latest-${label}`, evidenceMode, domainMode);
      const evidence = value.reviewerInput.trustedEvidence.find((item) => item.eventType === eventType)!;
      const ledger = new EngineerLedger(value.dbPath);
      expect(ledger.recordClassifiedReviewerSession(
        value.session, [value.finding], value.batch, value.authority,
      )).toEqual(value.batch);
      const futureStore = new LocalArtifactStore({
        root: join(value.root, `future-${label}`), now: () => new Date(offsetFuture), idFactory: () => `future-${label}`,
      });
      ledger.recordArtifact(futureStore.put({
        runId: value.session.runId, type: eventType, bytes: "future-corrupt-artifact",
        producerType: "SYSTEM", producerId: evidence.producerId, trusted: true,
      }));
      expect(ledger.getReviewClassification(value.session.reviewerSessionId)).toEqual(value.batch);
      expect(ledger.recordClassifiedReviewerSession(
        value.session, [value.finding], value.batch, value.authority,
      )).toEqual(value.batch);
      const tiedStore = new LocalArtifactStore({
        root: join(value.root, `tied-${label}`), now: () => new Date(timestamp), idFactory: () => `tied-${label}`,
      });
      ledger.recordArtifact(tiedStore.put({
        runId: value.session.runId, type: eventType, bytes: JSON.stringify(evidence.payload, null, 2),
        producerType: "SYSTEM", producerId: evidence.producerId, trusted: true,
      }));
      expect(() => ledger.getReviewClassification(value.session.reviewerSessionId))
        .toThrow("reviewer-evidence-domain-duplicate");
      expect(() => ledger.recordClassifiedReviewerSession(
        value.session, [value.finding], value.batch, value.authority,
      )).toThrow("reviewer-evidence-domain-duplicate");
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("rejects backdated canonical duplicate identity across every deterministic domain", () => {
    const cases = [
      ["security", "VALID", undefined, "SECURITY_REPORT"],
      ["coverage", "NONE", "COVERAGE_VALID", "VERIFICATION_COVERAGE_MATRIX"],
      ["adversarial", "NONE", "ADVERSARIAL_VALID", "ADVERSARIAL_COVERAGE_REPORT"],
      ["scope", "NONE", "SCOPE_VALID", "FINAL_CHANGE_SCOPE_ATTESTATION"],
    ] as const;
    for (const [label, evidenceMode, domainMode, eventType] of cases) {
      const value = setup(`run-domain-backdated-duplicate-${label}`, evidenceMode, domainMode);
      const evidence = value.reviewerInput.trustedEvidence.find((item) => item.eventType === eventType)!;
      const ledger = new EngineerLedger(value.dbPath);
      expect(ledger.recordClassifiedReviewerSession(
        value.session, [value.finding], value.batch, value.authority,
      )).toEqual(value.batch);
      const backdatedStore = new LocalArtifactStore({
        root: join(value.root, `backdated-${label}`), now: () => new Date(offsetEarlier),
        idFactory: () => `backdated-${label}`,
      });
      ledger.recordArtifact(backdatedStore.put({
        runId: value.session.runId, type: eventType, bytes: JSON.stringify(evidence.payload, null, 2),
        producerType: "SYSTEM", producerId: evidence.producerId, trusted: true,
      }));
      expect(() => ledger.getReviewClassification(value.session.reviewerSessionId))
        .toThrow("reviewer-evidence-domain-duplicate");
      expect(() => ledger.recordClassifiedReviewerSession(
        value.session, [value.finding], value.batch, value.authority,
      )).toThrow("reviewer-evidence-domain-duplicate");
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("refuses retroactive classification of a legacy raw Reviewer session", () => {
    const value = setup();
    const ledger = new EngineerLedger(value.dbPath);
    ledger.recordLegacyReviewerSessionForTest(value.session, [value.finding]);
    expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
      .toThrow("classified-reviewer-legacy");
    expect(ledger.getReviewClassification(value.session.reviewerSessionId)).toBeNull();
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("rolls back normalized rows if the immutable contract binding cannot be persisted", () => {
    const value = setup();
    const ledger = new EngineerLedger(value.dbPath);
    const { classificationHash: _classificationHash, ...content } = value.batch;
    const changedContent = { ...content, contractHash: sha256("missing-contract") };
    const invalidBinding = ReviewClassificationBatchSchema.parse({
      ...changedContent, classificationHash: sha256(changedContent),
    });
    expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], invalidBinding, value.authority)).toThrow();
    const records = ledger.exportRunRecords(value.session.runId);
    expect(records.reviewer_sessions).toHaveLength(0);
    expect(records.review_findings).toHaveLength(0);
    expect(records.review_classification_batches).toHaveLength(0);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("database sealing rejects classifications appended after the complete batch", () => {
    const value = setup();
    const ledger = new EngineerLedger(value.dbPath);
    ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority);
    ledger.close();
    const db = new Database(value.dbPath);
    expect(() => db.query(`INSERT INTO review_finding_classifications
      (classification_hash, batch_hash, reviewer_session_id, finding_id, finding_fingerprint,
       disposition, authority, reason_code, classification_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sha256("appended"), value.batch.classificationHash, value.session.reviewerSessionId,
        value.finding.findingId, value.finding.fingerprint, "ADVISORY", "NONE",
        "OUTSIDE_FROZEN_REQUIRED_SCOPE", "{}",
      )).toThrow("sealed review classification batches");
    expect(() => db.query("UPDATE reviewer_sessions SET decision = 'APPROVE' WHERE id = ?")
      .run(value.session.reviewerSessionId)).toThrow("reviewer_sessions are immutable");
    expect(() => db.query("DELETE FROM review_findings WHERE id = ?")
      .run(value.finding.findingId)).toThrow("review_findings are immutable");
    expect(() => db.query("UPDATE review_classification_batches SET policy_version = 'tampered' WHERE classification_hash = ?")
      .run(value.batch.classificationHash)).toThrow("review classifications are immutable");
    db.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("rejects fabricated classifications and missing classification mappings", () => {
    const value = setup();
    const ledger = new EngineerLedger(value.dbPath);
    for (const mutation of [
      { ...value.batch, result: "READY" as const },
      { ...value.batch, classifications: [] },
    ]) {
      const { classificationHash: _hash, ...content } = mutation;
      const rehashed = ReviewClassificationBatchSchema.parse({ ...content, classificationHash: sha256(content) });
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], rehashed, value.authority))
        .toThrow(IdempotencyConflictError);
    }
    expect(ledger.exportRunRecords(value.session.runId).reviewer_sessions).toHaveLength(0);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("rejects normalized finding omissions and extras instead of persisting a human gate", () => {
    const value = setup("run-normalized-mapping");
    const ledger = new EngineerLedger(value.dbPath);
    expect(() => ledger.recordClassifiedReviewerSession(value.session, [], value.batch, value.authority))
      .toThrow(IdempotencyConflictError);
    const extra = ReviewFindingRecordSchema.parse({
      ...value.finding, findingId: sha256("extra-finding-id"), fingerprint: sha256("extra-fingerprint"),
    });
    const extraBatch = classifyReviewerOutput({
      contract: value.contract, manifest: value.frozen, session: value.session,
      findings: [value.finding, extra], trustedEvidence: [], rawOutput: value.rawOutput,
    });
    expect(() => ledger.recordClassifiedReviewerSession(
      value.session, [value.finding, extra], extraBatch, value.authority,
    )).toThrow("classified-reviewer-raw-binding");
    expect(ledger.exportRunRecords(value.session.runId).reviewer_sessions).toHaveLength(0);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("rejects valid but unrelated provider argument bytes", () => {
    const value = setup("run-unrelated-raw");
    const ledger = new EngineerLedger(value.dbPath);
    const store = new LocalArtifactStore({
      root: join(value.root, "unrelated-artifacts"), now: () => new Date(timestamp), idFactory: () => "unrelated-raw",
    });
    const unrelatedBytes = JSON.stringify({
      ...value.session.output, residualRisks: ["This is a different provider response."],
    });
    const unrelatedArtifact = ledger.recordArtifact(store.put({
      runId: value.session.runId, type: "REVIEWER_RAW_OUTPUT", bytes: unrelatedBytes,
      producerType: "SYSTEM", producerId: value.session.reviewerSessionId, trusted: true,
    }));
    const unrelatedRaw = {
      artifactId: unrelatedArtifact.artifactId, sha256: unrelatedArtifact.sha256,
      byteLength: unrelatedArtifact.sizeBytes, mediaType: "application/json" as const,
    };
    const unrelatedBatch = classifyReviewerOutput({
      contract: value.contract, manifest: value.frozen, session: value.session,
      findings: [value.finding], trustedEvidence: [], rawOutput: unrelatedRaw,
    });
    expect(() => ledger.recordClassifiedReviewerSession(
      value.session, [value.finding], unrelatedBatch,
      { ...value.authority, rawOutputArtifact: unrelatedArtifact },
    )).toThrow("classified-reviewer-raw-binding");
    expect(ledger.exportRunRecords(value.session.runId).reviewer_sessions).toHaveLength(0);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("rejects nonexistent and byte-tampered raw provider artifacts", () => {
    const missing = setup("run-missing-artifact");
    const missingLedger = new EngineerLedger(missing.dbPath);
    expect(() => missingLedger.recordClassifiedReviewerSession(
      missing.session, [missing.finding], missing.batch,
      { ...missing.authority, rawOutputArtifact: { ...missing.rawArtifact, artifactId: "not-recorded" } },
    )).toThrow("classified-reviewer-artifact");
    missingLedger.close();
    rmSync(missing.root, { recursive: true, force: true });

    const tampered = setup("run-tampered-artifact");
    writeFileSync(tampered.rawArtifact.storageReference, "tampered-provider-arguments");
    const tamperedLedger = new EngineerLedger(tampered.dbPath);
    expect(() => tamperedLedger.recordClassifiedReviewerSession(
      tampered.session, [tampered.finding], tampered.batch, tampered.authority,
    )).toThrow("artifact-bytes");
    expect(tamperedLedger.exportRunRecords(tampered.session.runId).reviewer_sessions).toHaveLength(0);
    tamperedLedger.close();
    rmSync(tampered.root, { recursive: true, force: true });
  });

  test("rejects ReviewerInput and raw-artifact producer bindings from another review", () => {
    const value = setup("run-authority-binding");
    const ledger = new EngineerLedger(value.dbPath);
    const wrongInput = ReviewerInputSchema.parse({ ...value.reviewerInput, reviewAttempt: 2 });
    expect(() => ledger.recordClassifiedReviewerSession(
      value.session, [value.finding], value.batch, { ...value.authority, reviewerInput: wrongInput },
    )).toThrow("classified-reviewer-input");
    expect(() => ledger.recordClassifiedReviewerSession(
      value.session, [value.finding], value.batch,
      { ...value.authority, rawOutputArtifact: { ...value.rawArtifact, producerId: "different-review" } },
    )).toThrow("classified-reviewer-artifact");
    expect(ledger.exportRunRecords(value.session.runId).reviewer_sessions).toHaveLength(0);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("accepts durably attested security evidence and rejects forged or stale reports", () => {
    const valid = setup("run-valid-evidence", "VALID");
    const validLedger = new EngineerLedger(valid.dbPath);
    expect(validLedger.recordClassifiedReviewerSession(valid.session, [valid.finding], valid.batch, valid.authority))
      .toEqual(valid.batch);
    expect(validLedger.getReviewClassification(valid.session.reviewerSessionId)).toEqual(valid.batch);
    validLedger.close();
    rmSync(valid.root, { recursive: true, force: true });

    const validFinding = setup("run-valid-security-finding", "SECURITY_VALID_FINDING");
    const validFindingLedger = new EngineerLedger(validFinding.dbPath);
    expect(validFindingLedger.recordClassifiedReviewerSession(
      validFinding.session, [validFinding.finding], validFinding.batch, validFinding.authority,
    )).toEqual(validFinding.batch);
    expect(validFindingLedger.getReviewClassification(validFinding.session.reviewerSessionId)).toEqual(validFinding.batch);
    validFindingLedger.close();
    rmSync(validFinding.root, { recursive: true, force: true });

    for (const [runId, mode, expected] of [
      ["run-forged-evidence", "FORGED", "reviewer-evidence-artifact"],
      ["run-semantic-forged-evidence", "SEMANTIC_FORGED", "reviewer-evidence-security-semantics"],
      ["run-stale-evidence", "STALE", "reviewer-evidence-domain-latest"],
      ["run-unseen-evidence", "UNSEEN", "reviewer-evidence-missing"],
    ] as const) {
      const value = setup(runId, mode);
      const ledger = new EngineerLedger(value.dbPath);
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
        .toThrow(expected);
      expect(ledger.exportRunRecords(runId).reviewer_sessions).toHaveLength(0);
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("rechecks REVIEWING and current manifest authority under the write lock", () => {
    const value = setup("run-state-recheck");
    const db = new Database(value.dbPath);
    db.query("UPDATE engineer_runs SET state = 'PLAN_FROZEN' WHERE id = ?").run(value.session.runId);
    db.close();
    const ledger = new EngineerLedger(value.dbPath);
    expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
      .toThrow("classified-reviewer-current-run");
    expect(ledger.exportRunRecords(value.session.runId).reviewer_sessions).toHaveLength(0);
    ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("accepts the latest durable verification pass independently of Reviewer attempt and rejects a stale pass", () => {
    const valid = setup("run-independent-valid", "INDEPENDENT_VALID");
    expect(valid.reviewerInput.reviewAttempt).toBe(2);
    const validLedger = new EngineerLedger(valid.dbPath);
    expect(validLedger.recordClassifiedReviewerSession(valid.session, [valid.finding], valid.batch, valid.authority))
      .toEqual(valid.batch);
    validLedger.close();
    rmSync(valid.root, { recursive: true, force: true });

    const future = setup("run-independent-future-pass", "INDEPENDENT_FUTURE_PASS");
    const futureLedger = new EngineerLedger(future.dbPath);
    expect(futureLedger.recordClassifiedReviewerSession(future.session, [future.finding], future.batch, future.authority))
      .toEqual(future.batch);
    expect(futureLedger.getReviewClassification(future.session.reviewerSessionId)).toEqual(future.batch);
    futureLedger.close();
    rmSync(future.root, { recursive: true, force: true });

    const futureDuplicateAudit = setup(
      "run-integrity-future-duplicate-audit", "NONE", "INTEGRITY_FUTURE_DUPLICATE_AUDIT",
    );
    const futureDuplicateAuditLedger = new EngineerLedger(futureDuplicateAudit.dbPath);
    expect(futureDuplicateAuditLedger.recordClassifiedReviewerSession(
      futureDuplicateAudit.session, [futureDuplicateAudit.finding],
      futureDuplicateAudit.batch, futureDuplicateAudit.authority,
    )).toEqual(futureDuplicateAudit.batch);
    expect(futureDuplicateAuditLedger.getReviewClassification(futureDuplicateAudit.session.reviewerSessionId))
      .toEqual(futureDuplicateAudit.batch);
    futureDuplicateAuditLedger.close();
    rmSync(futureDuplicateAudit.root, { recursive: true, force: true });

    const stale = setup("run-independent-stale", "INDEPENDENT_STALE");
    const staleLedger = new EngineerLedger(stale.dbPath);
    expect(() => staleLedger.recordClassifiedReviewerSession(stale.session, [stale.finding], stale.batch, stale.authority))
      .toThrow("reviewer-evidence-stale");
    expect(staleLedger.exportRunRecords(stale.session.runId).reviewer_sessions).toHaveLength(0);
    staleLedger.close();
    rmSync(stale.root, { recursive: true, force: true });

    for (const [runId, mode, expected] of [
      ["run-independent-forged", "INDEPENDENT_FORGED", "reviewer-evidence-stale"],
      ["run-independent-unseen", "INDEPENDENT_UNSEEN", "reviewer-evidence-missing"],
      ["run-independent-tampered", "INDEPENDENT_TAMPERED", "reviewer-evidence-stale"],
    ] as const) {
      const value = setup(runId, mode);
      const ledger = new EngineerLedger(value.dbPath);
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
        .toThrow(expected);
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("accepts only the exact current-manifest verification coverage matrix", () => {
    const valid = setup("run-coverage-valid", "NONE", "COVERAGE_VALID");
    const validLedger = new EngineerLedger(valid.dbPath);
    expect(validLedger.recordClassifiedReviewerSession(valid.session, [valid.finding], valid.batch, valid.authority))
      .toEqual(valid.batch);
    validLedger.close();
    rmSync(valid.root, { recursive: true, force: true });

    const earlierOffset = setup("run-coverage-earlier-offset", "NONE", "COVERAGE_EARLIER_OFFSET");
    const earlierOffsetLedger = new EngineerLedger(earlierOffset.dbPath);
    expect(earlierOffsetLedger.recordClassifiedReviewerSession(
      earlierOffset.session, [earlierOffset.finding], earlierOffset.batch, earlierOffset.authority,
    )).toEqual(earlierOffset.batch);
    earlierOffsetLedger.close();
    rmSync(earlierOffset.root, { recursive: true, force: true });

    for (const [runId, mode, expected] of [
      ["run-coverage-forged-current", "COVERAGE_FORGED_CURRENT", "reviewer-evidence-coverage-binding"],
      ["run-coverage-stale", "COVERAGE_STALE", "reviewer-evidence-domain-latest"],
      ["run-coverage-unseen", "COVERAGE_UNSEEN", "reviewer-evidence-missing"],
      ["run-coverage-future-offset", "COVERAGE_FUTURE_OFFSET", "reviewer-evidence-digest"],
    ] as const) {
      const value = setup(runId, "NONE", mode);
      const ledger = new EngineerLedger(value.dbPath);
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
        .toThrow(expected);
      expect(ledger.exportRunRecords(runId).reviewer_sessions).toHaveLength(0);
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("accepts only the advisory-derived current-manifest adversarial report", () => {
    const valid = setup("run-adversarial-valid", "NONE", "ADVERSARIAL_VALID");
    const validLedger = new EngineerLedger(valid.dbPath);
    expect(validLedger.recordClassifiedReviewerSession(valid.session, [valid.finding], valid.batch, valid.authority))
      .toEqual(valid.batch);
    validLedger.close();
    rmSync(valid.root, { recursive: true, force: true });

    const future = setup("run-adversarial-future-advisory", "NONE", "ADVERSARIAL_FUTURE_ADVISORY");
    const futureLedger = new EngineerLedger(future.dbPath);
    expect(futureLedger.recordClassifiedReviewerSession(future.session, [future.finding], future.batch, future.authority))
      .toEqual(future.batch);
    expect(futureLedger.getReviewClassification(future.session.reviewerSessionId)).toEqual(future.batch);
    futureLedger.close();
    rmSync(future.root, { recursive: true, force: true });

    for (const [runId, mode, expected] of [
      ["run-adversarial-forged-current", "ADVERSARIAL_FORGED_CURRENT", "reviewer-evidence-adversarial-binding"],
      ["run-adversarial-stale", "ADVERSARIAL_STALE", "reviewer-evidence-domain-latest"],
      ["run-adversarial-duplicate-advisory", "ADVERSARIAL_DUPLICATE_ADVISORY", "reviewer-evidence-adversarial-binding"],
      ["run-adversarial-trusted-advisory", "ADVERSARIAL_TRUSTED_ADVISORY", "reviewer-evidence-adversarial-binding"],
      ["run-adversarial-unseen", "ADVERSARIAL_UNSEEN", "reviewer-evidence-missing"],
    ] as const) {
      const value = setup(runId, "NONE", mode);
      const ledger = new EngineerLedger(value.dbPath);
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
        .toThrow(expected);
      expect(ledger.exportRunRecords(runId).reviewer_sessions).toHaveLength(0);
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("requires one durable current PRE_REVIEW integrity comparison", () => {
    const valid = setup("run-integrity-valid", "NONE", "INTEGRITY_VALID");
    const validLedger = new EngineerLedger(valid.dbPath);
    expect(validLedger.recordClassifiedReviewerSession(valid.session, [valid.finding], valid.batch, valid.authority))
      .toEqual(valid.batch);
    validLedger.close();
    rmSync(valid.root, { recursive: true, force: true });

    const recreated = setup("run-integrity-recreated-baseline", "NONE", "INTEGRITY_RECREATED_BASELINE");
    const recreatedLedger = new EngineerLedger(recreated.dbPath);
    expect(recreatedLedger.recordClassifiedReviewerSession(
      recreated.session, [recreated.finding], recreated.batch, recreated.authority,
    )).toEqual(recreated.batch);
    recreatedLedger.close();
    rmSync(recreated.root, { recursive: true, force: true });

    const future = setup("run-integrity-future-activity", "NONE", "INTEGRITY_FUTURE_ACTIVITY");
    const futureLedger = new EngineerLedger(future.dbPath);
    expect(futureLedger.recordClassifiedReviewerSession(
      future.session, [future.finding], future.batch, future.authority,
    )).toEqual(future.batch);
    expect(futureLedger.getReviewClassification(future.session.reviewerSessionId)).toEqual(future.batch);
    futureLedger.close();
    rmSync(future.root, { recursive: true, force: true });

    for (const [runId, mode, expected] of [
      ["run-integrity-forged", "INTEGRITY_FORGED", "reviewer-evidence-artifact"],
      ["run-integrity-forged-current", "INTEGRITY_FORGED_CURRENT", "integrity-generation"],
      ["run-integrity-stale", "INTEGRITY_STALE", "reviewer-evidence-baseline-binding"],
      ["run-integrity-old-stage", "INTEGRITY_OLD_STAGE", "missing-pre-review"],
      ["run-integrity-stale-baseline-reference", "INTEGRITY_DUPLICATE_BASELINE", "baseline-binding"],
      ["run-integrity-duplicate-stage", "INTEGRITY_DUPLICATE_STAGE", "integrity-binding"],
      ["run-integrity-later-failed", "INTEGRITY_LATER_FAILED", "integrity-generation"],
      ["run-integrity-duplicate-audit-asof", "INTEGRITY_DUPLICATE_AUDIT_ASOF", "integrity-generation"],
      ["run-integrity-unseen", "INTEGRITY_UNSEEN", "reviewer-evidence-missing"],
    ] as const) {
      const value = setup(runId, "NONE", mode);
      const ledger = new EngineerLedger(value.dbPath);
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
        .toThrow(expected);
      expect(ledger.exportRunRecords(runId).reviewer_sessions).toHaveLength(0);
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("accepts only durable current scope attestations", () => {
    const valid = setup("run-scope-valid", "NONE", "SCOPE_VALID");
    const validLedger = new EngineerLedger(valid.dbPath);
    expect(validLedger.recordClassifiedReviewerSession(valid.session, [valid.finding], valid.batch, valid.authority))
      .toEqual(valid.batch);
    validLedger.close();
    rmSync(valid.root, { recursive: true, force: true });

    const future = setup("run-scope-future-git", "NONE", "SCOPE_FUTURE_GIT");
    const futureLedger = new EngineerLedger(future.dbPath);
    expect(futureLedger.recordClassifiedReviewerSession(future.session, [future.finding], future.batch, future.authority))
      .toEqual(future.batch);
    expect(futureLedger.getReviewClassification(future.session.reviewerSessionId)).toEqual(future.batch);
    futureLedger.close();
    rmSync(future.root, { recursive: true, force: true });

    const offsetEarlierValue = setup("run-scope-offset-earlier-git", "NONE", "SCOPE_OFFSET_EARLIER_GIT");
    const offsetEarlierLedger = new EngineerLedger(offsetEarlierValue.dbPath);
    expect(offsetEarlierLedger.recordClassifiedReviewerSession(
      offsetEarlierValue.session, [offsetEarlierValue.finding], offsetEarlierValue.batch, offsetEarlierValue.authority,
    )).toEqual(offsetEarlierValue.batch);
    offsetEarlierLedger.close();
    rmSync(offsetEarlierValue.root, { recursive: true, force: true });

    for (const [runId, mode, expected] of [
      ["run-scope-forged", "SCOPE_FORGED", "reviewer-evidence-artifact"],
      ["run-scope-forged-current", "SCOPE_FORGED_CURRENT", "reviewer-evidence-scope-binding"],
      ["run-scope-stale", "SCOPE_STALE", "reviewer-evidence-domain-latest"],
      ["run-scope-invalid-git-time", "SCOPE_INVALID_GIT", "reviewer-evidence-time:git-operation"],
      ["run-scope-unseen", "SCOPE_UNSEEN", "reviewer-evidence-missing"],
    ] as const) {
      const value = setup(runId, "NONE", mode);
      const ledger = new EngineerLedger(value.dbPath);
      expect(() => ledger.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority))
        .toThrow(expected);
      expect(ledger.exportRunRecords(runId).reviewer_sessions).toHaveLength(0);
      ledger.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("two independent ledger connections converge on one exact replay", () => {
    const value = setup("run-two-ledgers");
    const first = new EngineerLedger(value.dbPath);
    const second = new EngineerLedger(value.dbPath);
    expect(first.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority)).toEqual(value.batch);
    expect(second.recordClassifiedReviewerSession(value.session, [value.finding], value.batch, value.authority)).toEqual(value.batch);
    expect(first.exportRunRecords(value.session.runId).reviewer_sessions).toHaveLength(1);
    first.close();
    second.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("rehydration rejects post-write raw-byte and normalized-output tampering", () => {
    const raw = setup("run-read-raw-tamper");
    const rawLedger = new EngineerLedger(raw.dbPath);
    rawLedger.recordClassifiedReviewerSession(raw.session, [raw.finding], raw.batch, raw.authority);
    writeFileSync(raw.rawArtifact.storageReference, "tampered after persistence");
    expect(() => rawLedger.getReviewClassification(raw.session.reviewerSessionId)).toThrow("artifact bytes");
    rawLedger.close();
    rmSync(raw.root, { recursive: true, force: true });

    const normalized = setup("run-read-normalized-tamper");
    const normalizedLedger = new EngineerLedger(normalized.dbPath);
    normalizedLedger.recordClassifiedReviewerSession(normalized.session, [normalized.finding], normalized.batch, normalized.authority);
    const db = new Database(normalized.dbPath);
    db.exec("DROP TRIGGER prevent_review_classification_batches_update_v18");
    db.query("UPDATE review_classification_batches SET normalized_output_json = ? WHERE reviewer_session_id = ?")
      .run(canonicalJson({ ...normalized.session.output, residualRisks: ["tampered"] }), normalized.session.reviewerSessionId);
    db.close();
    expect(() => normalizedLedger.getReviewClassification(normalized.session.reviewerSessionId)).toThrow("do not re-bind");
    normalizedLedger.close();
    rmSync(normalized.root, { recursive: true, force: true });
  });

  test("atomically promotes one fully durable candidate and strictly rehydrates it by event or ID", async () => {
    const value = promotionFixture("run-checkpoint-promote");
    const callerTimestampSubstitution = { ...value.promotion, createdAt: offsetFuture } as PromoteVerifiedCandidateInput;
    const promoted = await value.supervisor.promoteVerifiedCandidate(callerTimestampSubstitution, value.run.stateVersion);
    expect(promoted.applied).toBe(true);
    expect(promoted.checkpoint.createdAt).toBe(value.batch.createdAt);
    expect(value.supervisor.getRun(value.promotion.runId)).toMatchObject({
      state: "REVIEW_APPROVED", stateVersion: value.run.stateVersion + 1,
    });
    expect(await value.supervisor.getVerifiedCandidateCheckpoint({ runId: value.promotion.runId }, checkpointAttestor))
      .toEqual({ checkpoint: promoted.checkpoint, attestation: promoted.attestation });
    expect(await value.supervisor.getVerifiedCandidateCheckpoint({ checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor))
      .toEqual({ checkpoint: promoted.checkpoint, attestation: promoted.attestation });
    const replay = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    expect(replay).toEqual({ ...promoted, applied: false });
    expect(value.supervisor.exportRunRecords(value.promotion.runId).verified_candidate_checkpoints).toHaveLength(1);
    const events = value.supervisor.listEvents(value.promotion.runId)
      .filter((event) => event.reasonCode === "VERIFIED_CANDIDATE_PROMOTED");
    expect(events).toHaveLength(1);
    expect(events[0]!.evidenceIds).toEqual([promoted.checkpoint.checkpointId]);
    await expect(value.supervisor.promoteVerifiedCandidate({
      ...value.promotion, evidenceBundleId: "changed-bundle",
    }, value.run.stateVersion)).rejects.toThrow(IdempotencyConflictError);
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("promotes READY_WITH_ADVISORIES without granting the advisory blocking authority", async () => {
    const value = promotionFixture("run-checkpoint-advisory", true);
    expect(value.batch.result).toBe("READY_WITH_ADVISORIES");
    const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    expect(promoted.checkpoint.classificationResult).toBe("READY_WITH_ADVISORIES");
    expect(promoted.applied).toBe(true);
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("atomically materializes the exact advisory marker and supports owner CAS lifecycle", async () => {
    const value = promotionFixture("run-checkpoint-advisory-owner", true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const initial = await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId, value.run.runId);
    expect(initial).toMatchObject({ schemaVersion: 1, materializationStatus: "COMPLETE", nextCursor: null });
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({ status: "OPEN", revision: 0 });
    expect(Object.keys(initial.items[0]!).sort()).toEqual(["actionability","advisoryId","category","createdAt","description","file","lineEnd","lineStart","recommendedChange","revision","severity","status","updatedAt"].sort());
    const id = initial.items[0]!.advisoryId;
    const command = { expectedRevision: 0, idempotencyKey: "owner-defer", rationale: "later" };
    const deferred = await value.supervisor.deferAdvisoryForOwner(value.run.userId, value.run.runId, id, command);
    expect(deferred).toMatchObject({ status: "DEFERRED", revision: 1 });
    expect(await value.supervisor.deferAdvisoryForOwner(value.run.userId, value.run.runId, id, command)).toEqual(deferred);
    await expect(value.supervisor.deferAdvisoryForOwner(value.run.userId, value.run.runId, id, { ...command, rationale: "changed" })).rejects.toThrow(IdempotencyConflictError);
    await expect(value.supervisor.dismissAdvisoryForOwner(value.run.userId, value.run.runId, id, { ...command, idempotencyKey: "stale" })).rejects.toThrow(AdvisoryChangedError);
    await expect(value.supervisor.deferAdvisoryForOwner(value.run.userId, value.run.runId, id, { expectedRevision: 1, idempotencyKey: "illegal", rationale: null })).rejects.toThrow(AdvisoryTransitionInvalidError);
    const dismissed = await value.supervisor.dismissAdvisoryForOwner(value.run.userId, value.run.runId, id, { expectedRevision: 1, idempotencyKey: "dismiss", rationale: null });
    expect(dismissed).toMatchObject({ status: "DISMISSED", revision: 2 });
    const reopened = await value.supervisor.reopenAdvisoryForOwner(value.run.userId, value.run.runId, id, { expectedRevision: 2, idempotencyKey: "reopen", rationale: null });
    expect(reopened).toMatchObject({ status: "OPEN", revision: 3 });
    expect(await value.supervisor.deferAdvisoryForOwner(value.run.userId, value.run.runId, id, command)).toMatchObject({ status: "DEFERRED", revision: 1 });
    await expect(value.supervisor.deferAdvisoryForOwner("other-owner", value.run.runId, id, { expectedRevision: 3, idempotencyKey: "foreign", rationale: null })).rejects.toThrow("not found");
    value.supervisor.close(); rmSync(value.root,{recursive:true,force:true});
  });

  test("fails closed when the advisory materialization marker is changed after promotion", async () => {
    const value = promotionFixture("run-checkpoint-advisory-marker-tamper", true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const advisoryId = (await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId, value.run.runId)).items[0]!.advisoryId;
    const db = new Database(value.dbPath);
    db.query("UPDATE audit_events SET details_json=? WHERE run_id=? AND action='ADVISORY_BACKLOG_MATERIALIZED'")
      .run(canonicalJson({ advisoryCount: 0 }), value.run.runId);
    db.close();
    await expect(value.supervisor.listAdvisoryBacklogForOwner(value.run.userId, value.run.runId)).rejects.toThrow(AdvisoryIntegrityError);
    await expect(value.supervisor.deferAdvisoryForOwner(value.run.userId, value.run.runId, advisoryId,
      { expectedRevision: 0, idempotencyKey: "tampered-marker", rationale: null })).rejects.toThrow(AdvisoryIntegrityError);
    await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion)).rejects.toThrow(AdvisoryIntegrityError);
    value.supervisor.close(); rmSync(value.root,{recursive:true,force:true});
  });

  test("rejects future advisory event types inside the owner-action transaction", async () => {
    const value=promotionFixture("run-advisory-future-event",true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const advisory=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    await value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,advisory.advisoryId,{expectedRevision:0,idempotencyKey:"future-seed",rationale:null});
    const db=new Database(value.dbPath);db.exec("DROP TRIGGER prevent_advisory_backlog_events_update_v23");
    const row=db.query("SELECT event_json FROM advisory_backlog_events WHERE advisory_id=?").get(advisory.advisoryId) as {event_json:string};
    db.query("UPDATE advisory_backlog_events SET event_json=? WHERE advisory_id=?")
      .run(canonicalJson({...JSON.parse(row.event_json),eventType:"SELECTED"}),advisory.advisoryId);db.close();
    await expect(value.supervisor.dismissAdvisoryForOwner(value.run.userId,value.run.runId,advisory.advisoryId,
      {expectedRevision:1,idempotencyKey:"future-reject",rationale:null})).rejects.toThrow(AdvisoryIntegrityError);
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("fails list, action, and idempotent replay on supported-shape lifecycle corruption", async () => {
    for(const mode of ["JSON_ONLY","CONSISTENT_ACTOR","CONSISTENT_REVISION"] as const){
      const value=promotionFixture(`run-advisory-event-${mode.toLowerCase()}`,true);
      await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
      const item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
      const command={expectedRevision:0,idempotencyKey:`event-${mode.toLowerCase()}`,rationale:"original"};
      await value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,command);
      const db=new Database(value.dbPath);db.exec("DROP TRIGGER prevent_advisory_backlog_events_update_v23");
      const row=db.query("SELECT event_json FROM advisory_backlog_events WHERE advisory_id=?").get(item.advisoryId) as {event_json:string};
      const original=JSON.parse(row.event_json) as Record<string,unknown>;const {eventId:_eventId,eventHash:_eventHash,...content}=original;
      const changes=mode==="JSON_ONLY"?{eventType:"DISMISSED"}
        :mode==="CONSISTENT_ACTOR"?{actorId:"forged-owner",rationale:"forged"}:{revision:2,expectedRevision:1};
      const forged=createAdvisoryBacklogEvent({...content,...changes} as never);
      if(mode==="JSON_ONLY")db.query("UPDATE advisory_backlog_events SET event_json=? WHERE advisory_id=?").run(canonicalJson(forged),item.advisoryId);
      else if(mode==="CONSISTENT_ACTOR")db.query(`UPDATE advisory_backlog_events SET id=?,event_hash=?,actor_id=?,rationale=?,event_json=? WHERE advisory_id=?`)
        .run(forged.eventId,forged.eventHash,forged.actorId,forged.rationale,canonicalJson(forged),item.advisoryId);
      else db.query(`UPDATE advisory_backlog_events SET id=?,event_hash=?,revision=?,expected_revision=?,event_json=? WHERE advisory_id=?`)
        .run(forged.eventId,forged.eventHash,forged.revision,forged.expectedRevision,canonicalJson(forged),item.advisoryId);
      db.close();
      const attempt=mode==="JSON_ONLY"?value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)
        :mode==="CONSISTENT_ACTOR"?value.supervisor.dismissAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,{expectedRevision:1,idempotencyKey:"after-forge",rationale:null})
          :value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,command);
      await expect(attempt).rejects.toThrow(AdvisoryIntegrityError);
      value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
    }
  });

  test("requires the configured signed checkpoint attestor before advisory authority is consumed", async () => {
    const value=promotionFixture("run-advisory-signed-authority",true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const untrusted=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(timestamp),checkpointAttestor:{...checkpointAttestor,keyId:"wrong-key"}});
    await expect(untrusted.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).rejects.toThrow(AdvisoryIntegrityError);
    await expect(untrusted.deferAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,
      {expectedRevision:0,idempotencyKey:"wrong-attestor",rationale:null})).rejects.toThrow(AdvisoryIntegrityError);
    untrusted.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("rechecks every signed-attestation byte inside the owner-action transaction", async () => {
    const value=promotionFixture("run-advisory-attestation-toctou",true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    let mutated=false;
    value.supervisor.configureCheckpointAttestor({...checkpointAttestor,verify:(payload,signature)=>{
      if(!mutated){mutated=true;const db=new Database(value.dbPath);db.exec("DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21");
        db.query("UPDATE verified_candidate_checkpoints SET signature=? WHERE run_id=?").run("tampered-after-verification",value.run.runId);db.close();}
      return checkpointAttestor.verify(payload,signature);
    }});
    await expect(value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,
      {expectedRevision:0,idempotencyKey:"attestation-toctou",rationale:null})).rejects.toThrow(AdvisoryIntegrityError);
    const db=new Database(value.dbPath);expect(Number((db.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE parent_run_id=?").get(value.run.runId) as {count:number}).count)).toBe(0);db.close();
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("binds advisory cursors to canonical time, item hash, run owner scope, and filters", async () => {
    const value=promotionFixture("run-advisory-cursor",true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const filterHash=sha256({status:"OPEN",actionability:null});
    const cursor=(createdAt:string,advisoryId:string,runId=value.run.runId)=>Buffer.from(canonicalJson({v:1,runId,
      ownerScopeHash:sha256({ownerId:value.run.userId,runId}),filterHash,createdAt,advisoryId})).toString("base64url");
    expect((await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"OPEN",cursor:cursor(item.createdAt,item.advisoryId)})).items).toHaveLength(0);
    await expect(value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"DEFERRED",cursor:cursor(item.createdAt,item.advisoryId)})).rejects.toThrow(AdvisoryCursorInvalidError);
    await expect(value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"OPEN",cursor:cursor("0",item.advisoryId)})).rejects.toThrow(AdvisoryCursorInvalidError);
    await expect(value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"OPEN",cursor:cursor(item.createdAt,"not-a-hash")})).rejects.toThrow(AdvisoryCursorInvalidError);
    await expect(value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"OPEN",cursor:cursor(item.createdAt,item.advisoryId,"substituted-run")})).rejects.toThrow(AdvisoryCursorInvalidError);
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("pages a multi-item advisory set without gaps and applies lifecycle and actionability filters", async () => {
    const value=promotionFixture("run-advisory-pages",true,"src/index.ts",["src/second.ts","src/third.ts"]);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const first=await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{limit:2,actionability:"ACTIONABLE"});
    expect(first.items).toHaveLength(2);expect(first.nextCursor).not.toBeNull();
    const second=await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{limit:2,actionability:"ACTIONABLE",cursor:first.nextCursor!});
    expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
    const ids=[...first.items,...second.items].map((item)=>item.advisoryId);
    expect(new Set(ids).size).toBe(3);expect(ids).toEqual([...ids].sort((left,right)=>left<right?1:left>right?-1:0));
    await value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,ids[0]!,{expectedRevision:0,idempotencyKey:"page-defer",rationale:null});
    expect((await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"DEFERRED"})).items).toHaveLength(1);
    expect((await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId,{status:"OPEN"})).items).toHaveLength(2);
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("allows exactly one owner action at the same advisory revision and preserves checkpoint bytes", async () => {
    const value=promotionFixture("run-advisory-owner-race",true);
    const promoted=await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const second=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(timestamp),checkpointAttestor});
    second.configureArtifactReadAuthority(value.artifactStore);
    const item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const outcomes=await Promise.all([Promise.resolve().then(async()=>{try{return {ok:true,value:await value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,{expectedRevision:0,idempotencyKey:"race-defer",rationale:null})};}catch(error){return {ok:false,error};}}),
      Promise.resolve().then(async()=>{try{return {ok:true,value:await second.dismissAdvisoryForOwner(value.run.userId,value.run.runId,item.advisoryId,{expectedRevision:0,idempotencyKey:"race-dismiss",rationale:null})};}catch(error){return {ok:false,error};}})]);
    expect(outcomes.filter((result)=>result.ok)).toHaveLength(1);
    expect(outcomes.filter((result)=>!result.ok)[0]!.error).toBeInstanceOf(AdvisoryChangedError);
    const db=new Database(value.dbPath);const row=db.query("SELECT checkpoint_json FROM verified_candidate_checkpoints WHERE id=?").get(promoted.checkpoint.checkpointId) as {checkpoint_json:string};db.close();
    expect(row.checkpoint_json).toBe(canonicalJson(promoted.checkpoint));
    second.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("redacts audit-only advisory locations and rejects row or checkpoint byte tampering", async () => {
    const auditOnly=promotionFixture("run-advisory-audit-only",true,"src/.git/config");
    await auditOnly.supervisor.promoteVerifiedCandidate(auditOnly.promotion,auditOnly.run.stateVersion);
    expect((await auditOnly.supervisor.listAdvisoryBacklogForOwner(auditOnly.run.userId,auditOnly.run.runId)).items[0])
      .toMatchObject({actionability:"AUDIT_ONLY",file:null,lineStart:null,lineEnd:null});
    auditOnly.supervisor.close();rmSync(auditOnly.root,{recursive:true,force:true});

    for(const mode of ["ROW","JSON","CHECKPOINT"] as const){const value=promotionFixture(`run-advisory-tamper-${mode.toLowerCase()}`,true);
      const promoted=await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);const db=new Database(value.dbPath);
      if(mode==="CHECKPOINT"){db.exec("DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21");const row=db.query("SELECT checkpoint_json FROM verified_candidate_checkpoints WHERE id=?").get(promoted.checkpoint.checkpointId) as {checkpoint_json:string};db.query("UPDATE verified_candidate_checkpoints SET checkpoint_json=? WHERE id=?").run(` ${row.checkpoint_json}`,promoted.checkpoint.checkpointId);}
      else{db.exec("DROP TRIGGER prevent_advisory_backlog_items_update_v23");if(mode==="ROW")db.query("UPDATE advisory_backlog_items SET category='tampered' WHERE parent_run_id=?").run(value.run.runId);else db.query("UPDATE advisory_backlog_items SET item_json='{}' WHERE parent_run_id=?").run(value.run.runId);}db.close();
      await expect(value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).rejects.toThrow(AdvisoryIntegrityError);
      value.supervisor.close();rmSync(value.root,{recursive:true,force:true});}
  });

  test("records READY zero marker and exposes legacy candidates read-only without backfill", async () => {
    const ready = promotionFixture("run-checkpoint-ready-marker");
    const promoted = await ready.supervisor.promoteVerifiedCandidate(ready.promotion, ready.run.stateVersion);
    expect(await ready.supervisor.listAdvisoryBacklogForOwner(ready.run.userId, ready.run.runId)).toEqual({schemaVersion:1,materializationStatus:"COMPLETE",items:[],nextCursor:null});
    const db=new Database(ready.dbPath);db.query("DELETE FROM audit_events WHERE run_id=? AND action='ADVISORY_BACKLOG_MATERIALIZED'").run(ready.run.runId);db.close();
    expect(await ready.supervisor.listAdvisoryBacklogForOwner(ready.run.userId,ready.run.runId)).toEqual({schemaVersion:1,materializationStatus:"LEGACY_UNAVAILABLE",items:[],nextCursor:null});
    const legacyDb=new Database(ready.dbPath);
    // Construct the exact immutable event key written by pre-P2 code. Production
    // databases retain the update trigger; only this isolated legacy fixture drops it.
    legacyDb.exec("DROP TRIGGER prevent_run_state_events_update_v21");
    legacyDb.query("UPDATE run_state_events SET idempotency_key=? WHERE run_id=? AND event_id=?")
      .run(`verified-candidate:${promoted.checkpoint.checkpointId}`,ready.run.runId,promoted.checkpoint.checkpointId);
    legacyDb.close();
    expect(await ready.supervisor.listAdvisoryBacklogForOwner(ready.run.userId,ready.run.runId)).toEqual({schemaVersion:1,materializationStatus:"LEGACY_UNAVAILABLE",items:[],nextCursor:null});
    await expect(ready.supervisor.deferAdvisoryForOwner(ready.run.userId,ready.run.runId,"missing",{expectedRevision:0,idempotencyKey:"legacy",rationale:null})).rejects.toThrow(AdvisoryMaterializationRequiredError);
    expect(ready.supervisor.exportRunRecords(ready.run.runId).advisory_backlog_items).toHaveLength(0);
    ready.supervisor.close();rmSync(ready.root,{recursive:true,force:true});
  });

  test("fails supported advisory and hardening admission closed without exact artifact authority but preserves legacy read-only fallback", async () => {
    const value=promotionFixture("run-hardening-admission-artifact-authority",true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const isolated=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(timestamp),checkpointAttestor});
    const advisory=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    await expect(isolated.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).rejects.toThrow(AdvisoryIntegrityError);
    const parent=isolated.getRun(value.run.runId);
    const request={runId:value.run.runId,advisoryIds:[advisory.advisoryId],expectedParentStateVersion:parent.stateVersion,
      idempotencyKey:"strict-admission-authority"};
    await expect(isolated.createHardeningQuoteForOwner(value.run.userId,request)).rejects.toThrow("authority");
    expect(isolated.exportRunRecords(value.run.runId).hardening_quotes).toHaveLength(0);
    expect(isolated.exportRunRecords(value.run.runId).hardening_quote_requests).toHaveLength(0);
    isolated.configureArtifactReadAuthority(value.artifactStore);
    expect(await isolated.createHardeningQuoteForOwner(value.run.userId,request)).toMatchObject({
      parentRunId:value.run.runId,advisoryIds:[advisory.advisoryId],status:"ACTIVE",
    });
    isolated.close();
    const db=new Database(value.dbPath);db.query("DELETE FROM audit_events WHERE run_id=? AND action='ADVISORY_BACKLOG_MATERIALIZED'")
      .run(value.run.runId);db.close();
    const legacy=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(timestamp),checkpointAttestor});
    expect(await legacy.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).toEqual({
      schemaVersion:1,materializationStatus:"LEGACY_UNAVAILABLE",items:[],nextCursor:null,
    });
    legacy.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("creates, replays, reads, and consents to one deterministic hardening quote without selecting or starting work", async () => {
    const value=promotionFixture("run-hardening-quote-happy",true);
    await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId);
    const advisory=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const request={runId:value.run.runId,advisoryIds:[advisory.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-happy"};
    const quote=await value.supervisor.createHardeningQuoteForOwner(value.run.userId,request);
    expect(quote).toMatchObject({schemaVersion:2,policyVersion:"engineer-hardening-estimate-v2",status:"ACTIVE",
      parentRunId:value.run.runId,parentStateVersion:parent.stateVersion,advisoryIds:[advisory.advisoryId],
      estimate:{maxCostMicrousd:746_875,maxTokens:73_000,maxTimeSeconds:480,maxPlannerCalls:0,maxBuilderCalls:1,maxReviewerCalls:1,automaticRepairCalls:0,
        inputCaps:{builderInputTokens:15_000,builderOutputTokens:6_000,reviewerInputTokens:40_000,reviewerOutputTokens:12_000}},
      cachePolicyVersion:"engineer-hardening-prompt-cache-v1",cacheAccountingVersion:"openai-prompt-cache-accounting-v1",
      cacheWriteInputMultiplier:{numerator:5,denominator:4},
      assumptions:["ESTIMATE_IS_HARD_CAP","NO_AUTOMATIC_REPAIR","NO_PARENT_BUDGET_TRANSFER","CACHE_HIT_NOT_ASSUMED","CACHE_WRITE_WORST_CASE","CACHE_DOES_NOT_REDUCE_TPM"]});
    expect(await value.supervisor.createHardeningQuoteForOwner(value.run.userId,request)).toEqual(quote);
    expect(await value.supervisor.getHardeningQuoteForOwner(value.run.userId,value.run.runId,quote.quoteId)).toEqual(quote);
    await expect(value.supervisor.createHardeningQuoteForOwner(value.run.userId,{...request,advisoryIds:[]})).rejects.toThrow();
    await expect(value.supervisor.createHardeningQuoteForOwner(value.run.userId,{...request,expectedParentStateVersion:parent.stateVersion+1})).rejects.toThrow(IdempotencyConflictError);
    const consentRequest={quoteId:quote.quoteId,quoteHash:quote.quoteHash,authorizedBudget:{costMicrousd:quote.estimate.maxCostMicrousd,tokens:quote.estimate.maxTokens,timeSeconds:quote.estimate.maxTimeSeconds},
      acknowledgements:{separateRun:true as const,parentCandidateUnchanged:true as const,noAutomaticRepair:true as const,noOverages:true as const},expectedParentStateVersion:parent.stateVersion,idempotencyKey:"consent-happy"};
    const consent=await value.supervisor.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,consentRequest);
    expect(await value.supervisor.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,consentRequest)).toEqual(consent);
    await expect(value.supervisor.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{...consentRequest,authorizedBudget:{...consentRequest.authorizedBudget,tokens:1}})).rejects.toThrow(IdempotencyConflictError);
    await value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,advisory.advisoryId,{expectedRevision:0,idempotencyKey:"defer-after-consent",rationale:null});
    const approved=value.supervisor.getRun(value.run.runId);
    value.supervisor.transition({runId:approved.runId,expectedStateVersion:approved.stateVersion,nextState:"HUMAN_APPROVAL_PENDING",
      reasonCode:"HUMAN_GATE_REQUIRED",manifestHash:approved.manifestHash,idempotencyKey:`${approved.runId}:human-pending-after-hardening-consent`});
    expect(await value.supervisor.getHardeningQuoteForOwner(value.run.userId,value.run.runId,quote.quoteId)).toEqual(quote);
    await expect(value.supervisor.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{...consentRequest,idempotencyKey:"new-consent-after-parent-advance"}))
      .rejects.toThrow("state version");
    expect(await value.supervisor.createHardeningQuoteForOwner(value.run.userId,request)).toEqual(quote);
    expect(await value.supervisor.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,consentRequest)).toEqual(consent);
    const records=value.supervisor.exportRunRecords(value.run.runId);
    expect(records.hardening_quotes).toHaveLength(1);expect(records.hardening_quote_requests).toHaveLength(1);expect(records.hardening_consents).toHaveLength(1);
    expect(records.advisory_backlog_events).toHaveLength(1);expect(records.advisory_backlog_events![0]).toMatchObject({event_type:"DEFERRED"});
    expect(records.engineer_run_lineage).toHaveLength(0);
    expect(value.supervisor.getRun(value.run.runId)).toMatchObject({state:"HUMAN_APPROVAL_PENDING",stateVersion:parent.stateVersion+1});
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("rejects non-open, audit-only, foreign-owner, stale-state, and over-cap hardening authority atomically", async () => {
    const deferred=promotionFixture("run-hardening-quote-deferred",true);
    await deferred.supervisor.promoteVerifiedCandidate(deferred.promotion,deferred.run.stateVersion);
    const parent=deferred.supervisor.getRun(deferred.run.runId);const item=(await deferred.supervisor.listAdvisoryBacklogForOwner(deferred.run.userId,deferred.run.runId)).items[0]!;
    await deferred.supervisor.deferAdvisoryForOwner(deferred.run.userId,deferred.run.runId,item.advisoryId,{expectedRevision:0,idempotencyKey:"defer-before-quote",rationale:null});
    const request={runId:deferred.run.runId,advisoryIds:[item.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-deferred"};
    await expect(deferred.supervisor.createHardeningQuoteForOwner(deferred.run.userId,request)).rejects.toThrow("open, actionable");
    await expect(deferred.supervisor.createHardeningQuoteForOwner("other-owner",request)).rejects.toThrow("not found");
    expect(deferred.supervisor.exportRunRecords(deferred.run.runId).hardening_quotes).toHaveLength(0);
    deferred.supervisor.close();rmSync(deferred.root,{recursive:true,force:true});

    const auditOnly=promotionFixture("run-hardening-quote-audit-only",true,"src/.git/config");
    await auditOnly.supervisor.promoteVerifiedCandidate(auditOnly.promotion,auditOnly.run.stateVersion);
    const auditParent=auditOnly.supervisor.getRun(auditOnly.run.runId);const auditItem=(await auditOnly.supervisor.listAdvisoryBacklogForOwner(auditOnly.run.userId,auditOnly.run.runId)).items[0]!;
    await expect(auditOnly.supervisor.createHardeningQuoteForOwner(auditOnly.run.userId,{runId:auditOnly.run.runId,advisoryIds:[auditItem.advisoryId],expectedParentStateVersion:auditParent.stateVersion,idempotencyKey:"quote-audit"})).rejects.toThrow("open, actionable");
    await expect(auditOnly.supervisor.createHardeningQuoteForOwner(auditOnly.run.userId,{runId:auditOnly.run.runId,advisoryIds:[auditItem.advisoryId],expectedParentStateVersion:auditParent.stateVersion+1,idempotencyKey:"quote-stale"})).rejects.toThrow("state version");
    expect(auditOnly.supervisor.exportRunRecords(auditOnly.run.runId).hardening_quote_requests).toHaveLength(0);
    auditOnly.supervisor.close();rmSync(auditOnly.root,{recursive:true,force:true});
  });

  test("keeps expired quotes readable but rejects late consent and detects canonical quote tampering", async () => {
    const value=promotionFixture("run-hardening-quote-expiry",true);await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId),item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const quote=await value.supervisor.createHardeningQuoteForOwner(value.run.userId,{runId:value.run.runId,advisoryIds:[item.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-expiry"});
    const late=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date("2026-07-17T18:15:00.001Z"),checkpointAttestor});
    late.configureArtifactReadAuthority(value.artifactStore);
    expect(await late.getHardeningQuoteForOwner(value.run.userId,value.run.runId,quote.quoteId)).toMatchObject({status:"EXPIRED"});
    await expect(late.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{quoteId:quote.quoteId,quoteHash:quote.quoteHash,
      authorizedBudget:{costMicrousd:1,tokens:1,timeSeconds:1},acknowledgements:{separateRun:true,parentCandidateUnchanged:true,noAutomaticRepair:true,noOverages:true},
      expectedParentStateVersion:parent.stateVersion,idempotencyKey:"late-consent"})).rejects.toThrow("expired");
    expect(late.exportRunRecords(value.run.runId).hardening_consents).toHaveLength(0);late.close();
    const db=new Database(value.dbPath);db.exec("DROP TRIGGER prevent_hardening_quotes_update_v23");db.query("UPDATE hardening_quotes SET quote_json='{}' WHERE id=?").run(quote.quoteId);db.close();
    await expect(value.supervisor.getHardeningQuoteForOwner(value.run.userId,value.run.runId,quote.quoteId)).rejects.toThrow("authority");
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("accepts consent at the exact expiry boundary and rolls back every over-cap attempt", async () => {
    const value=promotionFixture("run-hardening-consent-boundary",true);await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId),item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const quote=await value.supervisor.createHardeningQuoteForOwner(value.run.userId,{runId:value.run.runId,advisoryIds:[item.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-boundary"});
    const acknowledgement={separateRun:true as const,parentCandidateUnchanged:true as const,noAutomaticRepair:true as const,noOverages:true as const};
    await expect(value.supervisor.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{quoteId:quote.quoteId,quoteHash:quote.quoteHash,
      authorizedBudget:{costMicrousd:quote.estimate.maxCostMicrousd+1,tokens:quote.estimate.maxTokens,timeSeconds:quote.estimate.maxTimeSeconds},
      acknowledgements:acknowledgement,expectedParentStateVersion:parent.stateVersion,idempotencyKey:"consent-over-cap"})).rejects.toThrow("exceeds");
    expect(value.supervisor.exportRunRecords(value.run.runId).hardening_consents).toHaveLength(0);
    const atExpiry=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(quote.expiresAt),checkpointAttestor});
    atExpiry.configureArtifactReadAuthority(value.artifactStore);
    const consent=await atExpiry.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{quoteId:quote.quoteId,quoteHash:quote.quoteHash,
      authorizedBudget:{costMicrousd:quote.estimate.maxCostMicrousd,tokens:quote.estimate.maxTokens,timeSeconds:quote.estimate.maxTimeSeconds},
      acknowledgements:acknowledgement,expectedParentStateVersion:parent.stateVersion,idempotencyKey:"consent-at-expiry"});
    expect(consent.acceptedAt).toBe(quote.expiresAt);expect(atExpiry.exportRunRecords(value.run.runId).hardening_consents).toHaveLength(1);
    atExpiry.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("rejects a coherently rehashed quote whose caps do not match the deterministic estimator", async () => {
    const value=promotionFixture("run-hardening-forged-estimate",true);await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId),item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const authentic=await value.supervisor.createHardeningQuoteForOwner(value.run.userId,{runId:value.run.runId,advisoryIds:[item.advisoryId],
      expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-authentic-estimate"});
    const db=new Database(value.dbPath);
    const authenticRow=db.query("SELECT quote_json,sizing_authority_id FROM hardening_quotes WHERE id=?").get(authentic.quoteId) as {quote_json:string;sizing_authority_id:string};
    const sizingRow=db.query("SELECT authority_json FROM hardening_quote_sizing_authorities WHERE id=?").get(authenticRow.sizing_authority_id) as {authority_json:string};
    const advisoryRow=db.query("SELECT item_json FROM advisory_backlog_items WHERE id=?").get(item.advisoryId) as {item_json:string};
    const full=HardeningQuoteSchema.parse(JSON.parse(authenticRow.quote_json));
    const advisory=AdvisoryBacklogItemSchema.parse(JSON.parse(advisoryRow.item_json));
    if(full.schemaVersion!==2)throw new Error("fresh hardening quote must use v2 sizing authority");
    const {quoteId:_quoteId,quoteHash:_quoteHash,...content}=full;
    HardeningQuoteSizingAuthoritySchema.parse(JSON.parse(sizingRow.authority_json));
    const forgedContent={...content,estimate:{...content.estimate,maxTokens:content.estimate.maxTokens+1}};
    const forgedQuoteHash=sha256(forgedContent);
    const forged={...forgedContent,quoteHash:forgedQuoteHash,
      quoteId:sha256({namespace:"engineer-hardening-estimate-v2",quoteHash:forgedQuoteHash})};
    const requestInput={runId:value.run.runId,advisoryIds:[item.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-forged-estimate"};
    const requestContent={schemaVersion:2,policyVersion:"engineer-hardening-quote-request-v2",requesterUserId:value.run.userId,...requestInput};
    const requestHash=sha256(requestContent),requestId=sha256({namespace:"engineer-hardening-quote-request-v2",requestHash});
    const request={...requestContent,requestHash,requestId};
    db.exec("BEGIN IMMEDIATE");
    db.query("INSERT INTO hardening_quote_advisories(quote_id,ordinal,advisory_id) VALUES (?,0,?)").run(forged.quoteId,advisory.advisoryId);
    db.query(`INSERT INTO hardening_quotes(id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,
      repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,routing_policy_version,
      pricing_version,max_cost_microusd,max_tokens,max_time_seconds,max_planner_calls,max_builder_calls,max_reviewer_calls,
      automatic_repair_calls,sizing_authority_id,sizing_authority_hash,local_input_counter_version,builder_prompt_version,reviewer_policy_version,
      cache_policy_version,cache_accounting_version,cache_write_input_multiplier_numerator,cache_write_input_multiplier_denominator,
      builder_input_token_cap,builder_output_token_cap,reviewer_input_token_cap,reviewer_output_token_cap,quote_json,created_at,expires_at)
      VALUES(${Array.from({length:38},(_,index)=>index===2?"2":"?").join(",")})`).run(
      forged.quoteId,forged.quoteHash,forged.policyVersion,forged.estimatorVersion,forged.parentRunId,forged.requesterUserId,forged.repositoryId,
      forged.parentCheckpointId,forged.parentCheckpointHash,forged.parentStateVersion,forged.selectionHash,forged.advisoryIds.length,
      forged.routingPolicyVersion,forged.pricingVersion,forged.estimate.maxCostMicrousd,forged.estimate.maxTokens,forged.estimate.maxTimeSeconds,
      forged.estimate.maxPlannerCalls,forged.estimate.maxBuilderCalls,forged.estimate.maxReviewerCalls,forged.estimate.automaticRepairCalls,
      forged.sizingAuthorityId,forged.sizingAuthorityHash,forged.localInputCounterVersion,forged.builderPromptVersion,forged.reviewerPolicyVersion,
      forged.cachePolicyVersion,forged.cacheAccountingVersion,forged.cacheWriteInputMultiplier.numerator,forged.cacheWriteInputMultiplier.denominator,
      forged.inputCaps.builderInputTokens,forged.inputCaps.builderOutputTokens,forged.inputCaps.reviewerInputTokens,forged.inputCaps.reviewerOutputTokens,
      canonicalJson(forged),forged.createdAt,forged.expiresAt);
    db.query(`INSERT INTO hardening_quote_requests(id,request_hash,requester_user_id,parent_run_id,idempotency_key,quote_id,quote_hash,request_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(requestId,requestHash,value.run.userId,value.run.runId,requestInput.idempotencyKey,forged.quoteId,forged.quoteHash,canonicalJson(request),forged.createdAt);
    db.exec("COMMIT");db.close();
    await expect(value.supervisor.getHardeningQuoteForOwner(value.run.userId,value.run.runId,forged.quoteId)).rejects.toThrow("authority");
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("two supervisors converge on one durable quote request and one quote", async () => {
    const value=promotionFixture("run-hardening-quote-race",true);await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId),item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const second=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(timestamp),checkpointAttestor});
    second.configureArtifactReadAuthority(value.artifactStore);
    const request={runId:value.run.runId,advisoryIds:[item.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-race"};
    const outcomes=await Promise.all([value.supervisor.createHardeningQuoteForOwner(value.run.userId,request),second.createHardeningQuoteForOwner(value.run.userId,request)]);
    expect(outcomes[0]).toEqual(outcomes[1]);const records=value.supervisor.exportRunRecords(value.run.runId);
    expect(records.hardening_quotes).toHaveLength(1);expect(records.hardening_quote_requests).toHaveLength(1);expect(records.advisory_backlog_events).toHaveLength(0);
    second.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("rechecks signed checkpoint bytes inside the quote transaction before any mapping is written", async () => {
    const value=promotionFixture("run-hardening-quote-attestation-race",true);await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId),item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;let mutated=false;
    value.supervisor.configureCheckpointAttestor({...checkpointAttestor,verify:(payload,signature)=>{if(!mutated){mutated=true;const db=new Database(value.dbPath);
      db.exec("DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21");db.query("UPDATE verified_candidate_checkpoints SET signature='tampered-after-check' WHERE run_id=?").run(value.run.runId);db.close();}
      return checkpointAttestor.verify(payload,signature);}});
    await expect(value.supervisor.createHardeningQuoteForOwner(value.run.userId,{runId:value.run.runId,advisoryIds:[item.advisoryId],
      expectedParentStateVersion:parent.stateVersion,idempotencyKey:"quote-attestation-race"})).rejects.toThrow("authority");
    const records=value.supervisor.exportRunRecords(value.run.runId);expect(records.hardening_quotes).toHaveLength(0);expect(records.hardening_quote_requests).toHaveLength(0);
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("atomically creates and exactly replays a separate pristine hardening child without mutating the parent", async () => {
    const value=await hardeningConsentFixture("run-hardening-child-happy",["src/second.ts"]);
    const before=new Database(value.dbPath);const parentBefore=before.query("SELECT * FROM engineer_runs WHERE id=?").get(value.run.runId);
    const parentBudgetBefore=before.query("SELECT * FROM run_budgets WHERE run_id=?").get(value.run.runId);before.close();
    const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,{consentId:value.consent.consentId,consentHash:value.consent.consentHash});const child=creation.child;
    expect(child).toMatchObject({parentRunId:value.run.runId,rootRunId:value.run.runId,childRunId:hardeningChildRunId(value.consent.consentHash),
      state:"REQUEST_RECEIVED",stateVersion:0,humanGateRequired:true,budget:value.consent.authorizedBudget});
    const childRun=value.supervisor.getRun(child.childRunId);expect(childRun).toMatchObject({state:"REQUEST_RECEIVED",stateVersion:0,manifestHash:null,
      repository:{repositoryId:value.parent.repository.repositoryId,baseBranch:value.parent.repository.baseBranch,baseCommitSha:value.parent.repository.baseCommitSha}});
    const authority=OptionalHardeningChildAuthoritySchema.parse(JSON.parse(childRun.requestOriginal));
    expect(childRun.requestNormalized).toBe(childRun.requestOriginal);expect(authority).toMatchObject({rootRunId:value.run.runId,parentRunId:value.run.runId,
      childRunId:child.childRunId,parentCheckpointId:value.quote.parentCheckpointId,parentCheckpointHash:value.quote.parentCheckpointHash,
      quoteId:value.quote.quoteId,quoteHash:value.quote.quoteHash,consentId:value.consent.consentId,consentHash:value.consent.consentHash,
      advisoryIds:value.quote.advisoryIds,selectionHash:value.quote.selectionHash,seedResultCommitSha:value.reviewerInput.resultCommitSha});
    expect(authority.requiredChanges.map((change)=>change.advisoryId)).toEqual(value.quote.advisoryIds);
    const db=new Database(value.dbPath);expect(db.query("SELECT revision,used_cost_usd,used_tokens,used_time_seconds,reserved_cost_usd,reserved_tokens,ambiguous_cost_usd,ambiguous_tokens FROM run_budgets WHERE run_id=?").get(child.childRunId))
      .toEqual({revision:0,used_cost_usd:0,used_tokens:0,used_time_seconds:0,reserved_cost_usd:0,reserved_tokens:0,ambiguous_cost_usd:0,ambiguous_tokens:0});
    expect(db.query("SELECT * FROM engineer_runs WHERE id=?").get(value.run.runId)).toEqual(parentBefore);
    expect(db.query("SELECT * FROM run_budgets WHERE run_id=?").get(value.run.runId)).toEqual(parentBudgetBefore);
    for(const table of ["task_manifest_versions","plan_proposals","run_state_events","agent_executions","sandboxes","artifacts","approval_requests","git_operations"]){
      expect(db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id=?`).get(child.childRunId)).toEqual({count:0});}
    expect(db.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=?").get(child.childRunId)).toEqual({count:0});db.close();
    await value.supervisor.deferAdvisoryForOwner(value.run.userId,value.run.runId,value.advisories[0]!.advisoryId,{expectedRevision:0,idempotencyKey:"defer-after-child",rationale:null});
    const approved=value.supervisor.getRun(value.run.runId);value.supervisor.transition({runId:approved.runId,expectedStateVersion:approved.stateVersion,
      nextState:"HUMAN_APPROVAL_PENDING",reasonCode:"HUMAN_GATE_REQUIRED",manifestHash:approved.manifestHash,idempotencyKey:"parent-advanced-after-child"});
    expect(creation.lineage).toMatchObject({lineageId:child.lineageId,lineageHash:child.lineageHash,rootRunId:child.rootRunId,
      parentRunId:child.parentRunId,childRunId:child.childRunId,budget:child.budget,createdAt:child.createdAt});
    expect(await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,{consentId:value.consent.consentId,consentHash:value.consent.consentHash})).toEqual(creation);
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("permits first P4 child creation after a legitimate parent state advance when frozen authority is exact", async () => {
    const value=await hardeningConsentFixture("run-hardening-child-parent-advanced-first");
    const before=value.supervisor.getRun(value.run.runId);value.supervisor.transition({runId:before.runId,expectedStateVersion:before.stateVersion,
      nextState:"HUMAN_APPROVAL_PENDING",reasonCode:"HUMAN_GATE_REQUIRED",manifestHash:before.manifestHash,idempotencyKey:"advance-before-first-child"});
    const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
      {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
    expect(creation.child).toMatchObject({parentRunId:value.run.runId,state:"REQUEST_RECEIVED",stateVersion:0});
    expect(creation.lineage).toMatchObject({parentRunId:value.run.runId,parentCheckpointId:value.quote.parentCheckpointId,
      parentCheckpointHash:value.quote.parentCheckpointHash,consentId:value.consent.consentId,consentHash:value.consent.consentHash});
    value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("atomically commits exact P5 start and signed seed authority then replays without duplicate advisory events", async () => {
    const value=await hardeningConsentFixture("run-hardening-start-happy");const creation=await value.supervisor.createOptionalHardeningChildForOwner(
      value.run.userId,value.run.runId,{consentId:value.consent.consentId,consentHash:value.consent.consentHash});
    const input={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,lineageHash:creation.lineage.lineageHash,idempotencyKey:"start-once"};
    const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,input);
    expect(prepared).toMatchObject({replay:false,signedSeed:null,operation:{childRunId:creation.child.childRunId},seed:{diffHash:value.quote.parentCheckpointHash===prepared.parentCheckpoint.checkpointHash?prepared.parentCheckpoint.diffHash:""}});
    const signedSeed=await createSignedHardeningSeedAttestation({schemaVersion:1,policyVersion:"engineer-hardening-seed-attestation-v1",
      attestationType:"HARDENING_SEED_VERIFIED",operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,
      rootRunId:prepared.lineage.rootRunId,parentRunId:value.run.runId,childRunId:creation.child.childRunId,requesterUserId:value.run.userId,
      repositoryId:prepared.lineage.repositoryId,lineageId:prepared.lineage.lineageId,lineageHash:prepared.lineage.lineageHash,
      parentCheckpointId:prepared.parentCheckpoint.checkpointId,parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,
      baseCommitSha:prepared.seed.baseCommitSha,seedResultCommitSha:prepared.seed.seedResultCommitSha,seedTreeHash:sha256("seed-tree"),
      seedDiffHash:prepared.seed.diffHash,imageDigest:sha256("image"),environmentDigest:prepared.seed.environmentDigest,
      dependencyHash:sha256("dependencies"),createdAt:prepared.operation.createdAt},checkpointAttestor);
    const committed=await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,input,prepared,signedSeed);
    expect(committed.signedSeed).toEqual(signedSeed);
    const db=new Database(value.dbPath);expect(db.query("SELECT COUNT(*) AS count FROM hardening_start_operations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:1});
    expect(db.query("SELECT COUNT(*) AS count FROM hardening_seed_attestations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:1});
    expect(db.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STARTED'").get(creation.child.childRunId)).toEqual({count:value.advisories.length});db.close();
    let finalizerId=0;const finalizer=createEngineerSupervisor({dbPath:value.dbPath,idFactory:()=>`hardening-finalize-${++finalizerId}`,
      now:()=>new Date(timestamp),checkpointAttestor});const finalized=finalizer.finalizeOptionalHardeningStart(committed);
    expect(finalized).toMatchObject({status:"READY",run:{state:"PLAN_FROZEN"}});
    expect(finalized.manifest?.acceptanceCriteria).toHaveLength(value.advisories.length);expect(finalized.manifest?.retryBudgets).toEqual({sameFailureAttempts:0,
      builderRepairAttempts:0,reviewerFixAttempts:0,plannerRestarts:0,sandboxProvisioningAttempts:0,transientModelAttempts:0});
    let stoppedRun=finalizer.getRun(creation.child.childRunId);
    for(const [nextState,reasonCode] of [["QUEUED","TEST_HARDENING_QUEUED"],["SANDBOX_READY","TEST_HARDENING_SANDBOX_READY"],
      ["IMPLEMENTING","TEST_HARDENING_IMPLEMENTING"],["FAST_CHECKS","TEST_HARDENING_FAST_CHECKS"],
      ["UNIT_TESTING","TEST_HARDENING_UNIT_TESTING"]] as const){
      stoppedRun=finalizer.transition({runId:stoppedRun.runId,expectedStateVersion:stoppedRun.stateVersion,nextState,reasonCode,
        manifestHash:stoppedRun.manifestHash,idempotencyKey:`stable-stop-state:${nextState}`}).run;
    }
    const stableFailure={failureId:sha256("hardening-stable-required-test-failure"),runId:creation.child.childRunId,
      failureClass:"TEST_FAILURE" as const,reasonCode:"STABLE_REQUIRED_TEST_FAILED",fingerprint:sha256("stable-required-test"),
      evidenceIds:["stable-required-test-evidence"],retryable:false,createdAt:timestamp};
    const frozen=finalizer.stopOptionalHardeningForStableRequiredTest(stableFailure);
    expect(frozen.state).toBe("HUMAN_REVIEW_REQUIRED");
    expect(finalizer.stopOptionalHardeningForStableRequiredTest(stableFailure)).toEqual(frozen);
    const stoppedAuthority=new Database(value.dbPath);
    expect(stoppedAuthority.query("SELECT COUNT(*) AS count FROM failure_records WHERE run_id=? AND reason_code='STABLE_REQUIRED_TEST_FAILED'")
      .get(creation.child.childRunId)).toEqual({count:1});
    expect(stoppedAuthority.query("SELECT COUNT(*) AS count FROM run_state_events WHERE run_id=? AND reason_code='HARDENING_STABLE_REQUIRED_TEST_FAILED'")
      .get(creation.child.childRunId)).toEqual({count:1});
    expect(stoppedAuthority.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STOPPED'")
      .get(creation.child.childRunId)).toEqual({count:value.advisories.length});
    stoppedAuthority.close();
    expect(()=>finalizer.recordAgentExecution({agentExecutionId:"hardening-planner",runId:creation.child.childRunId,role:"PLANNER",
      modelTier:"GPT-5.6_TERRA",status:"RUNNING",inputHash:sha256("planner"),outputArtifactId:null,startedAt:timestamp,completedAt:null})).toThrow();
    for(const role of ["TESTER","SECURITY"] as const)expect(()=>finalizer.recordAgentExecution({agentExecutionId:`hardening-${role.toLowerCase()}`,
      runId:creation.child.childRunId,role,modelTier:"GPT-5.6_TERRA",status:"RUNNING",inputHash:sha256(role),outputArtifactId:null,
      startedAt:timestamp,completedAt:null})).toThrow();
    expect(()=>finalizer.recordAgentExecution({agentExecutionId:"hardening-wrong-builder-tier",runId:creation.child.childRunId,role:"BUILDER",
      modelTier:"GPT-5.6_SOL",status:"RUNNING",inputHash:sha256("wrong-builder-tier"),outputArtifactId:null,startedAt:timestamp,completedAt:null})).toThrow();
    expect(()=>finalizer.recordAgentExecution({agentExecutionId:"hardening-wrong-reviewer-tier",runId:creation.child.childRunId,role:"REVIEWER",
      modelTier:"GPT-5.6_TERRA",status:"RUNNING",inputHash:sha256("wrong-reviewer-tier"),outputArtifactId:null,startedAt:timestamp,completedAt:null})).toThrow();
    const builder={agentExecutionId:"hardening-builder",runId:creation.child.childRunId,role:"BUILDER" as const,
      modelTier:"GPT-5.6_TERRA" as const,status:"RUNNING" as const,inputHash:sha256("builder"),outputArtifactId:null,startedAt:timestamp,completedAt:null};
    finalizer.recordAgentExecution(builder);
    expect(()=>finalizer.recordAgentExecution({...builder,agentExecutionId:"hardening-builder-2",inputHash:sha256("builder-2")})).toThrow();
    finalizer.recordModelRouting({routingDecisionId:"hardening-builder-route",runId:creation.child.childRunId,
      agentExecutionId:builder.agentExecutionId,agentRole:"BUILDER",logicalTier:"GPT-5.6_TERRA",resolvedModel:"gpt-5.6-terra",
      routingPolicyVersion:"test-hardening-v1",fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp});
    const failedCall={modelCallId:"hardening-builder-call",runId:creation.child.childRunId,agentExecutionId:builder.agentExecutionId,
      logicalTier:"GPT-5.6_TERRA" as const,resolvedModel:"gpt-5.6-terra",promptTemplateVersion:"test-hardening-v1",
      inputContextRefs:[sha256("builder")],outputSchemaVersion:"test-v1",cacheKey:sha256("hardening-call"),cacheHit:null,
      latencyMs:1,inputTokens:null,outputTokens:null,retryCount:0,status:"FAILED" as const,createdAt:timestamp};
    expect(()=>finalizer.recordModelCall(failedCall)).toThrow("authority");
    expect(()=>finalizer.recordModelCall({...failedCall,modelCallId:"hardening-builder-call-2",cacheKey:sha256("hardening-call-2")})).toThrow();
    const reviewer={agentExecutionId:"hardening-reviewer",runId:creation.child.childRunId,role:"REVIEWER" as const,
      modelTier:"GPT-5.6_SOL" as const,status:"RUNNING" as const,inputHash:sha256("reviewer"),outputArtifactId:null,startedAt:timestamp,completedAt:null};
    finalizer.recordAgentExecution(reviewer);
    expect(()=>finalizer.recordAgentExecution({...reviewer,agentExecutionId:"hardening-reviewer-2",inputHash:sha256("reviewer-2")})).toThrow();
    finalizer.recordOptionalHardeningStopped(creation.child.childRunId,"FAILED");
    finalizer.recordOptionalHardeningStopped(creation.child.childRunId,"FAILED");
    const stopped=new Database(value.dbPath);expect(stopped.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STOPPED'")
      .get(creation.child.childRunId)).toEqual({count:value.advisories.length});stopped.close();
    const replay=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,input);
    expect(replay).toMatchObject({replay:true,operation:prepared.operation,signedSeed});
    finalizer.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("D-E cancellation plus a crash before finalization application rolls back and then converges exactly once", async () => {
    const fixture=await pendingSettledHardeningBuilderFixture("cancel-finalization-atomic");
    const childId=fixture.child.runId;
    try{
      let child=fixture.supervisor.getRun(childId);
      child=fixture.supervisor.transition({runId:childId,expectedStateVersion:child.stateVersion,nextState:"CANCELLATION_PENDING",
        reasonCode:"TEST_CANCEL_DURABLE_BEFORE_DRAIN",manifestHash:child.manifestHash,
        idempotencyKey:"cancel-finalization-atomic:pending"}).run;
      child=fixture.supervisor.transition({runId:childId,expectedStateVersion:child.stateVersion,nextState:"CANCELLED",
        reasonCode:"TEST_CANCEL_AFTER_DRAIN",manifestHash:child.manifestHash,
        idempotencyKey:"cancel-finalization-atomic:cancelled"}).run;
      expect(child.state).toBe("CANCELLED");

      expect(()=>fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:childId,ownerId:"forged-recovery",
        rawToken:"forged-recovery-token",nowMs:fixture.nowMs,
        recoveryWorkerLease:{leaseId:"forged-lease",ownerId:"forged-recovery",fencingToken:1,leaseToken:"forged-token"}}))
        .toThrow("active authenticated run lease");
      const staleLease=acquireFixtureRecoveryLease(fixture,"stale-recovery","stale-recovery:lease");
      releaseFixtureRecoveryLease(fixture,staleLease,"stale-recovery:release");
      expect(()=>fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:childId,ownerId:"stale-recovery",
        rawToken:"stale-recovery-token",nowMs:fixture.nowMs,
        recoveryWorkerLease:fixtureRecoveryProof(staleLease)})).toThrow("active authenticated run lease");
      const foreignLease=fixture.recoveryLeaseManager.acquire({resourceKey:"run:foreign-child",ownerId:"foreign-recovery",
        ttlMs:30_000,idempotencyKey:"foreign-recovery:lease"});
      try{
        expect(()=>fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:childId,ownerId:"foreign-recovery",
          rawToken:"foreign-recovery-token",nowMs:fixture.nowMs,
          recoveryWorkerLease:fixtureRecoveryProof(foreignLease)})).toThrow("exact run and owner");
      }finally{releaseFixtureRecoveryLease(fixture,foreignLease,"foreign-recovery:release");}

      const internalLedger=(fixture.supervisor as unknown as {ledger:EngineerLedger}).ledger;
      const originalApply=internalLedger.applyHardeningPaidCallFinalization.bind(internalLedger);
      const crashedLease=acquireFixtureRecoveryLease(fixture,"cancel-recovery-crashed","cancel-recovery-crashed:lease");
      const leaseContender=new Database(join(fixture.value.root,"recovery-worker-leases.db"),{readwrite:true,create:false});
      leaseContender.exec("PRAGMA busy_timeout = 1");
      let outerAuthorityLockObserved=false;
      internalLedger.applyHardeningPaidCallFinalization=(()=>{
        // We are inside EngineerLedger.atomic here. The separate worker DB
        // must still be locked by withActiveLease, otherwise release/expiry
        // could revoke this proof before the Engineer commit becomes durable.
        expect(()=>leaseContender.query("UPDATE worker_leases SET status='RELEASED' WHERE id=?")
          .run(crashedLease.lease.leaseId)).toThrow(/locked|busy/i);
        outerAuthorityLockObserved=true;
        throw new Error("forced crash immediately before APPLIED");
      }) as typeof internalLedger.applyHardeningPaidCallFinalization;
      try{
        expect(()=>fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:childId,ownerId:"cancel-recovery-crashed",
          rawToken:"cancel-recovery-crashed-token",nowMs:fixture.nowMs+1,
          recoveryWorkerLease:fixtureRecoveryProof(crashedLease)})).toThrow("forced crash immediately before APPLIED");
      }finally{releaseFixtureRecoveryLease(fixture,crashedLease,"cancel-recovery-crashed:release");}
      expect(outerAuthorityLockObserved).toBe(true);
      leaseContender.close();
      internalLedger.applyHardeningPaidCallFinalization=originalApply;

      const afterCrash=new Database(fixture.value.dbPath,{readonly:true});
      expect(afterCrash.query("SELECT state FROM engineer_runs WHERE id=?").get(childId)).toEqual({state:"CANCELLED"});
      expect(afterCrash.query("SELECT status FROM agent_executions WHERE id=?").get(fixture.agentExecutionId)).toEqual({status:"RUNNING"});
      expect(afterCrash.query("SELECT status FROM hardening_paid_call_finalizations WHERE child_run_id=?").get(childId)).toEqual({status:"PENDING"});
      expect(afterCrash.query("SELECT COUNT(*) AS count FROM hardening_recovery_worker_fences WHERE child_run_id=?")
        .get(childId)).toEqual({count:0});
      expect(afterCrash.query("SELECT status,stop_reason FROM hardening_child_budget_authorities WHERE child_run_id=?").get(childId))
        .toEqual({status:"ACTIVE",stop_reason:null});
      expect(afterCrash.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STOPPED'")
        .get(childId)).toEqual({count:0});
      afterCrash.close();

      const successLease=acquireFixtureRecoveryLease(fixture,"cancel-recovery-success","cancel-recovery-success:lease");
      expect(successLease.lease.fencingToken).toBeGreaterThan(crashedLease.lease.fencingToken);
      try{
        expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:childId,ownerId:"cancel-recovery-success",
          rawToken:"cancel-recovery-success-token",nowMs:fixture.nowMs+2,
          recoveryWorkerLease:fixtureRecoveryProof(successLease)})).toEqual({
            recoveredReservations:0,appliedFinalizations:1,terminalizedPreReservationAgent:false,
          });
      }finally{releaseFixtureRecoveryLease(fixture,successLease,"cancel-recovery-success:release");}
      const afterRecovery=new Database(fixture.value.dbPath,{readonly:true});
      expect(afterRecovery.query("SELECT state FROM engineer_runs WHERE id=?").get(childId)).toEqual({state:"CANCELLED"});
      expect(afterRecovery.query("SELECT status FROM agent_executions WHERE id=?").get(fixture.agentExecutionId)).toEqual({status:"FAILED"});
      expect(afterRecovery.query("SELECT status FROM hardening_paid_call_finalizations WHERE child_run_id=?").get(childId)).toEqual({status:"APPLIED"});
      expect(afterRecovery.query("SELECT status,stop_reason,reserved_cost_microusd,reserved_tokens FROM hardening_child_budget_authorities WHERE child_run_id=?")
        .get(childId)).toEqual({status:"STOPPED",stop_reason:"CANCELLED",reserved_cost_microusd:0,reserved_tokens:0});
      const expectedStopped=fixture.value.advisories.length;
      expect(afterRecovery.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STOPPED'")
        .get(childId)).toEqual({count:expectedStopped});
      afterRecovery.close();

      const replayLease=acquireFixtureRecoveryLease(fixture,"cancel-recovery-replay","cancel-recovery-replay:lease");
      expect(replayLease.lease.fencingToken).toBeGreaterThan(successLease.lease.fencingToken);
      try{
        expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:childId,ownerId:"cancel-recovery-replay",
          rawToken:"cancel-recovery-replay-token",nowMs:fixture.nowMs+3,
          recoveryWorkerLease:fixtureRecoveryProof(replayLease)})).toEqual({
            recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:false,
          });
      }finally{releaseFixtureRecoveryLease(fixture,replayLease,"cancel-recovery-replay:release");}
      expect(()=>fixture.ledger.claimHardeningRecoveryWorkerFence({childRunId:childId,
        workerLeaseId:crashedLease.lease.leaseId,workerOwnerId:crashedLease.lease.ownerId,
        workerFencingToken:crashedLease.lease.fencingToken,rawWorkerLeaseToken:crashedLease.leaseToken,
        nowMs:fixture.nowMs+4})).toThrow("stale or expired");
      const afterReplay=new Database(fixture.value.dbPath,{readonly:true});
      expect(afterReplay.query("SELECT COUNT(*) AS count FROM hardening_paid_call_finalizations WHERE child_run_id=?")
        .get(childId)).toEqual({count:1});
      expect(afterReplay.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STOPPED'")
        .get(childId)).toEqual({count:expectedStopped});
      expect(afterReplay.query(`SELECT worker_lease_id,worker_owner_id,worker_fencing_token
        FROM hardening_recovery_worker_fences WHERE child_run_id=?`).get(childId)).toEqual({
          worker_lease_id:successLease.lease.leaseId,worker_owner_id:successLease.lease.ownerId,
          worker_fencing_token:successLease.lease.fencingToken,
        });
      afterReplay.close();
    }finally{
      fixture.ledger.close();fixture.supervisor.close();fixture.value.supervisor.close();fixture.recoveryLeaseManager.close();
      rmSync(fixture.value.root,{recursive:true,force:true});
    }
  });

  test("I finalization claims fence competitors, permit expired reclaim, and fail closed on payload tamper", async () => {
    const fixture=await pendingSettledHardeningBuilderFixture("finalization-reclaim-tamper");
    try{
      const pending=fixture.ledger.listPendingHardeningPaidCallFinalizations(fixture.child.runId);
      expect(pending).toHaveLength(1);const finalization=pending[0]!;
      const immutableAttempt=new Database(fixture.value.dbPath);
      expect(()=>immutableAttempt.query("UPDATE hardening_paid_call_finalizations SET payload_json='{}' WHERE id=?")
        .run(finalization.id)).toThrow("immutable payload mismatch");
      immutableAttempt.close();

      const firstKey="finalization-reclaim:first";
      const first=fixture.ledger.claimHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-a",
        rawToken:"finalizer-a-token",idempotencyKey:firstKey,nowMs:fixture.nowMs+1});
      expect(first).toMatchObject({status:"CLAIMED",claimOwnerId:"finalizer-a",claimGeneration:1,
        claimExpiresAtMs:fixture.nowMs+30_001});
      expect(fixture.ledger.claimHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-a",
        rawToken:"finalizer-a-token",idempotencyKey:firstKey,nowMs:fixture.nowMs+2})).toEqual(first);
      const sameOwnerReclaimed=fixture.ledger.claimHardeningPaidCallFinalization({finalizationId:finalization.id,
        ownerId:"finalizer-a",rawToken:"finalizer-a-token",idempotencyKey:firstKey,nowMs:fixture.nowMs+30_001});
      expect(sameOwnerReclaimed).toMatchObject({status:"CLAIMED",claimOwnerId:"finalizer-a",claimGeneration:2,
        claimExpiresAtMs:fixture.nowMs+60_001});
      expect(()=>fixture.ledger.claimHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-b",
        rawToken:"finalizer-b-token",idempotencyKey:"finalization-reclaim:second",nowMs:fixture.nowMs+60_000})).toThrow();
      const reclaimed=fixture.ledger.claimHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-b",
        rawToken:"finalizer-b-token",idempotencyKey:"finalization-reclaim:second",nowMs:fixture.nowMs+60_001});
      expect(reclaimed).toMatchObject({status:"CLAIMED",claimOwnerId:"finalizer-b",claimGeneration:3,
        claimExpiresAtMs:fixture.nowMs+90_001});
      expect(()=>fixture.ledger.applyHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-a",
        rawToken:"finalizer-a-token",idempotencyKey:firstKey,nowMs:fixture.nowMs+60_002})).toThrow();
      expect(fixture.ledger.applyHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-b",
        rawToken:"finalizer-b-token",idempotencyKey:"finalization-reclaim:second",nowMs:fixture.nowMs+60_002}))
        .toMatchObject({status:"APPLIED",claimOwnerId:"finalizer-b",claimGeneration:3});

      const tamper=new Database(fixture.value.dbPath);
      tamper.exec("DROP TRIGGER fence_hardening_paid_call_finalization_update_v29");
      tamper.query("UPDATE hardening_paid_call_finalizations SET payload_json='{}' WHERE id=?").run(finalization.id);
      tamper.close();
      expect(()=>fixture.ledger.claimHardeningPaidCallFinalization({finalizationId:finalization.id,ownerId:"finalizer-b",
        rawToken:"finalizer-b-token",idempotencyKey:"finalization-reclaim:second",nowMs:fixture.nowMs+60_003})).toThrow();
    }finally{
      fixture.ledger.close();fixture.supervisor.close();fixture.value.supervisor.close();fixture.recoveryLeaseManager.close();
      rmSync(fixture.value.root,{recursive:true,force:true});
    }
  });

  test("H a corrupt durable Builder successor after state advancement fails closed instead of stranding the run", async () => {
    const tag="corrupt-builder-successor";
    const fixture=await pendingSettledHardeningBuilderFixture(tag);
    try{
      const store=new LocalArtifactStore({root:join(fixture.value.root,"artifacts"),now:()=>new Date(timestamp),
        idFactory:()=>`terminal-${tag}-builder-result`});
      const corruptArtifact=fixture.ledger.recordArtifact(store.put({runId:fixture.child.runId,type:"BUILDER_RESULT",
        bytes:canonicalJson({corrupt:true}),producerType:"SYSTEM",producerId:"codex-builder-adapter",trusted:false,
        createdAt:timestamp}));
      fixture.ledger.recordAgentExecution({agentExecutionId:fixture.agentExecutionId,runId:fixture.child.runId,role:"BUILDER",
        modelTier:"GPT-5.6_TERRA",status:"SUCCEEDED",inputHash:sha256(`terminal-${tag}-input`),
        outputArtifactId:corruptArtifact.artifactId,startedAt:timestamp,completedAt:timestamp});
      const implementing=fixture.supervisor.getRun(fixture.child.runId);
      const advanced=fixture.supervisor.transition({runId:implementing.runId,expectedStateVersion:implementing.stateVersion,
        nextState:"FAST_CHECKS",reasonCode:"BUILDER_IMPLEMENTATION_FINISHED",actorType:"SUPERVISOR",
        actorId:"engineer-supervisor",evidenceIds:[corruptArtifact.artifactId],manifestHash:implementing.manifestHash,
        idempotencyKey:"corrupt-builder-successor:fast-checks"}).run;
      expect(advanced.state).toBe("FAST_CHECKS");
      expect(fixture.ledger.hasExactHardeningBuilderSuccessor({childRunId:advanced.runId,
        reservationId:fixture.reservation.reservation.reservationId,agentExecutionId:fixture.agentExecutionId,
        expectedRunState:fixture.reservation.reservation.expectedRunState,
        expectedStateVersion:fixture.reservation.reservation.expectedStateVersion})).toBe(false);

      const lease=acquireFixtureRecoveryLease(fixture,"corrupt-successor-recovery","corrupt-successor-recovery:lease");
      try{
        expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:advanced.runId,
          ownerId:"corrupt-successor-recovery",rawToken:"corrupt-successor-recovery-token",nowMs:fixture.nowMs+1,
          recoveryWorkerLease:fixtureRecoveryProof(lease)})).toEqual({
            recoveredReservations:0,appliedFinalizations:1,terminalizedPreReservationAgent:false,
          });
      }finally{releaseFixtureRecoveryLease(fixture,lease,"corrupt-successor-recovery:release");}
      const after=new Database(fixture.value.dbPath,{readonly:true});
      expect(after.query("SELECT state FROM engineer_runs WHERE id=?").get(advanced.runId)).toEqual({state:"FAILED"});
      expect(after.query("SELECT status FROM hardening_paid_call_finalizations WHERE child_run_id=?")
        .get(advanced.runId)).toEqual({status:"APPLIED"});
      expect(after.query("SELECT status,stop_reason FROM hardening_child_budget_authorities WHERE child_run_id=?")
        .get(advanced.runId)).toEqual({status:"STOPPED",stop_reason:"FAILED"});
      after.close();
    }finally{
      fixture.ledger.close();fixture.supervisor.close();fixture.value.supervisor.close();fixture.recoveryLeaseManager.close();
      rmSync(fixture.value.root,{recursive:true,force:true});
    }
  });

  test("G every terminal family preserves one canonical stop reason while corrupt-successor recovery applies exactly once", async () => {
    const cases=[
      {state:"TIMED_OUT",budgetReason:"FAILED",advisoryReason:"TIMED_OUT"},
      {state:"RETRY_BUDGET_EXHAUSTED",budgetReason:"FAILED",advisoryReason:"BUDGET_EXHAUSTED"},
      {state:"SECURITY_ESCALATION",budgetReason:"SECURITY_BLOCKED",advisoryReason:"SECURITY_BLOCKED"},
      {state:"BLOCKED_BY_ENVIRONMENT",budgetReason:"ENVIRONMENT_BLOCKED",advisoryReason:"ENVIRONMENT_BLOCKED"},
      {state:"BLOCKED_BY_EXTERNAL_DEPENDENCY",budgetReason:"ENVIRONMENT_BLOCKED",advisoryReason:"ENVIRONMENT_BLOCKED"},
      {state:"FAILED",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"REJECTED",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"VERIFICATION_INCOMPLETE",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"ROLLED_BACK",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"CANCELLED",budgetReason:"CANCELLED",advisoryReason:"CANCELLED"},
    ] as const;
    for(const entry of cases){
      const fixture=await pendingSettledHardeningBuilderFixture(`terminal-family-${entry.state.toLowerCase()}`);
      try{
        const forceTerminal=new Database(fixture.value.dbPath);
        forceTerminal.query("UPDATE engineer_runs SET state=?,state_version=state_version+1 WHERE id=?")
          .run(entry.state,fixture.child.runId);
        forceTerminal.close();
        const lease=acquireFixtureRecoveryLease(fixture,`terminal-${entry.state.toLowerCase()}`,
          `terminal-${entry.state.toLowerCase()}:lease`);
        try{
          expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:fixture.child.runId,
            ownerId:lease.lease.ownerId,rawToken:`terminal-${entry.state.toLowerCase()}-token`,nowMs:fixture.nowMs+1,
            recoveryWorkerLease:fixtureRecoveryProof(lease)})).toEqual({
              recoveredReservations:0,appliedFinalizations:1,terminalizedPreReservationAgent:false,
            });
        }finally{releaseFixtureRecoveryLease(fixture,lease,`terminal-${entry.state.toLowerCase()}:release`);}
        const after=new Database(fixture.value.dbPath,{readonly:true});
        expect(after.query("SELECT state FROM engineer_runs WHERE id=?").get(fixture.child.runId)).toEqual({state:entry.state});
        expect(after.query("SELECT status FROM hardening_paid_call_finalizations WHERE child_run_id=?")
          .get(fixture.child.runId)).toEqual({status:"APPLIED"});
        expect(after.query("SELECT status,stop_reason FROM hardening_child_budget_authorities WHERE child_run_id=?")
          .get(fixture.child.runId)).toEqual({status:"STOPPED",stop_reason:entry.budgetReason});
        expect(after.query(`SELECT DISTINCT stop_reason FROM advisory_backlog_events
          WHERE child_run_id=? AND event_type='HARDENING_STOPPED'`).all(fixture.child.runId))
          .toEqual([{stop_reason:entry.advisoryReason}]);
        after.close();
      }finally{
        fixture.ledger.close();fixture.supervisor.close();fixture.value.supervisor.close();fixture.recoveryLeaseManager.close();
        rmSync(fixture.value.root,{recursive:true,force:true});
      }
    }
  });

  test("G pre-reservation recovery preserves every terminal family's canonical stop reason", async () => {
    const cases=[
      {state:"TIMED_OUT",budgetReason:"FAILED",advisoryReason:"TIMED_OUT"},
      {state:"RETRY_BUDGET_EXHAUSTED",budgetReason:"FAILED",advisoryReason:"BUDGET_EXHAUSTED"},
      {state:"SECURITY_ESCALATION",budgetReason:"SECURITY_BLOCKED",advisoryReason:"SECURITY_BLOCKED"},
      {state:"BLOCKED_BY_ENVIRONMENT",budgetReason:"ENVIRONMENT_BLOCKED",advisoryReason:"ENVIRONMENT_BLOCKED"},
      {state:"BLOCKED_BY_EXTERNAL_DEPENDENCY",budgetReason:"ENVIRONMENT_BLOCKED",advisoryReason:"ENVIRONMENT_BLOCKED"},
      {state:"FAILED",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"REJECTED",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"VERIFICATION_INCOMPLETE",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"ROLLED_BACK",budgetReason:"FAILED",advisoryReason:"FAILED"},
      {state:"CANCELLED",budgetReason:"CANCELLED",advisoryReason:"CANCELLED"},
    ] as const;
    for(const entry of cases){
      const fixture=await preReservationHardeningBuilderFixture(`terminal-family-${entry.state.toLowerCase()}`);
      try{
        expect(fixture.supervisor.hasOutstandingHardeningPaidCallRecoveryWork(fixture.child.runId)).toBe(true);
        const forceTerminal=new Database(fixture.value.dbPath);
        forceTerminal.query("UPDATE engineer_runs SET state=?,state_version=state_version+1 WHERE id=?")
          .run(entry.state,fixture.child.runId);
        forceTerminal.close();
        const lease=acquireFixtureRecoveryLease(fixture,`pre-reservation-${entry.state.toLowerCase()}`,
          `pre-reservation-${entry.state.toLowerCase()}:lease`);
        try{
          expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:fixture.child.runId,
            ownerId:lease.lease.ownerId,rawToken:`pre-reservation-${entry.state.toLowerCase()}-token`,
            nowMs:fixture.nowMs+1,recoveryWorkerLease:fixtureRecoveryProof(lease)})).toEqual({
              recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:true,
            });
        }finally{releaseFixtureRecoveryLease(fixture,lease,`pre-reservation-${entry.state.toLowerCase()}:release`);}
        const after=new Database(fixture.value.dbPath,{readonly:true});
        expect(after.query("SELECT state FROM engineer_runs WHERE id=?").get(fixture.child.runId)).toEqual({state:entry.state});
        expect(after.query("SELECT status FROM agent_executions WHERE id=?").get(fixture.agentExecutionId))
          .toEqual({status:"FAILED"});
        expect(after.query("SELECT COUNT(*) AS count FROM hardening_child_model_reservations WHERE child_run_id=?")
          .get(fixture.child.runId)).toEqual({count:0});
        expect(after.query("SELECT status,stop_reason FROM hardening_child_budget_authorities WHERE child_run_id=?")
          .get(fixture.child.runId)).toEqual({status:"STOPPED",stop_reason:entry.budgetReason});
        expect(after.query(`SELECT DISTINCT stop_reason FROM advisory_backlog_events
          WHERE child_run_id=? AND event_type='HARDENING_STOPPED'`).all(fixture.child.runId))
          .toEqual([{stop_reason:entry.advisoryReason}]);
        after.close();
      }finally{
        fixture.ledger.close();fixture.supervisor.close();fixture.value.supervisor.close();fixture.recoveryLeaseManager.close();
        rmSync(fixture.value.root,{recursive:true,force:true});
      }
    }
  });

  test("J mixed durable Builder successor plus open Reviewer converges with one ambiguity and no false Builder failure", async () => {
    const tag="mixed-builder-reviewer";
    const fixture=await pendingSettledHardeningBuilderFixture(tag);
    try{
      const builderCompletedAt=timestamp;
      const store=new LocalArtifactStore({root:join(fixture.value.root,"artifacts"),now:()=>new Date(builderCompletedAt),
        idFactory:()=>`terminal-${tag}-builder-result`});
      const builderArtifact=fixture.ledger.recordArtifact(store.put({runId:fixture.child.runId,type:"BUILDER_RESULT",
        bytes:canonicalJson({runId:fixture.child.runId,manifestHash:fixture.child.manifestHash,model:"gpt-5.6-terra",
          responseIds:[`terminal-${tag}-response`],changedFiles:[],diff:"",diffHash:sha256(""),requestedCommands:[],
          commandExecutionIds:[],implementationSummary:"durable Builder successor",unresolvedLimitations:[],completedAt:builderCompletedAt}),
        producerType:"SYSTEM",producerId:"codex-builder-adapter",trusted:false,createdAt:builderCompletedAt}));
      fixture.ledger.recordAgentExecution({agentExecutionId:fixture.agentExecutionId,runId:fixture.child.runId,role:"BUILDER",
        modelTier:"GPT-5.6_TERRA",status:"SUCCEEDED",inputHash:sha256(`terminal-${tag}-input`),
        outputArtifactId:builderArtifact.artifactId,startedAt:timestamp,completedAt:builderCompletedAt});
      let run=fixture.supervisor.getRun(fixture.child.runId);
      run=fixture.supervisor.transition({runId:run.runId,expectedStateVersion:run.stateVersion,nextState:"FAST_CHECKS",
        reasonCode:"BUILDER_IMPLEMENTATION_FINISHED",actorType:"SUPERVISOR",actorId:"engineer-supervisor",
        evidenceIds:[builderArtifact.artifactId],manifestHash:run.manifestHash,idempotencyKey:"mixed:fast-checks"}).run;
      for(const nextState of ["UNIT_TESTING","INTEGRATION_TESTING","SECURITY_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"] as const){
        run=fixture.supervisor.transition({runId:run.runId,expectedStateVersion:run.stateVersion,nextState,
          reasonCode:`MIXED_${nextState}`,manifestHash:run.manifestHash,idempotencyKey:`mixed:${nextState}`}).run;
      }
      expect(fixture.ledger.hasExactHardeningBuilderSuccessor({childRunId:run.runId,
        reservationId:fixture.reservation.reservation.reservationId,agentExecutionId:fixture.agentExecutionId,
        expectedRunState:fixture.reservation.reservation.expectedRunState,
        expectedStateVersion:fixture.reservation.reservation.expectedStateVersion})).toBe(true);

      const reviewerAgentId="mixed-reviewer-agent",reviewerRouteId="mixed-reviewer-route";
      fixture.ledger.recordAgentExecution({agentExecutionId:reviewerAgentId,runId:run.runId,role:"REVIEWER",modelTier:"GPT-5.6_SOL",
        status:"RUNNING",inputHash:sha256("mixed-reviewer-input"),outputArtifactId:null,startedAt:timestamp,completedAt:null});
      fixture.ledger.recordModelRouting({routingDecisionId:reviewerRouteId,runId:run.runId,agentExecutionId:reviewerAgentId,
        agentRole:"REVIEWER",logicalTier:"GPT-5.6_SOL",resolvedModel:"gpt-5.6-sol",routingPolicyVersion:"engineer-model-routing-v2",
        fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp});
      const reviewerFence=fixture.ledger.acquireHardeningExecutionFence({childRunId:run.runId,ownerId:"mixed-reviewer-worker",
        ttlMs:10_000,nowMs:fixture.nowMs,idempotencyKey:"mixed-reviewer-fence"});
      const reviewerPrefix=reviewerStaticRequestPrefix("gpt-5.6-sol");
      const reviewerReservation=fixture.ledger.reserveHardeningPaidCall({childRunId:run.runId,role:"REVIEWER",
        modelTier:"GPT-5.6_SOL",resolvedModel:"gpt-5.6-sol",routingDecisionId:reviewerRouteId,agentExecutionId:reviewerAgentId,
        inputTokenUpperBound:100,outputTokenCeiling:12_000,reservationIdempotencyKey:"mixed-reviewer-reservation",
        requestHash:sha256("mixed-reviewer-request"),cacheDescriptor:createHardeningPromptCacheMaterial({
          secret:hardeningPromptCacheSecret,requesterUserId:fixture.value.run.userId,childRunId:run.runId,role:"REVIEWER",
          resolvedModel:"gpt-5.6-sol",promptOrReviewerPolicyVersion:REVIEWER_POLICY_VERSION,
          staticPrefix:reviewerPrefix,toolSchema:reviewerPrefix.tools}).descriptor,fenceOwnerId:reviewerFence.ownerId,
        fenceGeneration:reviewerFence.fenceGeneration,rawFenceToken:reviewerFence.rawFenceToken,nowMs:fixture.nowMs});
      fixture.ledger.markHardeningPaidCallDispatching({childRunId:run.runId,
        reservationId:reviewerReservation.reservation.reservationId,requestHash:reviewerReservation.reservation.requestHash,
        clientRequestId:reviewerReservation.reservation.clientRequestId,fenceOwnerId:reviewerFence.ownerId,
        fenceGeneration:reviewerFence.fenceGeneration,rawFenceToken:reviewerFence.rawFenceToken,nowMs:fixture.nowMs});
      fixture.ledger.releaseHardeningExecutionFence({childRunId:run.runId,ownerId:reviewerFence.ownerId,
        fenceGeneration:reviewerFence.fenceGeneration,rawFenceToken:reviewerFence.rawFenceToken,nowMs:fixture.nowMs});

      const mixedLease=acquireFixtureRecoveryLease(fixture,"mixed-recovery","mixed-recovery:lease");
      try{
        expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:run.runId,ownerId:"mixed-recovery",
          rawToken:"mixed-recovery-token",nowMs:fixture.nowMs+1,
          recoveryWorkerLease:fixtureRecoveryProof(mixedLease)})).toEqual({
            recoveredReservations:1,appliedFinalizations:2,terminalizedPreReservationAgent:false,
          });
      }finally{releaseFixtureRecoveryLease(fixture,mixedLease,"mixed-recovery:release");}
      const after=new Database(fixture.value.dbPath,{readonly:true});
      expect(after.query("SELECT state FROM engineer_runs WHERE id=?").get(run.runId)).toEqual({state:"FAILED"});
      expect(after.query("SELECT role,status FROM agent_executions WHERE id IN (?,?) ORDER BY role")
        .all(fixture.agentExecutionId,reviewerAgentId)).toEqual([{role:"BUILDER",status:"SUCCEEDED"},{role:"REVIEWER",status:"FAILED"}]);
      expect(after.query("SELECT role,status,outcome FROM hardening_paid_call_finalizations WHERE child_run_id=? ORDER BY role")
        .all(run.runId)).toEqual([{role:"BUILDER",status:"APPLIED",outcome:"SETTLED"},
          {role:"REVIEWER",status:"APPLIED",outcome:"AMBIGUOUS"}]);
      expect(after.query("SELECT status,stop_reason,reserved_cost_microusd,reserved_tokens,ambiguous_cost_microusd,ambiguous_tokens FROM hardening_child_budget_authorities WHERE child_run_id=?")
        .get(run.runId)).toEqual({status:"STOPPED",stop_reason:"MODEL_USAGE_AMBIGUOUS",reserved_cost_microusd:0,reserved_tokens:0,
          ambiguous_cost_microusd:reviewerReservation.reservation.reservedCostMicrousd,
          ambiguous_tokens:reviewerReservation.reservation.reservedTokens});
      expect(after.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_STOPPED'")
        .get(run.runId)).toEqual({count:fixture.value.advisories.length});
      after.close();
      const mixedReplayLease=acquireFixtureRecoveryLease(fixture,"mixed-recovery-replay","mixed-recovery-replay:lease");
      try{
        expect(fixture.supervisor.recoverHardeningPaidCallLifecycle({childRunId:run.runId,ownerId:"mixed-recovery-replay",
          rawToken:"mixed-recovery-replay-token",nowMs:fixture.nowMs+2,
          recoveryWorkerLease:fixtureRecoveryProof(mixedReplayLease)})).toEqual({
            recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:false,
          });
      }finally{releaseFixtureRecoveryLease(fixture,mixedReplayLease,"mixed-recovery-replay:release");}
    }finally{
      fixture.ledger.close();fixture.supervisor.close();fixture.value.supervisor.close();fixture.recoveryLeaseManager.close();
      rmSync(fixture.value.root,{recursive:true,force:true});
    }
  });

  test("v28 start plus v29 budget authority fence reservation and settlement remain exact across workers", async () => {
    const value=await hardeningConsentFixture("run-hardening-v28-fence");
    const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
      {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
    const request={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,
      lineageHash:creation.lineage.lineageHash,idempotencyKey:"v28-start"};
    const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,request);
    let clock=Date.parse(timestamp);const first=new EngineerLedger(value.dbPath,()=>new Date(clock),hardeningPromptCacheSecret);
    const second=new EngineerLedger(value.dbPath,()=>new Date(clock),hardeningPromptCacheSecret);
    const claimInput={requesterUserId:value.run.userId,rootRunId:prepared.lineage.rootRunId,parentRunId:value.run.runId,
      childRunId:creation.child.childRunId,repositoryId:prepared.lineage.repositoryId,parentCheckpointId:prepared.parentCheckpoint.checkpointId,
      parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,lineageId:prepared.lineage.lineageId,lineageHash:prepared.lineage.lineageHash,
      quoteId:prepared.lineage.quoteId,quoteHash:prepared.lineage.quoteHash,consentId:prepared.lineage.consentId,
      consentHash:prepared.lineage.consentHash,operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,
      idempotencyKey:request.idempotencyKey,ownerId:"worker-a",leaseMs:1_000};
    const original=first.claimOptionalHardeningStart(claimInput);expect(original).toMatchObject({applied:true,stolen:false,fence:{status:"PREPARING",generation:1}});
    const restarted=new EngineerLedger(value.dbPath,()=>new Date(clock));expect(restarted.listOptionalHardeningStartClaimsForRecovery(value.run.userId))
      .toEqual([expect.objectContaining({childRunId:creation.child.childRunId,leaseExpiresAt:original.fence.leaseExpiresAt})]);restarted.close();
    const beforeSeed=new Database(value.dbPath);expect(beforeSeed.query("SELECT status FROM hardening_start_claims WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({status:"PREPARING"});
    expect(beforeSeed.query("SELECT COUNT(*) AS count FROM hardening_seed_attestations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});beforeSeed.close();
    expect(first.listExpiredOptionalHardeningStartClaimsForOwner(value.run.userId)).toEqual([]);
    expect(()=>second.claimOptionalHardeningStart({...claimInput,ownerId:"worker-b"})).toThrow("live fenced worker");
    clock+=1_001;expect(first.listExpiredOptionalHardeningStartClaimsForOwner(value.run.userId)).toEqual([{
      parentRunId:value.run.runId,childRunId:creation.child.childRunId,input:request,
    }]);
    const stolen=second.claimOptionalHardeningStart({...claimInput,ownerId:"worker-b"});
    expect(stolen).toMatchObject({applied:true,stolen:true,fence:{status:"PREPARING",generation:2}});
    const signedSeed=await createSignedHardeningSeedAttestation({schemaVersion:1,policyVersion:"engineer-hardening-seed-attestation-v1",
      attestationType:"HARDENING_SEED_VERIFIED",operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,
      rootRunId:prepared.lineage.rootRunId,parentRunId:value.run.runId,childRunId:creation.child.childRunId,requesterUserId:value.run.userId,
      repositoryId:prepared.lineage.repositoryId,lineageId:prepared.lineage.lineageId,lineageHash:prepared.lineage.lineageHash,
      parentCheckpointId:prepared.parentCheckpoint.checkpointId,parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,
      baseCommitSha:prepared.seed.baseCommitSha,seedResultCommitSha:prepared.seed.seedResultCommitSha,seedTreeHash:sha256("v28-seed-tree"),
      seedDiffHash:prepared.seed.diffHash,imageDigest:sha256("v28-image"),environmentDigest:prepared.seed.environmentDigest,
      dependencyHash:sha256("v28-dependencies"),createdAt:prepared.operation.createdAt},checkpointAttestor);
    const preview=value.supervisor.previewOptionalHardeningStart({...prepared,signedSeed});if(preview.status!=="READY")throw new Error("missing v28 manifest");
    const sandbox={sandboxId:"v28-sandbox",runId:creation.child.childRunId,workspaceIdentity:"v28-workspace",imageReference:"oven/bun:test",
      imageDigest:signedSeed.attestation.imageDigest,environmentDigest:signedSeed.attestation.environmentDigest,networkPolicyVersion:"offline-v1",
      sandboxPolicyVersion:"test-v1",status:"READY" as const,source:"COLD" as const,createdAt:prepared.operation.createdAt,destroyedAt:null};
    const store=new LocalArtifactStore({root:join(value.root,"artifacts"),now:()=>new Date(timestamp),idFactory:()=>"v28-checkpoint"});
    const checkpoint=store.put({runId:creation.child.childRunId,type:"SANDBOX_WORKSPACE_CHECKPOINT",bytes:canonicalJson({manifestHash:preview.manifest.manifestHash,sandbox}),
      producerType:"SYSTEM",producerId:"engineer-execution-manager",trusted:true});
    let atomicId=0;const atomicSupervisor=createEngineerSupervisor({dbPath:value.dbPath,idFactory:()=>`v28-atomic-${++atomicId}`,now:()=>new Date(timestamp),checkpointAttestor});
    atomicSupervisor.configureArtifactReadAuthority(value.artifactStore);
    await expect(atomicSupervisor.commitOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,request,
      prepared.operation,signedSeed,{claimId:original.fence.claimId,fenceToken:original.fence.fenceToken,generation:original.fence.generation},{sandbox,checkpoint})).rejects.toThrow("stale");
    const afterStale=new Database(value.dbPath);
    expect(afterStale.query("SELECT COUNT(*) AS count FROM hardening_start_operations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(afterStale.query("SELECT COUNT(*) AS count FROM hardening_seed_attestations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(afterStale.query("SELECT COUNT(*) AS count FROM sandboxes WHERE run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(afterStale.query("SELECT COUNT(*) AS count FROM artifacts WHERE run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(afterStale.query("SELECT COUNT(*) AS count FROM task_manifest_versions WHERE run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(afterStale.query("SELECT COUNT(*) AS count FROM run_state_events WHERE run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(afterStale.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});afterStale.close();
    await atomicSupervisor.commitOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,request,prepared.operation,signedSeed,
      {claimId:stolen.fence.claimId,fenceToken:stolen.fence.fenceToken,generation:stolen.fence.generation},{sandbox,checkpoint});
    const finalized=second.claimOptionalHardeningStart({...claimInput,ownerId:"worker-b"}).fence;expect(finalized.status).toBe("FINALIZED");
    let childRun=atomicSupervisor.getRun(creation.child.childRunId);
    for(const nextState of ["QUEUED","SANDBOX_READY","IMPLEMENTING"] as const){
      childRun=atomicSupervisor.transition({runId:childRun.runId,expectedStateVersion:childRun.stateVersion,nextState,
        reasonCode:`V29_TEST_${nextState}`,idempotencyKey:`v29-test:${nextState}:${childRun.stateVersion}`}).run;
    }
    expect(first.getHardeningChildBudgetAuthority(creation.child.childRunId)).toMatchObject({childRunId:creation.child.childRunId,
      costLimitMicrousd:value.consent.authorizedBudget.costMicrousd,tokenLimit:value.consent.authorizedBudget.tokens,
      activeTimeLimitMs:value.consent.authorizedBudget.timeSeconds*1000,paidGraph:{plannerCalls:0,builderCalls:1,reviewerCalls:1,automaticRepairCalls:0}});
    const builderAgent={agentExecutionId:"v29-builder",runId:creation.child.childRunId,role:"BUILDER" as const,
      modelTier:"GPT-5.6_TERRA" as const,status:"RUNNING" as const,inputHash:sha256("v29-builder"),outputArtifactId:null,
      startedAt:new Date(clock).toISOString(),completedAt:null};
    expect(first.claimBuilderDispatch(builderAgent).won).toBe(true);
    first.recordModelRouting({routingDecisionId:"v29-builder-route",runId:creation.child.childRunId,agentExecutionId:builderAgent.agentExecutionId,
      agentRole:"BUILDER",logicalTier:"GPT-5.6_TERRA",resolvedModel:"gpt-5.6-terra",routingPolicyVersion:"engineer-model-routing-v2",
      fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp:new Date(clock).toISOString()});
    const builderFence=first.acquireHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:"v29-worker-a",ttlMs:10_000,
      nowMs:clock,idempotencyKey:"v29-builder-fence"});
    expect(()=>second.acquireHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:"v29-worker-b",ttlMs:10_000,
      nowMs:clock,idempotencyKey:"v29-live-fence-race"})).toThrow("stale or expired");
    const builderReservationInput={childRunId:creation.child.childRunId,role:"BUILDER" as const,modelTier:"GPT-5.6_TERRA" as const,
      resolvedModel:"gpt-5.6-terra",routingDecisionId:"v29-builder-route",agentExecutionId:builderAgent.agentExecutionId,
      inputTokenUpperBound:first.getHardeningChildBudgetAuthority(creation.child.childRunId)!.transportLimits.builderInputCap,
      outputTokenCeiling:6_000,reservationIdempotencyKey:"v29-builder-reservation",requestHash:sha256("v29-builder-request"),
      cacheDescriptor:createHardeningPromptCacheMaterial({secret:hardeningPromptCacheSecret,requesterUserId:value.run.userId,
        childRunId:creation.child.childRunId,role:"BUILDER",resolvedModel:"gpt-5.6-terra",promptOrReviewerPolicyVersion:"engineer-codex-builder-v3",
        staticPrefix:builderStaticRequestPrefix("gpt-5.6-terra"),toolSchema:builderStaticRequestPrefix("gpt-5.6-terra").tools}).descriptor,
      fenceOwnerId:builderFence.ownerId,fenceGeneration:builderFence.fenceGeneration,rawFenceToken:builderFence.rawFenceToken,nowMs:clock};
    const builderReservation=first.reserveHardeningPaidCall(builderReservationInput);expect(builderReservation.applied).toBe(true);
    expect(first.reserveHardeningPaidCall(builderReservationInput)).toEqual({...builderReservation,applied:false});
    clock+=1;
    expect(first.reserveHardeningPaidCall({...builderReservationInput,nowMs:clock})).toEqual({...builderReservation,applied:false});
    expect(()=>first.reserveHardeningPaidCall({...builderReservationInput,nowMs:clock,
      cacheDescriptor:{...builderReservationInput.cacheDescriptor,promptCacheKeyHash:sha256("changed-cache-key")}})).toThrow("prompt-cache");
    const liabilityDb=new Database(value.dbPath);
    for(const forgedCost of [0,builderReservation.reservation.reservedCostMicrousd-1,builderReservation.reservation.reservedCostMicrousd+1]){
      expect(()=>liabilityDb.query("UPDATE hardening_child_model_reservations SET reserved_cost_microusd=? WHERE id=?")
        .run(forgedCost,builderReservation.reservation.reservationId)).toThrow("immutable liability");
    }
    liabilityDb.close();
    const malformedDb=new Database(value.dbPath);
    const assertMalformedVoidRejected=(reconciliationJson:string,reconciliationId:string,reconciliationHash:string)=>{
      malformedDb.exec("BEGIN IMMEDIATE");
      try{
        malformedDb.query("UPDATE hardening_model_call_slots SET status='FAILED',updated_at=? WHERE id=?")
          .run(new Date(clock).toISOString(),builderReservation.reservation.paidCallSlotId);
        expect(()=>malformedDb.query(`UPDATE hardening_child_model_reservations SET status='VOID_UNSENT',
          settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,settled_at_ms=?
          WHERE id=? AND status='RESERVED'`).run("malformed-void",sha256("malformed-void"),reconciliationId,
            reconciliationHash,reconciliationJson,clock,builderReservation.reservation.reservationId))
          .toThrow(/transition mismatch|reconciliation .*projection mismatch/);
      }finally{malformedDb.exec("ROLLBACK");}
    };
    assertMalformedVoidRejected("{}",sha256("missing-key-reconciliation-id"),sha256("missing-key-reconciliation-hash"));
    const validVoid=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
      childRunId:creation.child.childRunId,reservationId:builderReservation.reservation.reservationId,
      reservationHash:builderReservation.reservation.reservationHash,status:"VOID_UNSENT",providerResponseId:null,modelCallId:null,
      actualInputTokens:null,actualOutputTokens:null,actualCachedInputTokens:null,actualCacheWriteInputTokens:null,
      cacheObservation:"UNKNOWN",actualCostMicrousd:null,createdAt:new Date(clock).toISOString()});
    const wrongNull=JSON.parse(canonicalJson(validVoid)) as Record<string,unknown>;wrongNull.providerResponseId="forged-provider-response";
    assertMalformedVoidRejected(canonicalJson(wrongNull),validVoid.reconciliationId,validVoid.reconciliationHash);
    malformedDb.close();
    expect(()=>second.assertHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:builderFence.ownerId,
      fenceGeneration:builderFence.fenceGeneration,rawFenceToken:"wrong-token",nowMs:clock})).toThrow("stale or expired");
    const providerStore=new LocalArtifactStore({root:join(value.root,"artifacts"),now:()=>new Date(clock),idFactory:()=>"v29-provider-response"});
    first.configureHardeningArtifactReader((artifact)=>providerStore.readVerifiedExact(artifact));
    second.configureHardeningArtifactReader((artifact)=>providerStore.readVerifiedExact(artifact));
    const providerResponse={id:"v29-builder-response",usage:{input_tokens:3,output_tokens:2,
      input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}};
    const providerArtifact=first.recordArtifact(providerStore.put({runId:creation.child.childRunId,type:"MODEL_PROVIDER_RESPONSE",
      bytes:JSON.stringify(providerResponse),producerType:"SYSTEM",producerId:"engineer-provider-response-recorder",trusted:true}));
    first.markHardeningPaidCallDispatching({childRunId:creation.child.childRunId,
      reservationId:builderReservation.reservation.reservationId,requestHash:builderReservation.reservation.requestHash,
      clientRequestId:builderReservation.reservation.clientRequestId,fenceOwnerId:builderFence.ownerId,
      fenceGeneration:builderFence.fenceGeneration,rawFenceToken:builderFence.rawFenceToken,nowMs:clock});
    const builderCall={modelCallId:"v29-builder-call",runId:creation.child.childRunId,agentExecutionId:builderAgent.agentExecutionId,
      logicalTier:"GPT-5.6_TERRA" as const,resolvedModel:"gpt-5.6-terra",promptTemplateVersion:"engineer-codex-builder-v3",
      inputContextRefs:[first.getRun(creation.child.childRunId).manifestHash!,sha256("v29-builder-provider-input"),
        builderReservation.reservation.requestHash,builderReservation.reservation.clientRequestId,providerResponse.id],
      outputSchemaVersion:null,cacheKey:builderReservation.reservation.promptCacheKeyHash,cacheHit:false,latencyMs:1,inputTokens:3,outputTokens:2,cachedInputTokens:0,
      cacheWriteInputTokens:0,retryCount:0,status:"SUCCEEDED" as const,createdAt:new Date(clock).toISOString()};
    first.recordHardeningPaidCallResponse({childRunId:creation.child.childRunId,
      reservationId:builderReservation.reservation.reservationId,requestHash:builderReservation.reservation.requestHash,
      clientRequestId:builderReservation.reservation.clientRequestId,modelCall:builderCall,providerResponseId:providerResponse.id,
      providerResponseArtifactId:providerArtifact.artifactId,fenceOwnerId:builderFence.ownerId,
      fenceGeneration:builderFence.fenceGeneration,rawFenceToken:builderFence.rawFenceToken,nowMs:clock});
    const builderSettlement={childRunId:creation.child.childRunId,reservationId:builderReservation.reservation.reservationId,modelCall:builderCall,
      providerResponseId:providerResponse.id,providerResponseArtifactId:providerArtifact.artifactId,settlementIdempotencyKey:"v29-builder-settlement",fenceOwnerId:builderFence.ownerId,
      fenceGeneration:builderFence.fenceGeneration,rawFenceToken:builderFence.rawFenceToken,nowMs:clock};
    expect(first.settleHardeningPaidCall(builderSettlement)).toEqual({status:"SETTLED",stopReason:null});
    expect(first.settleHardeningPaidCall(builderSettlement)).toEqual({status:"SETTLED",stopReason:null});
    expect(()=>first.settleHardeningPaidCall({...builderSettlement,modelCall:{...builderCall,outputTokens:3}})).toThrow("conflicts");
    const assertPersistedCallTamperRejected=(column:string,forged:string|number|null,restored:string|number|null)=>{
      const db=new Database(value.dbPath);db.query(`UPDATE model_calls SET ${column}=? WHERE id=?`).run(forged,builderCall.modelCallId);db.close();
      expect(()=>first.settleHardeningPaidCall(builderSettlement)).toThrow("authority");
      const restoreDb=new Database(value.dbPath);restoreDb.query(`UPDATE model_calls SET ${column}=? WHERE id=?`).run(restored,builderCall.modelCallId);restoreDb.close();
    };
    assertPersistedCallTamperRejected("prompt_template_version","forged-prompt-version",builderCall.promptTemplateVersion);
    assertPersistedCallTamperRejected("output_schema_version","forged-output-schema",builderCall.outputSchemaVersion);
    assertPersistedCallTamperRejected("status","FAILED",builderCall.status);
    assertPersistedCallTamperRejected("retry_count",1,builderCall.retryCount);
    assertPersistedCallTamperRejected("cache_hit",1,0);
    assertPersistedCallTamperRejected("input_context_refs_json",canonicalJson([sha256("forged-input-reference")]),canonicalJson(builderCall.inputContextRefs));
    assertPersistedCallTamperRejected("budget_reservation_id",null,builderReservation.reservation.reservationId);
    expect(first.settleHardeningPaidCall(builderSettlement)).toEqual({status:"SETTLED",stopReason:null});
    const settledDb=new Database(value.dbPath);
    expect(settledDb.query(`SELECT actual_input_tokens,actual_uncached_input_tokens,actual_cached_input_tokens,
      actual_cache_write_input_tokens,actual_output_tokens,cache_observation,settled_cost_microusd,
      reserved_cache_write_input_tokens,reserved_cached_input_tokens,reconciliation_id IS NOT NULL AS has_reconciliation
      FROM hardening_child_model_reservations WHERE id=?`).get(builderReservation.reservation.reservationId)).toEqual({
        actual_input_tokens:3,actual_uncached_input_tokens:3,actual_cached_input_tokens:0,actual_cache_write_input_tokens:0,
        actual_output_tokens:2,cache_observation:"MISS",settled_cost_microusd:38,
        reserved_cache_write_input_tokens:builderReservation.reservation.inputTokenUpperBound,reserved_cached_input_tokens:0,has_reconciliation:1,
      });
    settledDb.close();
    first.releaseHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:builderFence.ownerId,
      fenceGeneration:builderFence.fenceGeneration,rawFenceToken:builderFence.rawFenceToken,nowMs:clock});
    const replacement=second.acquireHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:"v29-worker-b",ttlMs:10_000,
      nowMs:clock,idempotencyKey:"v29-replacement-fence"});
    expect(replacement.fenceGeneration).toBe(builderFence.fenceGeneration+1);
    expect(()=>first.assertHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:builderFence.ownerId,
      fenceGeneration:builderFence.fenceGeneration,rawFenceToken:builderFence.rawFenceToken,nowMs:clock})).toThrow("stale or expired");
    for(const nextState of ["FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","SECURITY_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"] as const){
      childRun=atomicSupervisor.transition({runId:childRun.runId,expectedStateVersion:childRun.stateVersion,nextState,
        reasonCode:`V29_TEST_${nextState}`,idempotencyKey:`v29-test:${nextState}:${childRun.stateVersion}`}).run;
    }
    const reviewerAgent={agentExecutionId:"v29-reviewer",runId:creation.child.childRunId,role:"REVIEWER" as const,
      modelTier:"GPT-5.6_SOL" as const,status:"RUNNING" as const,inputHash:sha256("v29-reviewer"),outputArtifactId:null,
      startedAt:new Date(clock).toISOString(),completedAt:null};
    second.recordAgentExecution(reviewerAgent);
    second.recordModelRouting({routingDecisionId:"v29-reviewer-route",runId:creation.child.childRunId,agentExecutionId:reviewerAgent.agentExecutionId,
      agentRole:"REVIEWER",logicalTier:"GPT-5.6_SOL",resolvedModel:"gpt-5.6-sol",routingPolicyVersion:"engineer-model-routing-v2",
      fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp:new Date(clock).toISOString()});
    const reviewerReservation=second.reserveHardeningPaidCall({childRunId:creation.child.childRunId,role:"REVIEWER",modelTier:"GPT-5.6_SOL",
      resolvedModel:"gpt-5.6-sol",routingDecisionId:"v29-reviewer-route",agentExecutionId:reviewerAgent.agentExecutionId,inputTokenUpperBound:40_000,
      outputTokenCeiling:12_000,reservationIdempotencyKey:"v29-reviewer-reservation",requestHash:sha256("v29-reviewer-request"),
      cacheDescriptor:createHardeningPromptCacheMaterial({secret:hardeningPromptCacheSecret,requesterUserId:value.run.userId,
        childRunId:creation.child.childRunId,role:"REVIEWER",resolvedModel:"gpt-5.6-sol",promptOrReviewerPolicyVersion:"engineer-isolated-reviewer-v6",
        staticPrefix:reviewerStaticRequestPrefix("gpt-5.6-sol"),toolSchema:reviewerStaticRequestPrefix("gpt-5.6-sol").tools}).descriptor,fenceOwnerId:replacement.ownerId,
      fenceGeneration:replacement.fenceGeneration,rawFenceToken:replacement.rawFenceToken,nowMs:clock});
    const ambiguousCall={modelCallId:"v29-reviewer-call",runId:creation.child.childRunId,agentExecutionId:reviewerAgent.agentExecutionId,
      logicalTier:"GPT-5.6_SOL" as const,resolvedModel:"gpt-5.6-sol",promptTemplateVersion:"engineer-isolated-reviewer-v6",inputContextRefs:[sha256("v29-reviewer-input")],
      outputSchemaVersion:"reviewer-output-v1",cacheKey:reviewerReservation.reservation.promptCacheKeyHash,cacheHit:null,latencyMs:1,inputTokens:null,outputTokens:null,
      retryCount:0,status:"FAILED" as const,createdAt:new Date(clock).toISOString()};
    const ambiguousSettlement={childRunId:creation.child.childRunId,reservationId:reviewerReservation.reservation.reservationId,modelCall:ambiguousCall,
      providerResponseId:null,providerResponseArtifactId:null,settlementIdempotencyKey:"v29-reviewer-ambiguous",fenceOwnerId:replacement.ownerId,
      fenceGeneration:replacement.fenceGeneration,rawFenceToken:replacement.rawFenceToken,nowMs:clock};
    second.markHardeningPaidCallDispatching({childRunId:creation.child.childRunId,
      reservationId:reviewerReservation.reservation.reservationId,requestHash:reviewerReservation.reservation.requestHash,
      clientRequestId:reviewerReservation.reservation.clientRequestId,fenceOwnerId:replacement.ownerId,
      fenceGeneration:replacement.fenceGeneration,rawFenceToken:replacement.rawFenceToken,nowMs:clock});
    expect(second.settleHardeningPaidCall(ambiguousSettlement)).toEqual({status:"AMBIGUOUS",stopReason:"MODEL_USAGE_AMBIGUOUS"});
    expect(second.settleHardeningPaidCall(ambiguousSettlement)).toEqual({status:"AMBIGUOUS",stopReason:"MODEL_USAGE_AMBIGUOUS"});
    expect(()=>second.settleHardeningPaidCall({...ambiguousSettlement,modelCall:{...ambiguousCall,latencyMs:2}})).toThrow("conflicts");
    const budgetDb=new Database(value.dbPath);const budgetRow=budgetDb.query(`SELECT status,stop_reason,reserved_tokens,ambiguous_tokens
      FROM hardening_child_budget_authorities WHERE child_run_id=?`).get(creation.child.childRunId);budgetDb.close();
    expect(budgetRow).toEqual({status:"STOPPED",stop_reason:"MODEL_USAGE_AMBIGUOUS",reserved_tokens:0,
      ambiguous_tokens:reviewerReservation.reservation.reservedTokens});
    const exported=first.exportRunRecords(creation.child.childRunId);expect(exported.hardening_start_claims).toHaveLength(1);
    expect(exported.hardening_model_call_slots).toHaveLength(2);
    const tamperDb=new Database(value.dbPath);
    expect(()=>tamperDb.query("UPDATE hardening_child_model_reservations SET reconciliation_hash=? WHERE id=?")
      .run(sha256("forged-reconciliation"),builderReservation.reservation.reservationId)).toThrow("transition mismatch");
    tamperDb.exec("DROP TRIGGER fence_hardening_child_model_reservation_update_v29");
    tamperDb.query("UPDATE hardening_child_model_reservations SET reconciliation_hash=? WHERE id=?")
      .run(sha256("forged-reconciliation"),builderReservation.reservation.reservationId);tamperDb.close();
    expect(()=>first.settleHardeningPaidCall(builderSettlement)).toThrow("authority");
    atomicSupervisor.close();second.close();first.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("authenticates provider HIT WRITE MIXED and fails every response usage mismatch closed", async () => {
    const cases=[
      {tag:"hit",record:{input:100,cached:40,write:0,output:10},provider:{input:100,cached:40,write:0,output:10},status:"SETTLED",observation:"HIT"},
      {tag:"write",record:{input:100,cached:0,write:20,output:10},provider:{input:100,cached:0,write:20,output:10},status:"SETTLED",observation:"WRITE"},
      {tag:"mixed",record:{input:100,cached:40,write:20,output:10},provider:{input:100,cached:40,write:20,output:10},status:"SETTLED",observation:"MIXED"},
      {tag:"response-id",record:{input:100,cached:0,write:0,output:10},provider:{input:100,cached:0,write:0,output:10},status:"AMBIGUOUS",responseIdMismatch:true},
      {tag:"input",record:{input:100,cached:0,write:0,output:10},provider:{input:99,cached:0,write:0,output:10},status:"AMBIGUOUS"},
      {tag:"cached",record:{input:100,cached:20,write:0,output:10},provider:{input:100,cached:19,write:0,output:10},status:"AMBIGUOUS"},
      {tag:"write-mismatch",record:{input:100,cached:0,write:20,output:10},provider:{input:100,cached:0,write:19,output:10},status:"AMBIGUOUS"},
      {tag:"output",record:{input:100,cached:0,write:0,output:10},provider:{input:100,cached:0,write:0,output:11},status:"AMBIGUOUS"},
      {tag:"missing-details",record:{input:100,cached:0,write:0,output:10},provider:{input:100,cached:0,write:0,output:10},status:"AMBIGUOUS",missingDetails:true,recordAmbiguousResponse:true},
      {tag:"missing-details-reviewer-recovery",role:"REVIEWER",record:{input:100,cached:0,write:0,output:10},provider:{input:100,cached:0,write:0,output:10},status:"AMBIGUOUS",missingDetails:true,recoverAfterRecord:true},
      {tag:"missing-details-nonzero-record",record:{input:100,cached:1,write:0,output:10},provider:{input:100,cached:0,write:0,output:10},status:"AMBIGUOUS",missingDetails:true,preserveRecordDetails:true},
      {tag:"unsafe",record:null,provider:{input:Number.MAX_SAFE_INTEGER+1,cached:0,write:0,output:10},status:"AMBIGUOUS"},
    ] as const;
    for(const scenario of cases){
      const value=await hardeningConsentFixture(`run-hardening-provider-${scenario.tag}`);
      const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
        {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
      const startInput={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,lineageHash:creation.lineage.lineageHash,
        idempotencyKey:`provider-${scenario.tag}-start`};
      const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,startInput);
      const signedSeed=await signedHardeningSeedFixture(prepared,`provider-${scenario.tag}`);
      await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,startInput,prepared,signedSeed);
      const role=("role" in scenario?scenario.role:"BUILDER") as "BUILDER"|"REVIEWER";
      const reviewer=role==="REVIEWER",modelTier=reviewer?"GPT-5.6_SOL" as const:"GPT-5.6_TERRA" as const;
      const resolvedModel=reviewer?"gpt-5.6-sol":"gpt-5.6-terra";
      const promptTemplateVersion=reviewer?"engineer-isolated-reviewer-v6":"engineer-codex-builder-v3";
      let transitionId=0;const transitioner=createEngineerSupervisor({dbPath:value.dbPath,
        idFactory:()=>`provider-${scenario.tag}-transition-${++transitionId}`,now:()=>new Date(timestamp),
        checkpointAttestor,hardeningPromptCacheSecret});
      let executing=transitioner.getRun(creation.child.childRunId);
      for(const nextState of ["QUEUED","SANDBOX_READY","IMPLEMENTING"] as const){
        executing=transitioner.transition({runId:executing.runId,expectedStateVersion:executing.stateVersion,nextState,
          reasonCode:`PROVIDER_TEST_${nextState}`,idempotencyKey:`provider-${scenario.tag}:${nextState}:${executing.stateVersion}`}).run;
      }
      if(reviewer)for(const nextState of ["FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","SECURITY_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"] as const){
        executing=transitioner.transition({runId:executing.runId,expectedStateVersion:executing.stateVersion,nextState,
          reasonCode:`PROVIDER_TEST_${nextState}`,idempotencyKey:`provider-${scenario.tag}:${nextState}:${executing.stateVersion}`}).run;
      }
      const ledger=new EngineerLedger(value.dbPath,()=>new Date(timestamp),hardeningPromptCacheSecret);
      const agentExecutionId=`provider-${scenario.tag}-${role.toLowerCase()}`,routingDecisionId=`provider-${scenario.tag}-route`;
      const agent={agentExecutionId,runId:creation.child.childRunId,role,modelTier,status:"RUNNING" as const,
        inputHash:sha256(`provider-${scenario.tag}-input`),outputArtifactId:null,startedAt:timestamp,completedAt:null};
      if(reviewer)ledger.recordAgentExecution(agent);else expect(ledger.claimBuilderDispatch(agent).won).toBe(true);
      ledger.recordModelRouting({routingDecisionId,runId:creation.child.childRunId,agentExecutionId,agentRole:role,
        logicalTier:modelTier,resolvedModel,routingPolicyVersion:"engineer-model-routing-v2",
        fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp});
      const nowMs=Date.parse(timestamp),fence=ledger.acquireHardeningExecutionFence({childRunId:creation.child.childRunId,
        ownerId:`provider-${scenario.tag}-worker`,ttlMs:10_000,nowMs,idempotencyKey:`provider-${scenario.tag}-fence`});
      const prefix=reviewer?reviewerStaticRequestPrefix(resolvedModel):builderStaticRequestPrefix(resolvedModel);
      const reservation=ledger.reserveHardeningPaidCall({childRunId:creation.child.childRunId,role,modelTier,
        resolvedModel,routingDecisionId,agentExecutionId,inputTokenUpperBound:100,outputTokenCeiling:reviewer?12_000:6_000,
        reservationIdempotencyKey:`provider-${scenario.tag}-reservation`,requestHash:sha256(`provider-${scenario.tag}-request`),cacheDescriptor:createHardeningPromptCacheMaterial({
          secret:hardeningPromptCacheSecret,requesterUserId:value.run.userId,childRunId:creation.child.childRunId,role,
          resolvedModel,promptOrReviewerPolicyVersion:promptTemplateVersion,staticPrefix:prefix,toolSchema:prefix.tools}).descriptor,
        fenceOwnerId:fence.ownerId,fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
      const actualResponseId=`provider-${scenario.tag}-actual`,submittedResponseId=("responseIdMismatch" in scenario&&scenario.responseIdMismatch)?`provider-${scenario.tag}-claimed`:actualResponseId;
      const response={id:actualResponseId,usage:{input_tokens:scenario.provider.input,output_tokens:scenario.provider.output,
        ...(!("missingDetails" in scenario&&scenario.missingDetails)?{input_tokens_details:{cached_tokens:scenario.provider.cached,cache_write_tokens:scenario.provider.write}}:{})}};
      const store=new LocalArtifactStore({root:join(value.root,"artifacts"),now:()=>new Date(timestamp),idFactory:()=>`provider-${scenario.tag}-artifact`});
      ledger.configureHardeningArtifactReader((candidate)=>store.readVerifiedExact(candidate));
      const artifact=ledger.recordArtifact(store.put({runId:creation.child.childRunId,type:"MODEL_PROVIDER_RESPONSE",bytes:JSON.stringify(response),
        producerType:"SYSTEM",producerId:"engineer-provider-response-recorder",trusted:true}));
      const usage=scenario.record;
      const modelCall={modelCallId:`provider-${scenario.tag}-call`,runId:creation.child.childRunId,agentExecutionId,
        logicalTier:modelTier,resolvedModel,promptTemplateVersion,
        inputContextRefs:[ledger.getRun(creation.child.childRunId).manifestHash!,sha256(`provider-${scenario.tag}-provider-input`),
          reservation.reservation.requestHash,reservation.reservation.clientRequestId,submittedResponseId],outputSchemaVersion:reviewer?"reviewer-output-v1":null,
        cacheKey:reservation.reservation.promptCacheKeyHash,
        cacheHit:usage&&(!("missingDetails" in scenario&&scenario.missingDetails)||("preserveRecordDetails" in scenario&&scenario.preserveRecordDetails))?usage.cached>0:null,latencyMs:1,
        inputTokens:usage?.input??null,outputTokens:usage?.output??null,
        cachedInputTokens:usage&&(!("missingDetails" in scenario&&scenario.missingDetails)||
          ("preserveRecordDetails" in scenario&&scenario.preserveRecordDetails))?usage.cached:null,
        cacheWriteInputTokens:usage&&(!("missingDetails" in scenario&&scenario.missingDetails)||
          ("preserveRecordDetails" in scenario&&scenario.preserveRecordDetails))?usage.write:null,
        retryCount:0,status:(usage?"SUCCEEDED":"FAILED") as "SUCCEEDED"|"FAILED",createdAt:timestamp};
      ledger.markHardeningPaidCallDispatching({childRunId:creation.child.childRunId,
        reservationId:reservation.reservation.reservationId,requestHash:reservation.reservation.requestHash,
        clientRequestId:reservation.reservation.clientRequestId,fenceOwnerId:fence.ownerId,
        fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
      let resultStatus:"SETTLED"|"AMBIGUOUS";
      const recordResponse=scenario.status==="SETTLED"||("recordAmbiguousResponse" in scenario&&scenario.recordAmbiguousResponse)||
        ("recoverAfterRecord" in scenario&&scenario.recoverAfterRecord);
      if(recordResponse){
        ledger.recordHardeningPaidCallResponse({childRunId:creation.child.childRunId,
          reservationId:reservation.reservation.reservationId,requestHash:reservation.reservation.requestHash,
          clientRequestId:reservation.reservation.clientRequestId,modelCall,providerResponseId:submittedResponseId,
          providerResponseArtifactId:artifact.artifactId,fenceOwnerId:fence.ownerId,
          fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
        if("missingDetails" in scenario&&scenario.missingDetails){
          const receiptDb=new Database(value.dbPath);
          expect(receiptDb.query(`SELECT dispatch_status,provider_response_artifact_id FROM hardening_child_model_reservations WHERE id=?`)
            .get(reservation.reservation.reservationId)).toEqual({dispatch_status:"RESPONSE_RECORDED",provider_response_artifact_id:artifact.artifactId});
          expect(receiptDb.query(`SELECT cached_input_tokens,cache_write_input_tokens FROM model_calls WHERE id=?`).get(modelCall.modelCallId))
            .toEqual({cached_input_tokens:null,cache_write_input_tokens:null});
          receiptDb.close();
        }
        if("recoverAfterRecord" in scenario&&scenario.recoverAfterRecord){
          ledger.releaseHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:fence.ownerId,
            fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
          const recovered=ledger.recoverHardeningPaidCall({childRunId:creation.child.childRunId,
            reservationId:reservation.reservation.reservationId,recoveryOwnerId:`provider-${scenario.tag}-recovery`,
            recoveryIdempotencyKey:`provider-${scenario.tag}-recovery`,rawRecoveryToken:`provider-${scenario.tag}-recovery-token`,nowMs});
          resultStatus=recovered.outcome==="SETTLED_RECOVERED"?"SETTLED":"AMBIGUOUS";
        }else {
          const settlement={childRunId:creation.child.childRunId,
            reservationId:reservation.reservation.reservationId,modelCall,providerResponseId:submittedResponseId,
            providerResponseArtifactId:artifact.artifactId,settlementIdempotencyKey:`provider-${scenario.tag}-settlement`,
            fenceOwnerId:fence.ownerId,fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs};
          resultStatus=ledger.settleHardeningPaidCall(settlement).status;
          if("missingDetails" in scenario&&scenario.missingDetails){
            // A manager supplies explicit null cache metrics. Rehydration from
            // SQLite must preserve that exact canonical shape on idempotent
            // replay instead of treating null as an omitted field.
            expect(ledger.settleHardeningPaidCall(settlement).status).toBe("AMBIGUOUS");
          }
        }
      }else{
        expect(()=>ledger.recordHardeningPaidCallResponse({childRunId:creation.child.childRunId,
          reservationId:reservation.reservation.reservationId,requestHash:reservation.reservation.requestHash,
          clientRequestId:reservation.reservation.clientRequestId,modelCall,providerResponseId:submittedResponseId,
          providerResponseArtifactId:artifact.artifactId,fenceOwnerId:fence.ownerId,
          fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs})).toThrow();
        ledger.releaseHardeningExecutionFence({childRunId:creation.child.childRunId,ownerId:fence.ownerId,
          fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs});
        const recovered=ledger.recoverHardeningPaidCall({childRunId:creation.child.childRunId,
          reservationId:reservation.reservation.reservationId,recoveryOwnerId:`provider-${scenario.tag}-recovery`,
          recoveryIdempotencyKey:`provider-${scenario.tag}-recovery`,rawRecoveryToken:`provider-${scenario.tag}-recovery-token`,nowMs});
        resultStatus=recovered.outcome==="AMBIGUOUS"?"AMBIGUOUS":"SETTLED";
      }
      expect(resultStatus).toBe(scenario.status);
      const db=new Database(value.dbPath);const row=db.query("SELECT status,cache_observation,settled_cost_microusd FROM hardening_child_model_reservations WHERE id=?")
        .get(reservation.reservation.reservationId) as {status:string;cache_observation:string;settled_cost_microusd:number|null};db.close();
      if(scenario.status==="SETTLED")expect(row).toEqual({status:"SETTLED",cache_observation:scenario.observation,
        settled_cost_microusd:hardeningModelPartitionedCostMicrousd(role,scenario.record!.input,scenario.record!.cached,
          scenario.record!.write,scenario.record!.output)});
      else {
        expect(row).toEqual({status:"AMBIGUOUS",cache_observation:"UNKNOWN",settled_cost_microusd:null});
        if("missingDetails" in scenario&&scenario.missingDetails&&!("preserveRecordDetails" in scenario&&scenario.preserveRecordDetails)){
          const liabilityDb=new Database(value.dbPath);
          expect(liabilityDb.query(`SELECT status,stop_reason,reserved_tokens,ambiguous_tokens FROM hardening_child_budget_authorities WHERE child_run_id=?`)
            .get(creation.child.childRunId)).toEqual({status:"STOPPED",stop_reason:"MODEL_USAGE_AMBIGUOUS",reserved_tokens:0,
              ambiguous_tokens:reservation.reservation.reservedTokens});
          expect((liabilityDb.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=?`).get(creation.child.childRunId) as {count:number}).count).toBe(1);
          expect((liabilityDb.query(`SELECT COUNT(*) AS count FROM retry_attempts WHERE run_id=?`).get(creation.child.childRunId) as {count:number}).count).toBe(0);
          liabilityDb.close();
        }
      }
      ledger.close();transitioner.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
    }
  }, 20_000);

  test("stops Builder and Reviewer at role cap plus one before creating a paid slot or reservation", async () => {
    for(const role of ["BUILDER","REVIEWER"] as const){
      const value=await hardeningConsentFixture(`run-hardening-${role.toLowerCase()}-input-cap`);
      const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
        {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
      const input={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,lineageHash:creation.lineage.lineageHash,
        idempotencyKey:`${role.toLowerCase()}-cap-start`};
      const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,input);
      const signedSeed=await signedHardeningSeedFixture(prepared,`${role.toLowerCase()}-cap`);
      await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,input,prepared,signedSeed);
      const ledger=new EngineerLedger(value.dbPath,()=>new Date(timestamp),hardeningPromptCacheSecret);
      const authority=ledger.getHardeningChildBudgetAuthority(creation.child.childRunId)!;
      const builder=role==="BUILDER",modelTier=builder?"GPT-5.6_TERRA" as const:"GPT-5.6_SOL" as const;
      const resolvedModel=builder?"gpt-5.6-terra":"gpt-5.6-sol",agentExecutionId=`cap-${role.toLowerCase()}-agent`;
      ledger.recordAgentExecution({agentExecutionId,runId:creation.child.childRunId,role,modelTier,status:"RUNNING",
        inputHash:sha256(`${role}-cap-input`),outputArtifactId:null,startedAt:timestamp,completedAt:null});
      const routingDecisionId=`cap-${role.toLowerCase()}-route`;
      ledger.recordModelRouting({routingDecisionId,runId:creation.child.childRunId,agentExecutionId,agentRole:role,logicalTier:modelTier,
        resolvedModel,routingPolicyVersion:"engineer-model-routing-v2",fallbackUsed:false,fallbackReason:null,cacheKey:null,timestamp});
      const nowMs=Date.parse(timestamp),fence=ledger.acquireHardeningExecutionFence({childRunId:creation.child.childRunId,
        ownerId:`cap-${role.toLowerCase()}-worker`,ttlMs:10_000,nowMs,idempotencyKey:`cap-${role.toLowerCase()}-fence`});
      const inputCap=builder?authority.transportLimits.builderInputCap:authority.transportLimits.reviewerInputCap;
      const cacheDescriptor=createHardeningPromptCacheMaterial({secret:hardeningPromptCacheSecret,requesterUserId:value.run.userId,
        childRunId:creation.child.childRunId,role,resolvedModel,promptOrReviewerPolicyVersion:builder?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6",
        staticPrefix:builder?builderStaticRequestPrefix(resolvedModel):reviewerStaticRequestPrefix(resolvedModel),
        toolSchema:(builder?builderStaticRequestPrefix(resolvedModel):reviewerStaticRequestPrefix(resolvedModel)).tools}).descriptor;
      expect(()=>ledger.reserveHardeningPaidCall({childRunId:creation.child.childRunId,role,modelTier,resolvedModel,routingDecisionId,
        agentExecutionId,inputTokenUpperBound:inputCap+1,outputTokenCeiling:builder?6_000:12_000,cacheDescriptor,requestHash:sha256(`cap-${role}-request`),
        reservationIdempotencyKey:`cap-${role.toLowerCase()}-reservation`,fenceOwnerId:fence.ownerId,
        fenceGeneration:fence.fenceGeneration,rawFenceToken:fence.rawFenceToken,nowMs})).toThrow(`${role}_INPUT_CAP_REACHED`);
      const db=new Database(value.dbPath);
      expect(db.query("SELECT status,stop_reason,reserved_cost_microusd,reserved_tokens FROM hardening_child_budget_authorities WHERE child_run_id=?")
        .get(creation.child.childRunId)).toEqual({status:"STOPPED",stop_reason:`${role}_INPUT_CAP_REACHED`,reserved_cost_microusd:0,reserved_tokens:0});
      expect(db.query("SELECT COUNT(*) AS count FROM hardening_model_call_slots WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});
      expect(db.query("SELECT COUNT(*) AS count FROM hardening_child_model_reservations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});
      db.close();ledger.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
    }
  });

  test("promotes a production-authority P5 child to one v2 checkpoint and leaves the parent byte-identical", async () => {
    const value=await hardeningConsentFixture("run-hardening-v2-e2e");const creation=await value.supervisor.createOptionalHardeningChildForOwner(
      value.run.userId,value.run.runId,{consentId:value.consent.consentId,consentHash:value.consent.consentHash});
    const input={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,lineageHash:creation.lineage.lineageHash,idempotencyKey:"start-v2-e2e"};
    const prepared=await value.supervisor.prepareOptionalHardeningStartForOwner(value.run.userId,value.run.runId,creation.child.childRunId,input);
    const signedSeed=await createSignedHardeningSeedAttestation({schemaVersion:1,policyVersion:"engineer-hardening-seed-attestation-v1",
      attestationType:"HARDENING_SEED_VERIFIED",operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,
      rootRunId:prepared.lineage.rootRunId,parentRunId:value.run.runId,childRunId:creation.child.childRunId,requesterUserId:value.run.userId,
      repositoryId:prepared.lineage.repositoryId,lineageId:prepared.lineage.lineageId,lineageHash:prepared.lineage.lineageHash,
      parentCheckpointId:prepared.parentCheckpoint.checkpointId,parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,
      baseCommitSha:prepared.seed.baseCommitSha,seedResultCommitSha:prepared.seed.seedResultCommitSha,seedTreeHash:sha256("v2-seed-tree"),
      seedDiffHash:prepared.seed.diffHash,imageDigest:sha256("v2-image"),environmentDigest:prepared.seed.environmentDigest,
      dependencyHash:sha256("v2-dependencies"),createdAt:prepared.operation.createdAt},checkpointAttestor);
    const committed=await commitHardeningStartFixture(value,value.run.runId,creation.child.childRunId,input,prepared,signedSeed);let finalizerId=0;const supervisor=createEngineerSupervisor({dbPath:value.dbPath,
      idFactory:()=>`hardening-v2-finalize-${++finalizerId}`,now:()=>new Date(timestamp),checkpointAttestor});
    const hardeningStore=new LocalArtifactStore({root:join(value.root,"artifacts"),now:()=>new Date(timestamp)});
    supervisor.configureArtifactReadAuthority(hardeningStore);
    let child=supervisor.finalizeOptionalHardeningStart(committed).run;
    for(const nextState of ["QUEUED","SANDBOX_READY","IMPLEMENTING","FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","SECURITY_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"] as const){
      child=supervisor.transition({runId:child.runId,expectedStateVersion:child.stateVersion,nextState,reasonCode:`V2_E2E_${nextState}`,
        manifestHash:child.manifestHash,idempotencyKey:`v2-e2e:${nextState}`}).run;}
    const hydrated=promotionFixture(child.runId,false,"src/index.ts",[],{root:value.root,dbPath:value.dbPath,supervisor,
      artifactStore:hardeningStore});
    const before=new Database(value.dbPath);const parentRun=before.query("SELECT * FROM engineer_runs WHERE id=?").get(value.run.runId);
    const parentBudget=before.query("SELECT * FROM run_budgets WHERE run_id=?").get(value.run.runId);before.close();
    const promoted=await supervisor.promoteVerifiedHardeningCandidate(hydrated.promotion,child.stateVersion);
    expect(promoted).toMatchObject({applied:true,checkpoint:{schemaVersion:2,parentCheckpointId:prepared.parentCheckpoint.checkpointId,
      parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,hardeningLineageId:prepared.lineage.lineageId,
      hardeningLineageHash:prepared.lineage.lineageHash,seedAttestationId:signedSeed.attestation.seedAttestationId,
      seedAttestationHash:signedSeed.attestation.seedAttestationHash}});
    expect(supervisor.getRun(child.runId).state).toBe("HUMAN_REVIEW_REQUIRED");
    const replay=await supervisor.promoteVerifiedHardeningCandidate(hydrated.promotion,child.stateVersion);
    expect(replay).toMatchObject({applied:false,checkpoint:{checkpointId:promoted.checkpoint.checkpointId}});
    const db=new Database(value.dbPath);expect(db.query("SELECT COUNT(*) AS count FROM verified_candidate_checkpoints WHERE run_id=? AND parent_checkpoint_hash IS NOT NULL AND hardening_lineage_hash IS NOT NULL AND seed_attestation_hash IS NOT NULL")
      .get(child.runId)).toEqual({count:1});expect(db.query("SELECT COUNT(*) AS count FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_VERIFIED'")
        .get(child.runId)).toEqual({count:value.advisories.length});expect(db.query("SELECT * FROM engineer_runs WHERE id=?").get(value.run.runId)).toEqual(parentRun);
    expect(db.query("SELECT * FROM run_budgets WHERE run_id=?").get(value.run.runId)).toEqual(parentBudget);
    expect(db.query("SELECT COUNT(*) AS count FROM approval_requests WHERE run_id=?").get(child.runId)).toEqual({count:0});
    expect(db.query("SELECT COUNT(*) AS count FROM git_operations WHERE run_id=?").get(child.runId)).toEqual({count:0});db.close();
    supervisor.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("starts P5 through strict HTTP and reaches the real v2 human-review checkpoint with only Terra Builder and Sol Reviewer", async () => {
    const runtimeImport=new Function("specifier","return import(specifier)") as (specifier:string)=>Promise<Record<string,unknown>>;
    const {EngineerRunManager}=await runtimeImport(new URL("../../../apps/gateway/src/engineer.ts",import.meta.url).href) as {
      EngineerRunManager:new(options:Record<string,unknown>)=>any;
    };
    const {createGatewayHandler}=await runtimeImport(new URL("../../../apps/gateway/src/handler.ts",import.meta.url).href) as {
      createGatewayHandler:(options:Record<string,unknown>)=>(request:Request)=>Promise<Response>;
    };
    const repositoryRoot=mkdtempSync(join(tmpdir(),"zintus-hardening-http-repository-"));
    mkdirSync(join(repositoryRoot,"src"),{recursive:true});
    writeFileSync(join(repositoryRoot,"src/index.ts"),"export const value = 1;\n");
    execFileSync("git",["init","-q","-b","main",repositoryRoot]);
    execFileSync("git",["-C",repositoryRoot,"config","user.email","test@zintus.local"]);
    execFileSync("git",["-C",repositoryRoot,"config","user.name","Zintus Test"]);
    execFileSync("git",["-C",repositoryRoot,"add","."]);
    execFileSync("git",["-C",repositoryRoot,"commit","-qm","base"]);
    const baseCommitSha=execFileSync("git",["-C",repositoryRoot,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
    writeFileSync(join(repositoryRoot,"src/index.ts"),"export const value = 2;\n");
    execFileSync("git",["-C",repositoryRoot,"add","."]);
    execFileSync("git",["-C",repositoryRoot,"commit","-qm","verified parent candidate"]);
    const parentResultCommitSha=execFileSync("git",["-C",repositoryRoot,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
    const parentDiff=execFileSync("git",["-C",repositoryRoot,"diff","--binary",baseCommitSha,parentResultCommitSha,"--"],{encoding:"utf8"}).trim();
    execFileSync("git",["-C",repositoryRoot,"reset","--hard","-q",baseCommitSha]);
    const digest=`sha256:${"a".repeat(64)}`;
    const environmentDigest=sha256({imageDigest:digest,offlineDependencyHash:null,sandboxPolicyVersion:SANDBOX_POLICY_VERSION,
      networkPolicyVersion:NETWORK_POLICY_VERSION,limits:{cpus:2,memory:"2g",pids:256}});
    const repositoryReference:RepositoryReference={repositoryId:"repo-hardening-http",provider:"local",owner:"local",name:"hardening-http",
      baseBranch:"main",baseCommitSha};
    const value=await hardeningConsentFixture("run-hardening-http-full-stack",[],{
      repository:repositoryReference,finalDiff:parentDiff,resultCommitSha:parentResultCommitSha,environmentDigest,
    });
    value.supervisor.close();
    value.supervisor=createEngineerSupervisor({dbPath:value.dbPath,checkpointAttestor,hardeningPromptCacheSecret});
    const artifactStore=new LocalArtifactStore({root:join(value.root,"artifacts")});
    value.supervisor.configureArtifactReadAuthority(artifactStore);
    const creation=await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,
      {consentId:value.consent.consentId,consentHash:value.consent.consentHash});
    const parentBefore=value.supervisor.exportRunRecords(value.run.runId);
    const parentArtifactsBefore=new Map(value.supervisor.listArtifacts(value.run.runId).map((artifact)=>[
      artifact.artifactId,readFileSync(artifact.storageReference),
    ]));
    const workspaceManager=new GitWorkspaceManager({workspaceRoot:join(value.root,"http-workspaces")});
    const dockerSpawn=((_:string,args:readonly string[])=>{
      const stdout=args[0]==="image"?JSON.stringify([`oven/bun@${digest}`]):args[0]==="info"?"27.0.0":"1 pass";
      return {pid:1,status:0,signal:null,stdout,stderr:"",output:[null,stdout,""],error:undefined};
    }) as typeof import("node:child_process").spawnSync;
    const sandboxManager=new DockerSandboxManager({workspaceManager,imageReference:`oven/bun@${digest}`,imageDigest:digest,dockerSpawn});
    const workerLeases=new EngineerWorkerLeaseManager({dbPath:join(value.root,"http-worker-leases.db"),
      tokenSecret:"http-hardening-worker-lease-secret-0000000000000",maxConcurrentLeases:4,
      recoverExpiredLease:()=>undefined});
    value.supervisor.configureRecoveryWorkerLeaseAuthority(workerLeases);
    const modelCalls:{role:string;responseId:string}[]=[];
    const builderTransport:ResponsesTransport={
      countInputTokens:async()=>1,
      create:async()=>{modelCalls.push({role:"BUILDER",responseId:"http-terra-builder"});return {id:"http-terra-builder",
        usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:"function_call",call_id:"http-hardening-write",name:"write_file",
          arguments:JSON.stringify({path:"src/index.ts",content:"export const value = 3;\n"})}]};},
    };
    const execution=new EngineerExecutionManager({supervisor:value.supervisor,sandboxManager,artifactStore,
      repositoryRootFor:(repositoryId)=>{expect(repositoryId).toBe(repositoryReference.repositoryId);return repositoryRoot;},
      transportForRun:()=>builderTransport,builderOptions:{maxRounds:1},hardeningPromptCacheSecret,
      leaseManager:workerLeases,workerOwnerId:"http-hardening-execution"});
    const reviewerTransport:ResponsesTransport={
      countInputTokens:async()=>1,
      create:async(request)=>{modelCalls.push({role:"REVIEWER",responseId:"http-sol-reviewer"});
        const dynamicInput=(request.input as Array<{content:Array<{text:string}>}>).at(-1)!;
        const input=JSON.parse(dynamicInput.content[0]!.text) as {
          manifest:{acceptanceCriteria:Array<{criterionId:string}>};diffHash:string;evidenceBundleHash:string;
          trustedEvidence:Array<{evidenceId:string;eventType:string}>;
        };
        const evidenceId=input.trustedEvidence.find((item)=>item.eventType==="INDEPENDENT_VERIFICATION")!.evidenceId;
        return {id:"http-sol-reviewer",usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:"function_call",call_id:"http-sol-review",
          name:"submit_review",arguments:JSON.stringify({decision:"APPROVE",requirementCoverage:input.manifest.acceptanceCriteria.map((criterion)=>({
            criterionId:criterion.criterionId,status:"SATISFIED",evidenceIds:[evidenceId],explanation:"Inherited deterministic evidence passed.",
          })),findings:[],unsupportedClaims:[],residualRisks:[],reviewedDiffHash:input.diffHash,
          reviewedEvidenceBundleHash:input.evidenceBundleHash,reviewPolicyVersion:REVIEWER_POLICY_VERSION})}]};
      },
    };
    const verification=new EngineerVerificationManager({supervisor:value.supervisor,executionManager:execution,sandboxManager,artifactStore,
      checkpointAttestor,transportForRole:(_runId,role)=>{expect(role).toBe("REVIEWER");return reviewerTransport;},
      hardeningPromptCacheSecret,leaseManager:workerLeases,workerOwnerId:"http-hardening-verification"});
    const principal={ownerId:value.run.userId,reviewerId:"http-reviewer",sessionId:"http-session",safetyIdentifier:sha256("http-safety")};
    const preflight={readiness:()=>({state:"READY",error:null}),repository:()=>repositoryReference,repositories:()=>[repositoryReference],
      assertStartup:async()=>undefined,assertRunAdmission:async()=>undefined} as never;
    const manager=new EngineerRunManager({supervisor:value.supervisor,execution,verification,artifactStore,preflight,principal,
      checkpointAttestor,workerOwnerId:"http-hardening-worker",leaseManager:workerLeases});
    const handlerErrors:unknown[]=[];
    const handler=createGatewayHandler({engine:{} as never,config:{port:8788,host:"127.0.0.1",token:"strict-http-token",corsOrigins:"*"},
      engineerRuns:manager,onError:(error:unknown)=>handlerErrors.push(error)});
    const input={expectedChildStateVersion:0 as const,lineageId:creation.lineage.lineageId,lineageHash:creation.lineage.lineageHash,
      idempotencyKey:"http-full-stack-start"};
    const response=await handler(new Request(`http://127.0.0.1:8788/v1/engineer/runs/${value.run.runId}/hardening/children/${creation.child.childRunId}/start`,{
      method:"POST",headers:{Authorization:"Bearer strict-http-token","Content-Type":"application/json"},body:JSON.stringify(input),
    }));
    const responseBody=await response.json() as Record<string,unknown>;
    expect({status:response.status,body:responseBody,errors:handlerErrors.map((error)=>error instanceof Error?error.message:String(error))})
      .toMatchObject({status:202,errors:[],body:{start:{status:"STARTED",seed:{status:"VERIFIED",seedDiffHash:sha256(parentDiff)}}}});
    const deadline=Date.now()+20_000;
    while(value.supervisor.getRun(creation.child.childRunId).state!=="HUMAN_REVIEW_REQUIRED"&&Date.now()<deadline){
      if(["BLOCKED_BY_ENVIRONMENT","FAILED","REJECTED"].includes(value.supervisor.getRun(creation.child.childRunId).state))break;
      await new Promise((resolve)=>setTimeout(resolve,10));
    }
    if(value.supervisor.getRun(creation.child.childRunId).state!=="HUMAN_REVIEW_REQUIRED")throw new Error(canonicalJson({
      lastError:value.supervisor.getLastError(creation.child.childRunId),events:value.supervisor.listEvents(creation.child.childRunId),
      failures:value.supervisor.listFailures(creation.child.childRunId)}));
    expect(value.supervisor.getRun(creation.child.childRunId).state).toBe("HUMAN_REVIEW_REQUIRED");
    await manager.drain();
    expect(modelCalls).toEqual([{role:"BUILDER",responseId:"http-terra-builder"},{role:"REVIEWER",responseId:"http-sol-reviewer"}]);
    const childRecords=value.supervisor.exportRunRecords(creation.child.childRunId);
    expect((childRecords.hardening_model_call_slots??[]).map((row)=>({role:row.role,model_tier:row.model_tier,status:row.status})))
      .toEqual([{role:"BUILDER",model_tier:"GPT-5.6_TERRA",status:"COMPLETED"},{role:"REVIEWER",model_tier:"GPT-5.6_SOL",status:"COMPLETED"}]);
    expect((childRecords.hardening_child_model_reservations??[]).map((row)=>({role:row.role,status:row.status,currency:row.currency})))
      .toEqual([{role:"BUILDER",status:"SETTLED",currency:"USD"},{role:"REVIEWER",status:"SETTLED",currency:"USD"}]);
    const successorLedger=new EngineerLedger(value.dbPath,()=>new Date(timestamp),hardeningPromptCacheSecret);
    const builderReservation=(childRecords.hardening_child_model_reservations??[]).find((row)=>row.role==="BUILDER")!;
    const reviewerReservation=(childRecords.hardening_child_model_reservations??[]).find((row)=>row.role==="REVIEWER")!;
    const builderSuccessor={childRunId:creation.child.childRunId,reservationId:String(builderReservation.id),
      agentExecutionId:String(builderReservation.agent_execution_id),expectedRunState:String(builderReservation.expected_run_state),
      expectedStateVersion:Number(builderReservation.expected_state_version)};
    const reviewerSuccessor={childRunId:creation.child.childRunId,reservationId:String(reviewerReservation.id),
      agentExecutionId:String(reviewerReservation.agent_execution_id)};
    const strictRead=(candidate:ArtifactRecord)=>artifactStore.readVerifiedExact(candidate);
    expect(successorLedger.hasExactHardeningBuilderSuccessor(builderSuccessor,strictRead)).toBe(true);
    expect(successorLedger.hasExactHardeningReviewerSuccessor(reviewerSuccessor,strictRead)).toBe(true);
    for(const [role,verify] of [["BUILDER",()=>successorLedger.hasExactHardeningBuilderSuccessor(builderSuccessor,strictRead)],
      ["REVIEWER",()=>successorLedger.hasExactHardeningReviewerSuccessor(reviewerSuccessor,strictRead)]] as const){
      const execution=(childRecords.agent_executions??[]).find((row)=>row.role===role)!;
      const artifact=value.supervisor.listArtifacts(creation.child.childRunId)
        .find((item)=>item.artifactId===execution.output_artifact_id)!;
      const originalBytes=readFileSync(artifact.storageReference);
      writeFileSync(artifact.storageReference,Buffer.concat([originalBytes,Buffer.from("\ncorrupt-after-successor")]));
      expect(verify()).toBe(false);
      writeFileSync(artifact.storageReference,originalBytes);
      expect(verify()).toBe(true);
    }
    for(const role of ["BUILDER","REVIEWER"] as const){
      const finalization=(childRecords.hardening_paid_call_finalizations??[]).find((row)=>row.role===role)!;
      const finalizationId=String(finalization.id);
      const reset=new Database(value.dbPath);
      const trigger=reset.query(`SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='fence_hardening_paid_call_finalization_update_v29'`).get() as {sql:string}|null;
      if(!trigger?.sql)throw new Error("paid-call finalization immutability trigger is missing");
      reset.exec("DROP TRIGGER fence_hardening_paid_call_finalization_update_v29");
      reset.query(`UPDATE hardening_paid_call_finalizations SET status='PENDING',claim_owner_id=NULL,
        claim_token_hash=NULL,claim_generation=0,claim_idempotency_key=NULL,claim_expires_at_ms=NULL,applied_at_ms=NULL
        WHERE id=?`).run(finalizationId);
      reset.exec(trigger.sql);reset.close();
      const artifactId=role==="BUILDER"?builderReservation.provider_response_artifact_id:
        reviewerReservation.provider_response_artifact_id;
      const artifact=value.supervisor.listArtifacts(creation.child.childRunId)
        .find((item)=>item.artifactId===artifactId)!;
      const originalBytes=readFileSync(artifact.storageReference);
      const substitutedBytes=role==="BUILDER"
        ?readFileSync(value.supervisor.listArtifacts(creation.child.childRunId)
          .find((item)=>item.artifactId===reviewerReservation.provider_response_artifact_id)!.storageReference)
        :Buffer.concat([originalBytes,Buffer.from(`\ncorrupt-before-${role}-apply`)]);
      writeFileSync(artifact.storageReference,substitutedBytes);
      const consume={finalizationId,ownerId:`normal-${role.toLowerCase()}-consumer`,
        rawToken:`normal-${role.toLowerCase()}-token`,idempotencyKey:`normal-${role.toLowerCase()}-consume`,
        nowMs:Number(finalization.created_at_ms)+1,expectedSuccessor:"SUCCESS" as const};
      const assertRejectedAndRolledBack=()=>{
        expect(()=>value.supervisor.consumeHardeningPaidCallFinalization(consume))
          .toThrow();
        const afterRejectedConsume=new Database(value.dbPath,{readonly:true});
        expect(afterRejectedConsume.query(`SELECT status,claim_owner_id,claim_generation
          FROM hardening_paid_call_finalizations WHERE id=?`).get(finalizationId))
          .toEqual({status:"PENDING",claim_owner_id:null,claim_generation:0});
        afterRejectedConsume.close();
      };
      assertRejectedAndRolledBack();
      writeFileSync(artifact.storageReference,originalBytes);
      const roleReservation=role==="BUILDER"?builderReservation:reviewerReservation;
      const reservationId=String(roleReservation.id),modelCallId=String(roleReservation.model_call_id);
      const reservationDb=new Database(value.dbPath);
      const reservationTrigger=reservationDb.query(`SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='fence_hardening_child_model_reservation_update_v29'`).get() as {sql:string}|null;
      if(!reservationTrigger?.sql)throw new Error("hardening reservation immutability trigger is missing");
      const originalReservation=reservationDb.query("SELECT * FROM hardening_child_model_reservations WHERE id=?")
        .get(reservationId) as Record<string,unknown>;
      const sqlBinding=(value:unknown):string|number|null=>value===null?null:
        typeof value==="number"?value:String(value);
      reservationDb.exec("PRAGMA foreign_keys=OFF");
      reservationDb.exec("DROP TRIGGER fence_hardening_child_model_reservation_update_v29");
      const reservationTamperCases=[
        {sql:`UPDATE hardening_child_model_reservations SET actual_input_tokens=actual_input_tokens+1,
          actual_uncached_input_tokens=actual_uncached_input_tokens+1 WHERE id=?`,restore:`UPDATE hardening_child_model_reservations
          SET actual_input_tokens=?,actual_uncached_input_tokens=? WHERE id=?`,restoreArgs:[originalReservation.actual_input_tokens,originalReservation.actual_uncached_input_tokens,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET reconciliation_json='{}' WHERE id=?",restore:"UPDATE hardening_child_model_reservations SET reconciliation_json=? WHERE id=?",
          restoreArgs:[originalReservation.reconciliation_json,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET reconciliation_id=? WHERE id=?",args:[sha256(`tampered-${role}-reconciliation-id`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET reconciliation_id=? WHERE id=?",restoreArgs:[originalReservation.reconciliation_id,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET reconciliation_hash=? WHERE id=?",args:[sha256(`tampered-${role}-reconciliation-hash`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET reconciliation_hash=? WHERE id=?",restoreArgs:[originalReservation.reconciliation_hash,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET settled_cost_microusd=settled_cost_microusd+1 WHERE id=?",
          restore:"UPDATE hardening_child_model_reservations SET settled_cost_microusd=? WHERE id=?",restoreArgs:[originalReservation.settled_cost_microusd,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET cache_shard=1 WHERE id=?",restore:"UPDATE hardening_child_model_reservations SET cache_shard=? WHERE id=?",
          restoreArgs:[originalReservation.cache_shard,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET static_prefix_hash=? WHERE id=?",args:[sha256(`tampered-${role}-static-prefix`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET static_prefix_hash=? WHERE id=?",restoreArgs:[originalReservation.static_prefix_hash,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET tool_schema_hash=? WHERE id=?",args:[sha256(`tampered-${role}-tool-schema`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET tool_schema_hash=? WHERE id=?",restoreArgs:[originalReservation.tool_schema_hash,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET prompt_cache_key_hash=? WHERE id=?",args:[sha256(`tampered-${role}-cache-key`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET prompt_cache_key_hash=? WHERE id=?",restoreArgs:[originalReservation.prompt_cache_key_hash,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET reservation_hash=? WHERE id=?",args:[sha256(`tampered-${role}-reservation-hash`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET reservation_hash=? WHERE id=?",restoreArgs:[originalReservation.reservation_hash,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET cached_input_microusd_per_million=cached_input_microusd_per_million+1 WHERE id=?",
          restore:"UPDATE hardening_child_model_reservations SET cached_input_microusd_per_million=? WHERE id=?",
          restoreArgs:[originalReservation.cached_input_microusd_per_million,reservationId]},
        {sql:"UPDATE hardening_child_model_reservations SET settlement_input_hash=? WHERE id=?",args:[sha256(`tampered-${role}-settlement`),reservationId],
          restore:"UPDATE hardening_child_model_reservations SET settlement_input_hash=? WHERE id=?",
          restoreArgs:[originalReservation.settlement_input_hash,reservationId]},
      ] as const;
      for(const scenario of reservationTamperCases){
        reservationDb.query(scenario.sql).run(...("args" in scenario?scenario.args:[reservationId]));
        assertRejectedAndRolledBack();
        reservationDb.query(scenario.restore).run(...scenario.restoreArgs.map(sqlBinding));
      }
      reservationDb.exec(reservationTrigger.sql);reservationDb.close();

      const modelDb=new Database(value.dbPath);
      const originalModel=modelDb.query("SELECT * FROM model_calls WHERE id=?").get(modelCallId) as Record<string,unknown>;
      modelDb.query("UPDATE model_calls SET resolved_model=? WHERE id=?")
        .run(role==="BUILDER"?"gpt-5.6-sol":"gpt-5.6-terra",modelCallId);
      assertRejectedAndRolledBack();
      modelDb.query("UPDATE model_calls SET resolved_model=? WHERE id=?").run(String(originalModel.resolved_model),modelCallId);
      const originalRefs=JSON.parse(String(originalModel.input_context_refs_json)) as string[];
      const refTamperCases=[
        [...originalRefs,sha256(`extra-${role}-context`)],
        [originalRefs[1]!,originalRefs[0]!,...originalRefs.slice(2)],
        originalRefs.slice(1),
        [originalRefs[0]!,...originalRefs.slice(2)],
      ];
      for(const refs of refTamperCases){
        modelDb.query("UPDATE model_calls SET input_context_refs_json=? WHERE id=?").run(canonicalJson(refs),modelCallId);
        assertRejectedAndRolledBack();
        modelDb.query("UPDATE model_calls SET input_context_refs_json=? WHERE id=?")
          .run(String(originalModel.input_context_refs_json),modelCallId);
      }
      const extraModelCallId=`tamper-extra-${role.toLowerCase()}-model-call`;
      modelDb.query(`INSERT INTO model_calls(id,run_id,agent_execution_id,logical_tier,resolved_model,prompt_template_version,
        input_context_refs_json,output_schema_version,cache_key,cache_hit,latency_ms,input_tokens,output_tokens,
        cached_input_tokens,cache_write_input_tokens,retry_count,budget_reservation_id,status,created_at)
        SELECT ?,run_id,agent_execution_id,logical_tier,resolved_model,prompt_template_version,input_context_refs_json,
        output_schema_version,cache_key,cache_hit,latency_ms,input_tokens,output_tokens,cached_input_tokens,
        cache_write_input_tokens,retry_count,budget_reservation_id,status,created_at FROM model_calls WHERE id=?`)
        .run(extraModelCallId,modelCallId);
      assertRejectedAndRolledBack();
      modelDb.query("DELETE FROM model_calls WHERE id=?").run(extraModelCallId);modelDb.close();

      const routeId=String(roleReservation.routing_decision_id);
      const routeDb=new Database(value.dbPath);
      const originalRoute=routeDb.query("SELECT * FROM model_routing_decisions WHERE id=?").get(routeId) as Record<string,unknown>;
      const roleExecution=(childRecords.agent_executions??[]).find((row)=>row.role===role)!;
      const routeTamperCases=[
        {column:"routing_policy_version",value:"tampered-routing-policy"},
        {column:"cache_key",value:"tampered-cache-key"},
        {column:"timestamp",value:new Date(Date.parse(String(roleExecution.started_at))-1).toISOString()},
      ] as const;
      for(const scenario of routeTamperCases){
        routeDb.query(`UPDATE model_routing_decisions SET ${scenario.column}=? WHERE id=?`).run(scenario.value,routeId);
        assertRejectedAndRolledBack();
        routeDb.query(`UPDATE model_routing_decisions SET ${scenario.column}=? WHERE id=?`).run(sqlBinding(originalRoute[scenario.column]),routeId);
      }
      routeDb.query("UPDATE model_routing_decisions SET fallback_used=1,fallback_reason='tampered fallback' WHERE id=?").run(routeId);
      assertRejectedAndRolledBack();
      routeDb.query("UPDATE model_routing_decisions SET fallback_used=?,fallback_reason=? WHERE id=?")
        .run(Number(originalRoute.fallback_used),sqlBinding(originalRoute.fallback_reason),routeId);
      const extraRouteId=`tamper-extra-${role.toLowerCase()}-route`;
      routeDb.query(`INSERT INTO model_routing_decisions(id,run_id,agent_execution_id,agent_role,logical_tier,resolved_model,
        routing_policy_version,fallback_used,fallback_reason,cache_key,timestamp)
        SELECT ?,run_id,agent_execution_id,agent_role,logical_tier,resolved_model,routing_policy_version,
        fallback_used,fallback_reason,cache_key,timestamp FROM model_routing_decisions WHERE id=?`).run(extraRouteId,routeId);
      assertRejectedAndRolledBack();
      routeDb.query("DELETE FROM model_routing_decisions WHERE id=?").run(extraRouteId);routeDb.close();

      if(role==="BUILDER"){
        const execution=(childRecords.agent_executions??[]).find((row)=>row.role==="BUILDER")!;
        const builderArtifact=value.supervisor.listArtifacts(creation.child.childRunId)
          .find((item)=>item.artifactId===execution.output_artifact_id)!;
        const builderBytes=readFileSync(builderArtifact.storageReference);
        const semanticDrift={...JSON.parse(builderBytes.toString("utf8")),model:"gpt-5.6-sol"};
        const driftBytes=Buffer.from(JSON.stringify(semanticDrift));
        writeFileSync(builderArtifact.storageReference,driftBytes);
        const artifactDb=new Database(value.dbPath);
        artifactDb.query("UPDATE artifacts SET sha256=?,size_bytes=? WHERE id=?")
          .run(sha256Bytes(driftBytes),driftBytes.byteLength,builderArtifact.artifactId);
        assertRejectedAndRolledBack();
        writeFileSync(builderArtifact.storageReference,builderBytes);
        artifactDb.query("UPDATE artifacts SET sha256=?,size_bytes=? WHERE id=?")
          .run(builderArtifact.sha256,builderArtifact.sizeBytes,builderArtifact.artifactId);artifactDb.close();
      }
      expect(value.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",role});
      expect(value.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",role});
    }
    successorLedger.close();
    expect(childRecords.hardening_child_budget_authorities).toEqual([expect.objectContaining({status:"VERIFIED",stop_reason:null,
      reserved_cost_microusd:0,reserved_tokens:0,ambiguous_cost_microusd:0,ambiguous_tokens:0,active_since_ms:null})]);
    expect((childRecords.artifacts??[]).filter((row)=>row.type==="MODEL_PROVIDER_RESPONSE").map((row)=>({trusted:row.trusted,producer_type:row.producer_type})))
      .toEqual([{trusted:1,producer_type:"SYSTEM"},{trusted:1,producer_type:"SYSTEM"}]);
    const noGenericReservations=new Database(value.dbPath);expect(noGenericReservations.query("SELECT COUNT(*) AS count FROM cost_records WHERE run_id=? AND source_type='MODEL_RESERVATION'")
      .get(creation.child.childRunId)).toEqual({count:0});noGenericReservations.close();
    expect((childRecords.agent_executions??[]).map((row)=>row.role).sort()).toEqual(["BUILDER","REVIEWER"]);
    expect(childRecords.retry_attempts??[]).toEqual([]);
    expect((childRecords.run_state_events??[]).every((row)=>row.run_id===creation.child.childRunId)).toBe(true);
    if((childRecords.verified_candidate_checkpoints??[]).length!==1)throw new Error(canonicalJson({lastError:value.supervisor.getLastError(creation.child.childRunId),events:value.supervisor.listEvents(creation.child.childRunId),
      classifications:childRecords.review_classification_batches,findings:childRecords.review_findings}));
    expect(childRecords.verified_candidate_checkpoints).toHaveLength(1);
    expect(childRecords.verified_candidate_checkpoints![0]).toMatchObject({parent_checkpoint_id:expect.any(String)});
    expect(JSON.parse(String(childRecords.verified_candidate_checkpoints![0]!.checkpoint_json))).toMatchObject({schemaVersion:2});
    expect(childRecords.approval_requests??[]).toEqual([]);expect(childRecords.git_operations??[]).toEqual([]);
    const audit=new Database(value.dbPath,{readonly:true});
    expect(audit.query("SELECT seed_diff_hash, seed_result_commit_sha FROM hardening_seed_attestations WHERE child_run_id=?").get(creation.child.childRunId))
      .toEqual({seed_diff_hash:sha256(parentDiff),seed_result_commit_sha:parentResultCommitSha});
    expect(audit.query("SELECT COUNT(*) AS count FROM publication_candidate_selections WHERE candidate_run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    expect(audit.query("SELECT COUNT(*) AS count FROM candidate_lineage_attestations WHERE child_run_id=?").get(creation.child.childRunId)).toEqual({count:0});
    audit.close();
    const parentAfter=value.supervisor.exportRunRecords(value.run.runId);
    expect(parentAfter.engineer_runs).toEqual(parentBefore.engineer_runs);expect(parentAfter.run_budgets).toEqual(parentBefore.run_budgets);
    expect(parentAfter.verified_candidate_checkpoints).toEqual(parentBefore.verified_candidate_checkpoints);
    for(const [artifactId,bytes] of parentArtifactsBefore){
      const artifact=value.supervisor.listArtifacts(value.run.runId).find((item)=>item.artifactId===artifactId)!;
      expect(readFileSync(artifact.storageReference)).toEqual(bytes);
    }
    expect(value.reviewerInput.finalDiff).toBe(parentDiff);
    workerLeases.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});rmSync(repositoryRoot,{recursive:true,force:true});
  },30_000);

  test("rejects foreign ownership, closed first-create selection, deterministic-ID collision, and rolls back a failed lineage insert", async () => {
    const closed=await hardeningConsentFixture("run-hardening-child-closed");
    await closed.supervisor.deferAdvisoryForOwner(closed.run.userId,closed.run.runId,closed.advisories[0]!.advisoryId,{expectedRevision:0,idempotencyKey:"close-before-child",rationale:null});
    const request={consentId:closed.consent.consentId,consentHash:closed.consent.consentHash};
    await expect(closed.supervisor.createOptionalHardeningChildForOwner("other-owner",closed.run.runId,request)).rejects.toThrow("not found");
    await expect(closed.supervisor.createOptionalHardeningChildForOwner(closed.run.userId,closed.run.runId,request)).rejects.toThrow("open");
    expect(()=>closed.supervisor.getRun(hardeningChildRunId(closed.consent.consentHash))).toThrow();closed.supervisor.close();rmSync(closed.root,{recursive:true,force:true});

    const collision=await hardeningConsentFixture("run-hardening-child-collision");const collisionId=hardeningChildRunId(collision.consent.consentHash);const db=new Database(collision.dbPath);
    db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at)
      VALUES(?,?,?,?,?,'counterfeit','counterfeit','REQUEST_RECEIVED',0,'HIGH',1,?,?)`).run(collisionId,collision.run.userId,collision.parent.repository.repositoryId,
      collision.parent.repository.baseBranch,collision.parent.repository.baseCommitSha,timestamp,timestamp);db.close();
    await expect(collision.supervisor.createOptionalHardeningChildForOwner(collision.run.userId,collision.run.runId,{consentId:collision.consent.consentId,consentHash:collision.consent.consentHash})).rejects.toThrow("authority");
    collision.supervisor.close();rmSync(collision.root,{recursive:true,force:true});

    for(const boundary of ["BUDGET","LINEAGE"] as const){const rollback=await hardeningConsentFixture(`run-hardening-child-rollback-${boundary.toLowerCase()}`);const rollbackDb=new Database(rollback.dbPath);
      if(boundary==="BUDGET")rollbackDb.exec("CREATE TRIGGER fail_hardening_budget_for_test BEFORE INSERT ON run_budgets BEGIN SELECT RAISE(ABORT,'forced budget failure'); END;");
      else rollbackDb.exec("CREATE TRIGGER fail_hardening_lineage_for_test BEFORE INSERT ON engineer_run_lineage BEGIN SELECT RAISE(ABORT,'forced lineage failure'); END;");rollbackDb.close();
      const rollbackChild=hardeningChildRunId(rollback.consent.consentHash);
      await expect(rollback.supervisor.createOptionalHardeningChildForOwner(rollback.run.userId,rollback.run.runId,{consentId:rollback.consent.consentId,consentHash:rollback.consent.consentHash})).rejects.toThrow(`forced ${boundary.toLowerCase()} failure`);
      const after=new Database(rollback.dbPath);expect(after.query("SELECT COUNT(*) AS count FROM engineer_runs WHERE id=?").get(rollbackChild)).toEqual({count:0});
      expect(after.query("SELECT COUNT(*) AS count FROM run_budgets WHERE run_id=?").get(rollbackChild)).toEqual({count:0});
      expect(after.query("SELECT COUNT(*) AS count FROM engineer_run_lineage WHERE consent_id=?").get(rollback.consent.consentId)).toEqual({count:0});after.close();
      rollback.supervisor.close();rmSync(rollback.root,{recursive:true,force:true});}
  });

  test("two supervisors converge on one child and an accepted-at-expiry consent remains consumable later", async () => {
    const value=promotionFixture("run-hardening-child-expired-consent",true);await value.supervisor.promoteVerifiedCandidate(value.promotion,value.run.stateVersion);
    const parent=value.supervisor.getRun(value.run.runId),item=(await value.supervisor.listAdvisoryBacklogForOwner(value.run.userId,value.run.runId)).items[0]!;
    const quote=await value.supervisor.createHardeningQuoteForOwner(value.run.userId,{runId:value.run.runId,advisoryIds:[item.advisoryId],expectedParentStateVersion:parent.stateVersion,idempotencyKey:"expiry-child-quote"});
    const atExpiry=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(quote.expiresAt),checkpointAttestor});
    atExpiry.configureArtifactReadAuthority(value.artifactStore);
    const consent=await atExpiry.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{quoteId:quote.quoteId,quoteHash:quote.quoteHash,
      authorizedBudget:{costMicrousd:quote.estimate.maxCostMicrousd,tokens:quote.estimate.maxTokens,timeSeconds:quote.estimate.maxTimeSeconds},
      acknowledgements:{separateRun:true,parentCandidateUnchanged:true,noAutomaticRepair:true,noOverages:true},expectedParentStateVersion:parent.stateVersion,idempotencyKey:"expiry-child-consent"});atExpiry.close();
    const later=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(Date.parse(quote.expiresAt)+86_400_000),checkpointAttestor});
    const second=createEngineerSupervisor({dbPath:value.dbPath,now:()=>new Date(Date.parse(quote.expiresAt)+86_400_000),checkpointAttestor});
    later.configureArtifactReadAuthority(value.artifactStore);second.configureArtifactReadAuthority(value.artifactStore);
    const input={consentId:consent.consentId,consentHash:consent.consentHash};const outcomes=await Promise.all([
      later.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,input),second.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,input)]);
    expect(outcomes[0]).toEqual(outcomes[1]);const records=later.exportRunRecords(value.run.runId);expect(records.engineer_run_lineage).toHaveLength(1);
    second.close();later.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("allows only one nonterminal child per parent checkpoint, then permits a new consent after terminalization", async () => {
    const value=await hardeningConsentFixture("run-hardening-child-active");
    const first=(await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,{consentId:value.consent.consentId,consentHash:value.consent.consentHash})).child;
    const laterAt=new Date(Date.parse(timestamp)+1_000);const later=createEngineerSupervisor({dbPath:value.dbPath,now:()=>laterAt,checkpointAttestor});
    later.configureArtifactReadAuthority(value.artifactStore);
    const parent=later.getRun(value.run.runId);const quote=await later.createHardeningQuoteForOwner(value.run.userId,{runId:value.run.runId,
      advisoryIds:value.quote.advisoryIds,expectedParentStateVersion:parent.stateVersion,idempotencyKey:"second-child-quote"});
    const consent=await later.acceptHardeningConsentForOwner(value.run.userId,value.run.runId,{quoteId:quote.quoteId,quoteHash:quote.quoteHash,
      authorizedBudget:{costMicrousd:quote.estimate.maxCostMicrousd,tokens:quote.estimate.maxTokens,timeSeconds:quote.estimate.maxTimeSeconds},
      acknowledgements:{separateRun:true,parentCandidateUnchanged:true,noAutomaticRepair:true,noOverages:true},expectedParentStateVersion:parent.stateVersion,
      idempotencyKey:"second-child-consent"});const request={consentId:consent.consentId,consentHash:consent.consentHash};
    await expect(later.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,request)).rejects.toThrow("open, actionable");
    const initial=later.getRun(first.childRunId);const pending=later.transition({runId:first.childRunId,expectedStateVersion:initial.stateVersion,
      nextState:"CANCELLATION_PENDING",reasonCode:"TEST_TERMINALIZE_CHILD",manifestHash:null,idempotencyKey:"terminalize-child-pending"}).run;
    later.transition({runId:first.childRunId,expectedStateVersion:pending.stateVersion,nextState:"CANCELLED",reasonCode:"TEST_TERMINALIZE_CHILD",
      manifestHash:null,idempotencyKey:"terminalize-child-complete"});
    const second=(await later.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,request)).child;
    expect(second.childRunId).not.toBe(first.childRunId);expect(second.parentRunId).toBe(first.parentRunId);expect(second.rootRunId).toBe(first.rootRunId);
    later.close();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});
  });

  test("fails child creation closed on every upstream authority tamper and replay on lineage-root corruption", async () => {
    for(const mode of ["CONSENT","QUOTE","REQUEST","CHECKPOINT","MAPPING","PARENT_BASE"] as const){const value=await hardeningConsentFixture(`run-hardening-child-tamper-${mode.toLowerCase()}`);
      const db=new Database(value.dbPath);
      if(mode==="CONSENT"){db.exec("DROP TRIGGER prevent_hardening_consents_update_v23");db.query("UPDATE hardening_consents SET consent_json='{}' WHERE id=?").run(value.consent.consentId);}
      if(mode==="QUOTE"){db.exec("DROP TRIGGER prevent_hardening_quotes_update_v23");db.query("UPDATE hardening_quotes SET quote_json='{}' WHERE id=?").run(value.quote.quoteId);}
      if(mode==="REQUEST"){db.exec("DROP TRIGGER prevent_hardening_quote_requests_update_v24");db.query("UPDATE hardening_quote_requests SET request_json='{}' WHERE quote_id=?").run(value.quote.quoteId);}
      if(mode==="CHECKPOINT"){db.exec("DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21");db.query("UPDATE verified_candidate_checkpoints SET signature='tampered' WHERE id=?").run(value.quote.parentCheckpointId);}
      if(mode==="MAPPING"){db.exec("DROP TRIGGER prevent_hardening_quote_advisories_update_v23");db.query("UPDATE hardening_quote_advisories SET ordinal=1 WHERE quote_id=?").run(value.quote.quoteId);}
      if(mode==="PARENT_BASE"){db.query("UPDATE engineer_runs SET base_commit_sha='changed-after-checkpoint' WHERE id=?").run(value.run.runId);}db.close();
      await expect(value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,{consentId:value.consent.consentId,consentHash:value.consent.consentHash})).rejects.toThrow();
      expect(()=>value.supervisor.getRun(hardeningChildRunId(value.consent.consentHash))).toThrow();value.supervisor.close();rmSync(value.root,{recursive:true,force:true});}
    const replay=await hardeningConsentFixture("run-hardening-child-lineage-tamper");const child=(await replay.supervisor.createOptionalHardeningChildForOwner(replay.run.userId,replay.run.runId,{consentId:replay.consent.consentId,consentHash:replay.consent.consentHash})).child;
    const db=new Database(replay.dbPath);db.exec("DROP TRIGGER prevent_engineer_run_lineage_update_v23");db.query("UPDATE engineer_run_lineage SET root_run_id=? WHERE child_run_id=?").run(child.childRunId,child.childRunId);db.close();
    await expect(replay.supervisor.createOptionalHardeningChildForOwner(replay.run.userId,replay.run.runId,{consentId:replay.consent.consentId,consentHash:replay.consent.consentHash})).rejects.toThrow("authority");
    replay.supervisor.close();rmSync(replay.root,{recursive:true,force:true});

    for(const mode of ["CHILD_REQUEST","CHILD_BUDGET","CHILD_STATE"] as const){const value=await hardeningConsentFixture(`run-hardening-child-replay-${mode.toLowerCase()}`);
      const request={consentId:value.consent.consentId,consentHash:value.consent.consentHash};const child=(await value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,request)).child;
      const tamperDb=new Database(value.dbPath);
      if(mode==="CHILD_REQUEST")tamperDb.query("UPDATE engineer_runs SET request_normalized='{}' WHERE id=?").run(child.childRunId);
      if(mode==="CHILD_BUDGET")tamperDb.query("UPDATE run_budgets SET used_tokens=1 WHERE run_id=?").run(child.childRunId);
      if(mode==="CHILD_STATE")tamperDb.query("UPDATE engineer_runs SET state='PLANNING' WHERE id=?").run(child.childRunId);
      tamperDb.close();
      await expect(value.supervisor.createOptionalHardeningChildForOwner(value.run.userId,value.run.runId,request)).rejects.toThrow("authority");
      value.supervisor.close();rmSync(value.root,{recursive:true,force:true});}
  });

  test("two database connections converge on one checkpoint promotion", async () => {
    const value = promotionFixture("run-checkpoint-race");
    const second = createEngineerSupervisor({ dbPath: value.dbPath, now: () => new Date(timestamp) });
    const results = await Promise.all([
      value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion),
      second.promoteVerifiedCandidate(value.promotion, value.run.stateVersion),
    ]);
    expect(results.map((result) => result.applied).sort()).toEqual([false, true]);
    expect(results[0]!.checkpoint).toEqual(results[1]!.checkpoint);
    expect(value.supervisor.exportRunRecords(value.promotion.runId).verified_candidate_checkpoints).toHaveLength(1);
    second.close();
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("a failure after checkpoint insertion rolls back both checkpoint and transition", async () => {
    const value = promotionFixture("run-checkpoint-rollback");
    const db = new Database(value.dbPath);
    db.exec(`CREATE TRIGGER fail_checkpoint_transition_for_test
      BEFORE INSERT ON run_state_events WHEN NEW.reason_code = 'VERIFIED_CANDIDATE_PROMOTED'
      BEGIN SELECT RAISE(ABORT, 'injected transition failure'); END;`);
    db.close();
    await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion))
      .rejects.toThrow("injected transition failure");
    expect(value.supervisor.getRun(value.promotion.runId)).toMatchObject({ state: "REVIEWING", stateVersion: value.run.stateVersion });
    const records = value.supervisor.exportRunRecords(value.promotion.runId);
    expect(records.verified_candidate_checkpoints).toHaveLength(0);
    expect(records.advisory_backlog_items).toHaveLength(0);
    expect((records.audit_events ?? []).filter((event) => event.action === "ADVISORY_BACKLOG_MATERIALIZED")).toHaveLength(0);
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("applied promotion performs strict post-commit rehydration before acknowledging success", async () => {
    const value = promotionFixture("run-checkpoint-postcommit-seam");
    let verificationCalls = 0;
    const seamAttestor: CheckpointAttestor = {
      ...checkpointAttestor,
      verify: (payload, signature) => {
        verificationCalls += 1;
        if (verificationCalls === 2) writeFileSync(value.builderArtifact.storageReference, "postcommit tamper");
        return signature === `test:${sha256(payload)}`;
      },
    };
    await expect(value.supervisor.promoteVerifiedCandidate(
      { ...value.promotion, attestor: seamAttestor }, value.run.stateVersion,
    )).rejects.toThrow("Builder output bytes");
    expect(value.supervisor.getRun(value.promotion.runId).state).toBe("REVIEW_APPROVED");
    expect(value.supervisor.exportRunRecords(value.promotion.runId).verified_candidate_checkpoints).toHaveLength(1);
    await expect(value.supervisor.getVerifiedCandidateCheckpoint(
      { runId: value.promotion.runId }, checkpointAttestor,
    )).rejects.toThrow("Builder output bytes");
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("promotion rejects non-ready classification and every changed durable authority set", async () => {
    const blocked = setup("run-checkpoint-blocked");
    const blockedSupervisor = createEngineerSupervisor({ dbPath: blocked.dbPath, now: () => new Date(timestamp) });
    blockedSupervisor.recordClassifiedReviewerSession(blocked.session, [blocked.finding], blocked.batch, blocked.authority);
    await expect(blockedSupervisor.promoteVerifiedCandidate({
      runId: blocked.session.runId, reviewerSessionId: blocked.session.reviewerSessionId,
      classificationHash: blocked.batch.classificationHash, evidenceBundleId: "missing",
      attestor: checkpointAttestor,
    }, blockedSupervisor.getRun(blocked.session.runId).stateVersion)).rejects.toThrow("classification authority mismatch");
    blockedSupervisor.close();
    rmSync(blocked.root, { recursive: true, force: true });

    for (const mode of ["claims", "environment", "bundle-hash", "newer-test", "dispatch"] as const) {
      const value = promotionFixture(`run-checkpoint-binding-${mode}`);
      const db = new Database(value.dbPath);
      if (mode === "claims") {
        db.query(`INSERT INTO claim_evidence
          (id, run_id, criterion_id, claim, status, evidence_ids_json, notes, created_at)
          VALUES (?, ?, NULL, 'extra', 'UNVERIFIED', '[]', '', ?)`).run("extra-claim", value.promotion.runId, timestamp);
      } else if (mode === "environment") {
        db.query("UPDATE evidence_bundles SET environment_digest = ? WHERE id = ?")
          .run(sha256("wrong-environment"), value.promotion.evidenceBundleId);
      } else if (mode === "bundle-hash") {
        db.query("UPDATE evidence_bundles SET bundle_hash = ? WHERE id = ?")
          .run(sha256("wrong-bundle"), value.promotion.evidenceBundleId);
      } else if (mode === "newer-test") {
        db.query(`INSERT INTO test_executions
          (id, run_id, command_execution_id, type, verification_pass, random_seed, status, started_at, completed_at)
          VALUES ('newer-verification', ?, 'command-1', 'UNIT', 2, NULL, 'PASSED', ?, ?)`)
          .run(value.promotion.runId, timestamp, timestamp);
        db.query(`INSERT INTO audit_events
          (id, run_id, action, actor_type, actor_id, details_json, created_at)
          VALUES ('newer-verification-audit', ?, 'VERIFICATION_EXECUTED', 'EXECUTOR', 'executor-1', ?, ?)`).run(
            value.promotion.runId,
            canonicalJson({ verificationExecutionId: "newer-verification", testId: "test-1", criterionIds: ["must-1"], commandExecutionId: "command-1", type: "UNIT", status: "PASSED" }),
            offsetFuture,
          );
      } else {
        db.query(`INSERT INTO agent_executions
          (id, run_id, role, model_tier, status, input_hash, output_artifact_id, started_at, completed_at)
          VALUES ('orphan-builder', ?, 'BUILDER', 'GPT-5.6_TERRA', 'FAILED', ?, NULL, ?, ?)`)
          .run(value.promotion.runId, sha256("orphan"), timestamp, timestamp);
      }
      db.close();
      await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion)).rejects.toThrow();
      expect(value.supervisor.exportRunRecords(value.promotion.runId).verified_candidate_checkpoints).toHaveLength(0);
      value.supervisor.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("promotion rejects empty Builder coverage and candidates without a successful Builder", async () => {
    for (const mode of ["empty", "all-failed"] as const) {
      const value = promotionFixture(`run-checkpoint-builder-${mode}`);
      const db = new Database(value.dbPath);
      if (mode === "empty") {
        db.exec("DROP TRIGGER prevent_builder_dispatch_claims_delete_v20");
        db.query("DELETE FROM builder_dispatch_claims WHERE run_id = ?").run(value.promotion.runId);
        db.query("DELETE FROM agent_executions WHERE run_id = ? AND role = 'BUILDER'").run(value.promotion.runId);
      } else {
        db.query(`UPDATE agent_executions SET status = 'FAILED', output_artifact_id = NULL
          WHERE run_id = ? AND role = 'BUILDER'`).run(value.promotion.runId);
      }
      db.close();
      await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion)).rejects.toThrow();
      expect(value.supervisor.exportRunRecords(value.promotion.runId).verified_candidate_checkpoints).toHaveLength(0);
      value.supervisor.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  // Builds 13 independent full-P5 fixtures, each on its own database. The v34
  // tenancy migration adds a one-time additive-ALTER cost (~140ms) to every
  // fresh database build, so this loop-of-fixtures test needs a wider timeout.
  test("promotion and strict reads reject every invalid successful Builder output binding", async () => {
    const modes = [
      "zero", "type", "producer", "trusted", "symlink", "hash", "size", "completion",
      "completion-after-classification", "result-completion-mismatch",
      "artifact-created-after-classification", "artifact-created-before-start", "coordinated-artifact-time",
    ] as const;
    const corrupt = (value: ReturnType<typeof promotionFixture>, mode: typeof modes[number]) => {
      const db = new Database(value.dbPath);
      if (mode === "zero") {
        writeFileSync(value.builderArtifact.storageReference, "");
      } else if (mode === "type") {
        db.query("UPDATE artifacts SET type = 'UNRELATED' WHERE id = ?").run(value.builderArtifact.artifactId);
      } else if (mode === "producer") {
        db.query("UPDATE artifacts SET producer_id = 'wrong-producer' WHERE id = ?").run(value.builderArtifact.artifactId);
      } else if (mode === "trusted") {
        db.query("UPDATE artifacts SET trusted = 1 WHERE id = ?").run(value.builderArtifact.artifactId);
      } else if (mode === "symlink") {
        const target = join(value.root, "builder-symlink-target");
        writeFileSync(target, "replacement");
        rmSync(value.builderArtifact.storageReference);
        symlinkSync(target, value.builderArtifact.storageReference);
      } else if (mode === "hash") {
        db.query("UPDATE artifacts SET sha256 = ? WHERE id = ?").run(sha256("wrong"), value.builderArtifact.artifactId);
      } else if (mode === "size") {
        db.query("UPDATE artifacts SET size_bytes = size_bytes + 1 WHERE id = ?").run(value.builderArtifact.artifactId);
      } else if (mode === "completion") {
        db.query("UPDATE agent_executions SET completed_at = NULL WHERE id = ?")
          .run(`${value.promotion.runId}-builder`);
      } else if (mode === "completion-after-classification") {
        db.query("UPDATE agent_executions SET completed_at = ? WHERE id = ?")
          .run(offsetFuture, `${value.promotion.runId}-builder`);
      } else if (mode === "result-completion-mismatch") {
        const payload = JSON.parse(readFileSync(value.builderArtifact.storageReference, "utf8")) as Record<string, unknown>;
        const earlier = "2026-07-17T17:59:59.000Z";
        payload.completedAt = earlier;
        const bytes = canonicalJson(payload);
        writeFileSync(value.builderArtifact.storageReference, bytes);
        db.query("UPDATE agent_executions SET started_at = ? WHERE id = ?")
          .run(earlier, `${value.promotion.runId}-builder`);
        db.query("UPDATE artifacts SET sha256 = ?, size_bytes = ? WHERE id = ?")
          .run(sha256(bytes), Buffer.byteLength(bytes), value.builderArtifact.artifactId);
      } else if (mode === "artifact-created-after-classification") {
        db.query("UPDATE artifacts SET created_at = ? WHERE id = ?")
          .run(offsetFuture, value.builderArtifact.artifactId);
      } else if (mode === "artifact-created-before-start") {
        db.query("UPDATE artifacts SET created_at = '2026-07-17T17:59:59.000Z' WHERE id = ?")
          .run(value.builderArtifact.artifactId);
      } else {
        const earlier = "2026-07-17T17:59:59.000Z";
        db.query("UPDATE agent_executions SET started_at = ? WHERE id = ?")
          .run(earlier, `${value.promotion.runId}-builder`);
        db.query("UPDATE artifacts SET created_at = ? WHERE id = ?")
          .run(earlier, value.builderArtifact.artifactId);
      }
      db.close();
    };
    for (const stage of ["promotion", "strict-read"] as const) {
      for (const mode of modes) {
        const value = promotionFixture(`run-builder-output-${stage}-${mode}`);
        if (stage === "promotion") {
          corrupt(value, mode);
          await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion)).rejects.toThrow();
        } else {
          const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
          corrupt(value, mode);
          await expect(value.supervisor.getVerifiedCandidateCheckpoint(
            { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
          )).rejects.toThrow();
        }
        value.supervisor.close();
        rmSync(value.root, { recursive: true, force: true });
      }
    }
  }, 20_000);

  test("promotion and strict reads require one canonical executor-authored verification audit", async () => {
    const modes = ["actor-type", "actor-id", "noncanonical", "extra", "test-id", "criteria", "command", "type", "status", "timestamp"] as const;
    const corrupt = (value: ReturnType<typeof promotionFixture>, mode: typeof modes[number]) => {
      const db = new Database(value.dbPath);
      if (mode === "actor-type") db.query("UPDATE audit_events SET actor_type = 'SYSTEM' WHERE id = 'verification-audit'").run();
      else if (mode === "actor-id") db.query("UPDATE audit_events SET actor_id = 'wrong-executor' WHERE id = 'verification-audit'").run();
      else if (mode === "timestamp") db.query("UPDATE audit_events SET created_at = ? WHERE id = 'verification-audit'").run(offsetFuture);
      else {
        const row = db.query("SELECT details_json FROM audit_events WHERE id = 'verification-audit'").get() as { details_json: string };
        const details = JSON.parse(row.details_json) as Record<string, unknown>;
        if (mode === "noncanonical") {
          db.query("UPDATE audit_events SET details_json = ? WHERE id = 'verification-audit'").run(JSON.stringify(details, null, 2));
          db.close();
          return;
        }
        if (mode === "extra") details.extra = true;
        else if (mode === "test-id") details.testId = "wrong-test";
        else if (mode === "criteria") details.criterionIds = ["wrong-criterion"];
        else if (mode === "command") details.commandExecutionId = "wrong-command";
        else if (mode === "type") details.type = "SECURITY";
        else details.status = "FAILED";
        db.query("UPDATE audit_events SET details_json = ? WHERE id = 'verification-audit'").run(canonicalJson(details));
      }
      db.close();
    };
    for (const stage of ["promotion", "strict-read"] as const) {
      for (const mode of modes) {
        const value = promotionFixture(`run-audit-${stage}-${mode}`);
        if (stage === "promotion") {
          corrupt(value, mode);
          await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion)).rejects.toThrow();
        } else {
          const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
          corrupt(value, mode);
          await expect(value.supervisor.getVerifiedCandidateCheckpoint(
            { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
          )).rejects.toThrow();
        }
        value.supervisor.close();
        rmSync(value.root, { recursive: true, force: true });
      }
    }
  }, 20_000);

  test("strict checkpoint reads fail closed on immutable-row and signature tampering", async () => {
    const value = promotionFixture("run-checkpoint-tamper");
    const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const immutable = new Database(value.dbPath);
    expect(() => immutable.query("UPDATE verified_candidate_checkpoints SET signature = 'forged' WHERE id = ?")
      .run(promoted.checkpoint.checkpointId)).toThrow("immutable");
    immutable.exec("DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21");
    immutable.query("UPDATE verified_candidate_checkpoints SET signature = 'forged' WHERE id = ?")
      .run(promoted.checkpoint.checkpointId);
    immutable.close();
    await expect(value.supervisor.getVerifiedCandidateCheckpoint(
      { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
    )).rejects.toThrow("signature verification failed");
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("run checkpoint lookup distinguishes no promotion from a missing promoted row", async () => {
    const absent = promotionFixture("run-checkpoint-not-promoted");
    expect(await absent.supervisor.getVerifiedCandidateCheckpoint(
      { runId: absent.promotion.runId }, checkpointAttestor,
    )).toBeNull();
    absent.supervisor.close();
    rmSync(absent.root, { recursive: true, force: true });

    const missing = promotionFixture("run-checkpoint-row-missing");
    const promoted = await missing.supervisor.promoteVerifiedCandidate(missing.promotion, missing.run.stateVersion);
    const adversarial = new Database(missing.dbPath);
    adversarial.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER prevent_verified_candidate_checkpoints_delete_v21;");
    adversarial.query("DELETE FROM verified_candidate_checkpoints WHERE id = ?").run(promoted.checkpoint.checkpointId);
    adversarial.close();
    await expect(missing.supervisor.getVerifiedCandidateCheckpoint(
      { runId: missing.promotion.runId }, checkpointAttestor,
    )).rejects.toBeInstanceOf(VerifiedCandidateIntegrityError);
    // Direct unknown-ID lookup intentionally retains nullable probe semantics.
    expect(await missing.supervisor.getVerifiedCandidateCheckpoint(
      { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
    )).toBeNull();
    missing.supervisor.close();
    rmSync(missing.root, { recursive: true, force: true });
  });

  test("run state history is immutable and a legitimate later transition preserves checkpoint readability", async () => {
    const value = promotionFixture("run-checkpoint-event-immutable");
    const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const db = new Database(value.dbPath);
    expect(() => db.query("UPDATE run_state_events SET actor_id = 'forged' WHERE event_id = ?")
      .run(promoted.checkpoint.checkpointId)).toThrow("immutable");
    expect(() => db.query("DELETE FROM run_state_events WHERE event_id = ?")
      .run(promoted.checkpoint.checkpointId)).toThrow("immutable");
    db.close();
    const approved = value.supervisor.getRun(value.promotion.runId);
    value.supervisor.transition({
      runId: approved.runId, expectedStateVersion: approved.stateVersion,
      nextState: "HUMAN_APPROVAL_PENDING", reasonCode: "HUMAN_GATE_REQUIRED",
      manifestHash: approved.manifestHash, idempotencyKey: `${approved.runId}:human-pending`,
    });
    expect(await value.supervisor.getVerifiedCandidateCheckpoint(
      { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
    )).toEqual({ checkpoint: promoted.checkpoint, attestation: promoted.attestation });
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("strict reads reject predecessor, gap, and durable run-head corruption", async () => {
    for (const mode of ["shift-promotion", "run-version", "run-state", "missing-predecessor", "predecessor-state", "missing-head", "forged-head"] as const) {
      const value = promotionFixture(`run-checkpoint-chain-${mode}`);
      const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
      const db = new Database(value.dbPath);
      db.exec("DROP TRIGGER prevent_run_state_events_update_v21; DROP TRIGGER prevent_run_state_events_delete_v21;");
      const promotion = db.query("SELECT sequence FROM run_state_events WHERE event_id = ?")
        .get(promoted.checkpoint.checkpointId) as { sequence: number };
      if (mode === "shift-promotion") {
        db.query("UPDATE run_state_events SET sequence = sequence + 1, state_version = state_version + 1 WHERE event_id = ?")
          .run(promoted.checkpoint.checkpointId);
        db.query("UPDATE engineer_runs SET state_version = state_version + 1 WHERE id = ?").run(value.promotion.runId);
      } else if (mode === "run-version") {
        db.query("UPDATE engineer_runs SET state_version = state_version + 1 WHERE id = ?").run(value.promotion.runId);
      } else if (mode === "run-state") {
        db.query("UPDATE engineer_runs SET state = 'HUMAN_APPROVAL_PENDING' WHERE id = ?").run(value.promotion.runId);
      } else if (mode === "missing-predecessor") {
        db.query("DELETE FROM run_state_events WHERE run_id = ? AND sequence = ?")
          .run(value.promotion.runId, promotion.sequence - 1);
      } else if (mode === "predecessor-state") {
        db.query("UPDATE run_state_events SET next_state = 'IMPLEMENTING' WHERE run_id = ? AND sequence = ?")
          .run(value.promotion.runId, promotion.sequence - 1);
      } else if (mode === "missing-head") {
        db.query("DELETE FROM run_state_events WHERE event_id = ?").run(promoted.checkpoint.checkpointId);
      } else {
        db.query(`INSERT INTO run_state_events
          (event_id, run_id, sequence, previous_state, next_state, reason_code, actor_type, actor_id,
           timestamp, evidence_ids_json, manifest_hash, state_version, idempotency_key)
          VALUES ('forged-head', ?, ?, 'IMPLEMENTING', 'HUMAN_APPROVAL_PENDING', 'FORGED_HEAD',
            'SUPERVISOR', 'forged', ?, '[]', ?, ?, 'forged-head')`)
          .run(value.promotion.runId, promotion.sequence + 1, offsetFuture, promoted.checkpoint.manifestHash, promotion.sequence + 1);
        db.query("UPDATE engineer_runs SET state = 'HUMAN_APPROVAL_PENDING', state_version = state_version + 1 WHERE id = ?")
          .run(value.promotion.runId);
      }
      db.close();
      await expect(value.supervisor.getVerifiedCandidateCheckpoint(
        { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
      )).rejects.toThrow("transition authority");
      value.supervisor.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("signed pre-promotion chain rejects semantic mutation of every earlier event authority field", async () => {
    for (const mode of ["actor", "reason", "evidence", "timestamp", "idempotency"] as const) {
      const value = promotionFixture(`run-checkpoint-prefix-${mode}`);
      const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
      expect(promoted.checkpoint.prePromotionEventChainSummary.headSequence + 1)
        .toBe(value.supervisor.listEvents(value.promotion.runId).find((event) => event.eventId === promoted.checkpoint.checkpointId)!.sequence);
      const db = new Database(value.dbPath);
      db.exec("DROP TRIGGER prevent_run_state_events_update_v21; DROP TRIGGER prevent_run_state_events_delete_v21;");
      if (mode === "actor") db.query("UPDATE run_state_events SET actor_id = 'semantic-tamper' WHERE run_id = ? AND sequence = 1").run(value.promotion.runId);
      else if (mode === "reason") db.query("UPDATE run_state_events SET reason_code = 'SEMANTIC_TAMPER' WHERE run_id = ? AND sequence = 1").run(value.promotion.runId);
      else if (mode === "evidence") db.query("UPDATE run_state_events SET evidence_ids_json = '[\"semantic-tamper\"]' WHERE run_id = ? AND sequence = 1").run(value.promotion.runId);
      else if (mode === "timestamp") db.query("UPDATE run_state_events SET timestamp = '2026-07-17T17:59:59.000Z' WHERE run_id = ? AND sequence = 1").run(value.promotion.runId);
      else db.query("UPDATE run_state_events SET idempotency_key = 'semantic-tamper' WHERE run_id = ? AND sequence = 1").run(value.promotion.runId);
      db.close();
      await expect(value.supervisor.getVerifiedCandidateCheckpoint(
        { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
      )).rejects.toThrow("pre-promotion event chain");
      value.supervisor.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("strict reads reject coordinated Builder and verification provenance rewrites", async () => {
    for (const mode of ["builder-bytes", "command", "audit-id", "stdout-producer"] as const) {
      const value = promotionFixture(`run-checkpoint-provenance-${mode}`);
      const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
      const db = new Database(value.dbPath);
      if (mode === "builder-bytes") {
        const payload = JSON.parse(readFileSync(value.builderArtifact.storageReference, "utf8"));
        const bytes = `${JSON.stringify(payload, null, 2)}\n`;
        writeFileSync(value.builderArtifact.storageReference, bytes);
        db.query("UPDATE artifacts SET sha256 = ?, size_bytes = ? WHERE id = ?")
          .run(sha256(bytes), Buffer.byteLength(bytes), value.builderArtifact.artifactId);
      } else if (mode === "command") {
        db.query("UPDATE command_executions SET idempotency_key = 'coordinated-command-rewrite' WHERE id = 'command-1'").run();
      } else if (mode === "audit-id") {
        db.query("UPDATE audit_events SET id = 'coordinated-verification-audit' WHERE id = 'verification-audit'").run();
      } else {
        const command = db.query("SELECT stdout_artifact_id FROM command_executions WHERE id = 'command-1'")
          .get() as { stdout_artifact_id: string };
        db.query("UPDATE artifacts SET producer_id = 'coordinated-producer' WHERE id = ?").run(command.stdout_artifact_id);
      }
      db.close();
      await expect(value.supervisor.getVerifiedCandidateCheckpoint(
        { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
      )).rejects.toThrow();
      value.supervisor.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("promotion rejects verification authority completed after classification", async () => {
    const value = promotionFixture("run-checkpoint-verification-cutoff");
    const db = new Database(value.dbPath);
    db.query("UPDATE command_executions SET started_at = ?, finished_at = ? WHERE id = 'command-1'")
      .run(offsetFuture, offsetFuture);
    db.query("UPDATE test_executions SET started_at = ?, completed_at = ? WHERE id = 'verification-1'")
      .run(offsetFuture, offsetFuture);
    db.query("UPDATE audit_events SET created_at = ? WHERE id = 'verification-audit'").run(offsetFuture);
    db.close();
    await expect(value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion)).rejects.toThrow();
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("strict reads preserve historical authority across later advisories but require canonical checkpoint bytes", async () => {
    const historical = promotionFixture("run-checkpoint-read-historical");
    const historicalPromotion = await historical.supervisor.promoteVerifiedCandidate(historical.promotion, historical.run.stateVersion);
    const historicalDb = new Database(historical.dbPath);
    historicalDb.query(`INSERT INTO security_findings
      (id, run_id, severity, category, description, file, line_start, line_end,
       evidence_ids_json, status, created_at)
      VALUES ('post-checkpoint-finding', ?, 'LOW', 'AI_ADVISORY_POST_CHECKPOINT', 'later advisory', NULL, NULL, NULL,
        '[]', 'OPEN', ?)`).run(historical.promotion.runId, offsetFuture);
    historicalDb.query(`INSERT INTO claim_evidence
      (id, run_id, criterion_id, claim, status, evidence_ids_json, notes, created_at)
      VALUES ('post-checkpoint-claim', ?, NULL, 'later note', 'UNVERIFIED', '[]', 'advisory only', ?)`)
      .run(historical.promotion.runId, offsetFuture);
    historicalDb.query(`INSERT INTO test_executions
      (id, run_id, command_execution_id, type, verification_pass, random_seed, status, started_at, completed_at)
      VALUES ('post-checkpoint-test', ?, 'command-1', 'UNIT', 2, NULL, 'PASSED', ?, ?)`)
      .run(historical.promotion.runId, offsetFuture, offsetFuture);
    historicalDb.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES ('post-checkpoint-test-audit', ?, 'VERIFICATION_EXECUTED', 'EXECUTOR', 'executor-1', ?, ?)`)
      .run(historical.promotion.runId, canonicalJson({
        verificationExecutionId: "post-checkpoint-test", testId: "test-1", criterionIds: ["must-1"],
        commandExecutionId: "command-1", type: "UNIT", status: "PASSED",
      }), offsetFuture);
    historicalDb.close();
    const laterBuilder = {
      agentExecutionId: "post-checkpoint-builder", runId: historical.promotion.runId, role: "BUILDER" as const,
      modelTier: "GPT-5.6_TERRA" as const, status: "RUNNING" as const, inputHash: sha256("later-builder"),
      outputArtifactId: null, startedAt: offsetFuture, completedAt: null,
    };
    historical.supervisor.claimBuilderDispatch(laterBuilder);
    historical.supervisor.recordAgentExecution({ ...laterBuilder, status: "FAILED", completedAt: offsetFuture });
    expect(await historical.supervisor.getVerifiedCandidateCheckpoint(
      { checkpointId: historicalPromotion.checkpoint.checkpointId }, checkpointAttestor,
    )).toEqual({ checkpoint: historicalPromotion.checkpoint, attestation: historicalPromotion.attestation });
    historical.supervisor.close();
    rmSync(historical.root, { recursive: true, force: true });

    const canonical = promotionFixture("run-checkpoint-read-canonical");
    const canonicalPromotion = await canonical.supervisor.promoteVerifiedCandidate(canonical.promotion, canonical.run.stateVersion);
    const canonicalDb = new Database(canonical.dbPath);
    canonicalDb.exec("DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21");
    canonicalDb.query("UPDATE verified_candidate_checkpoints SET checkpoint_json = ' ' || checkpoint_json WHERE id = ?")
      .run(canonicalPromotion.checkpoint.checkpointId);
    canonicalDb.close();
    await expect(canonical.supervisor.getVerifiedCandidateCheckpoint(
      { checkpointId: canonicalPromotion.checkpoint.checkpointId }, checkpointAttestor,
    )).rejects.toThrow();
    canonical.supervisor.close();
    rmSync(canonical.root, { recursive: true, force: true });
  });

  test("strict reads reject every mutable promotion-event authority field", async () => {
    for (const mode of ["event-id", "sequence", "previous", "actor", "timestamp", "manifest", "version", "idempotency"] as const) {
      const value = promotionFixture(`run-checkpoint-event-${mode}`);
      const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
      const db = new Database(value.dbPath);
      db.exec("DROP TRIGGER prevent_run_state_events_update_v21");
      if (mode === "event-id") {
        db.query("UPDATE run_state_events SET event_id = 'tampered-promotion-event' WHERE event_id = ?")
          .run(promoted.checkpoint.checkpointId);
      } else if (mode === "sequence") {
        db.query("UPDATE run_state_events SET sequence = sequence + 1 WHERE event_id = ?").run(promoted.checkpoint.checkpointId);
      } else if (mode === "previous") {
        db.query("UPDATE run_state_events SET previous_state = 'IMPLEMENTING' WHERE event_id = ?").run(promoted.checkpoint.checkpointId);
      } else if (mode === "actor") {
        db.query("UPDATE run_state_events SET actor_id = 'tampered-supervisor' WHERE event_id = ?").run(promoted.checkpoint.checkpointId);
      } else if (mode === "timestamp") {
        db.query("UPDATE run_state_events SET timestamp = ? WHERE event_id = ?").run(offsetFuture, promoted.checkpoint.checkpointId);
      } else if (mode === "manifest") {
        db.query("UPDATE run_state_events SET manifest_hash = ? WHERE event_id = ?")
          .run(sha256("tampered-manifest"), promoted.checkpoint.checkpointId);
      } else if (mode === "version") {
        db.query("UPDATE run_state_events SET state_version = state_version + 1 WHERE event_id = ?").run(promoted.checkpoint.checkpointId);
      } else {
        db.query("UPDATE run_state_events SET idempotency_key = 'tampered-promotion-key' WHERE event_id = ?")
          .run(promoted.checkpoint.checkpointId);
      }
      db.close();
      await expect(value.supervisor.getVerifiedCandidateCheckpoint(
        { checkpointId: promoted.checkpoint.checkpointId }, checkpointAttestor,
      )).rejects.toThrow("transition authority");
      value.supervisor.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("checkpoint-bound approvals use exact rehydration and decision compare-and-swap", async () => {
    const value = promotionFixture("run-checkpoint-approval-cas");
    const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const checkpoint = promoted.checkpoint;
    const approval = (approvalRequestId: string) => ({
      approvalRequestId, runId: checkpoint.runId, riskTier: value.frozen.riskTier,
      assignedReviewerId: "reviewer@example.test", requestedAt: timestamp, deadlineAt: offsetFuture,
      reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED" as const,
      manifestHash: checkpoint.manifestHash, diffHash: checkpoint.diffHash,
      evidenceBundleHash: checkpoint.evidenceBundleHash, reviewerSessionId: checkpoint.reviewerSessionId,
      classificationHash: checkpoint.classificationHash, classificationResult: checkpoint.classificationResult,
      status: "PENDING" as const, approvalRevision: 0 as const, verifiedCheckpointId: checkpoint.checkpointId,
      verifiedCheckpointHash: checkpoint.checkpointHash,
    });
    await expect(value.supervisor.recordApprovalRequest({
      ...approval("approval-tuple-mismatch"), diffHash: sha256("wrong-diff"),
    }, checkpointAttestor)).rejects.toThrow("tuple does not match");
    await expect(Promise.resolve().then(() => value.supervisor.recordApprovalRequest({
      ...approval("approval-preapproved"), status: "APPROVED",
    } as never, checkpointAttestor))).rejects.toThrow();
    expect(value.supervisor.latestApprovalRequest(checkpoint.runId)).toBeNull();

    const auditDb = new Database(value.dbPath);
    auditDb.exec(`CREATE TRIGGER fail_approval_audit_for_test BEFORE INSERT ON audit_events
      WHEN NEW.action = 'HUMAN_APPROVAL_REQUESTED'
      BEGIN SELECT RAISE(ABORT, 'forced approval audit failure'); END`);
    auditDb.close();
    await expect(value.supervisor.recordApprovalRequest(approval("approval-audit-rollback"), checkpointAttestor))
      .rejects.toThrow("forced approval audit failure");
    const auditCheck = new Database(value.dbPath);
    expect(auditCheck.query("SELECT COUNT(*) AS count FROM approval_requests WHERE id = 'approval-audit-rollback'").get())
      .toEqual({ count: 0 });
    auditCheck.exec("DROP TRIGGER fail_approval_audit_for_test");
    auditCheck.close();

    const request = await value.supervisor.recordApprovalRequest(approval("approval-cas"), checkpointAttestor);
    expect(request).toMatchObject({
      verifiedCheckpointId: checkpoint.checkpointId, verifiedCheckpointHash: checkpoint.checkpointHash,
    });
    const second = createEngineerSupervisor({ dbPath: value.dbPath, now: () => new Date(timestamp) });
    const decision = (id: string, actorId: string, decision: "APPROVE" | "REJECT" | "EXTEND" = "APPROVE") => ({
      approvalDecisionId: id, approvalRequestId: request.approvalRequestId, actorId, decision,
      reason: `${decision} decision`, decidedAt: timestamp,
      expectedVerifiedCheckpointId: checkpoint.checkpointId,
      expectedVerifiedCheckpointHash: checkpoint.checkpointHash,
      expectedApprovalRevision: 0,
    });
    const candidates = [decision("decision-a", "human-a"), decision("decision-b", "human-b", "REJECT")];
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => value.supervisor.decideApproval(candidates[0]!, "APPROVED")),
      Promise.resolve().then(() => second.decideApproval(candidates[1]!, "REJECTED")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const stored = value.supervisor.exportRunRecords(checkpoint.runId).approval_decisions as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    const winner = candidates.find((candidate) => candidate.approvalDecisionId === stored[0]!.id)!;
    expect(value.supervisor.listApprovalDecisions(request.approvalRequestId)).toEqual([winner]);
    expect(value.supervisor.decideApproval(winner, winner.decision === "APPROVE" ? "APPROVED" : "REJECTED")).toEqual(winner);
    expect(() => value.supervisor.decideApproval({ ...winner, reason: "changed replay" }, "APPROVED"))
      .toThrow(IdempotencyConflictError);

    const wrongRequest = await value.supervisor.recordApprovalRequest(approval("approval-wrong-pair"), checkpointAttestor);
    const wrongDecision = {
      ...decision("decision-wrong-pair", "human-wrong"), approvalRequestId: wrongRequest.approvalRequestId,
      expectedVerifiedCheckpointHash: sha256("stale-checkpoint"),
    };
    expect(() => value.supervisor.decideApproval(wrongDecision, "APPROVED")).toThrow();
    expect((value.supervisor.exportRunRecords(checkpoint.runId).approval_decisions as unknown[])).toHaveLength(1);
    expect(value.supervisor.latestApprovalRequest(checkpoint.runId)?.status).toBe("PENDING");

    const lostRequest = await value.supervisor.recordApprovalRequest(approval("approval-cas-lost"), checkpointAttestor);
    const lossDb = new Database(value.dbPath);
    lossDb.exec(`CREATE TRIGGER force_approval_cas_loss_for_test AFTER INSERT ON approval_decisions
      WHEN NEW.id = 'decision-cas-loss'
      BEGIN
        UPDATE approval_requests SET status = 'CANCELLED' WHERE id = NEW.approval_request_id;
      END`);
    lossDb.close();
    const lostDecision = {
      ...decision("decision-cas-loss", "human-loss"), approvalRequestId: lostRequest.approvalRequestId,
    };
    expect(() => value.supervisor.decideApproval(lostDecision, "APPROVED"))
      .toThrow(IdempotencyConflictError);
    const lossCheck = new Database(value.dbPath, { readonly: true });
    expect(lossCheck.query("SELECT status FROM approval_requests WHERE id = ?").get(lostRequest.approvalRequestId))
      .toEqual({ status: "PENDING" });
    expect(lossCheck.query("SELECT COUNT(*) AS count FROM approval_decisions WHERE id = ?").get(lostDecision.approvalDecisionId))
      .toEqual({ count: 0 });
    lossCheck.close();

    const extension = {
      ...decision("decision-extend", "human-extend", "EXTEND"), approvalRequestId: lostRequest.approvalRequestId,
    };
    const extended = value.supervisor.extendApproval(extension, "2031-01-01T00:00:00.000Z", []);
    expect(extended.deadlineAt).toBe("2031-01-01T00:00:00.000Z");
    expect(value.supervisor.extendApproval(extension, "2031-01-01T00:00:00.000Z", [])).toEqual(extended);
    expect(() => value.supervisor.extendApproval(extension, "2032-01-01T00:00:00.000Z", []))
      .toThrow(IdempotencyConflictError);
    const expiry = {
      ...decision("decision-expire", "engineer-supervisor", "REJECT"), approvalRequestId: lostRequest.approvalRequestId,
      reason: "Approval deadline expired.", expectedApprovalRevision: 1,
    };
    const lateSupervisor = createEngineerSupervisor({ dbPath: value.dbPath, now: () => new Date("2032-01-01T00:00:00.000Z") });
    expect(lateSupervisor.decideApproval(expiry, "EXPIRED")).toEqual(expiry);
    expect(value.supervisor.latestApprovalRequest(checkpoint.runId)?.status).toBe("EXPIRED");
    expect(() => value.supervisor.decideApproval(expiry, "REJECTED")).toThrow(IdempotencyConflictError);
    const rejected = {
      ...decision("decision-rejected-outcome", "human-reject", "REJECT"),
      approvalRequestId: wrongRequest.approvalRequestId,
    };
    expect(value.supervisor.decideApproval(rejected, "REJECTED")).toEqual(rejected);
    expect(() => value.supervisor.decideApproval(rejected, "EXPIRED")).toThrow(IdempotencyConflictError);

    const legacyDb = new Database(value.dbPath);
    legacyDb.exec("DROP TRIGGER require_new_approval_checkpoint_v22");
    legacyDb.query(`INSERT INTO approval_requests
      (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
       reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash,
       status, reviewer_session_id, classification_hash, classification_result)
      VALUES ('legacy-approval-c4-2', ?, 'LOW', NULL, ?, ?, '[]', 'PAUSE', ?, ?, ?,
       'PENDING', ?, ?, 'READY')`).run(
      checkpoint.runId, timestamp, offsetFuture, checkpoint.manifestHash, checkpoint.diffHash,
      checkpoint.evidenceBundleHash, checkpoint.reviewerSessionId, checkpoint.classificationHash,
    );
    legacyDb.exec(`CREATE TRIGGER require_new_approval_checkpoint_v22
      BEFORE INSERT ON approval_requests
      WHEN NEW.verified_checkpoint_id IS NULL OR NEW.verified_checkpoint_hash IS NULL
        OR NEW.approval_revision != 0 BEGIN
        SELECT RAISE(ABORT, 'new approval request requires verified checkpoint authority');
      END;`);
    legacyDb.close();
    const legacyDecision = {
      ...decision("legacy-decision-c4-2", "human-legacy"), approvalRequestId: "legacy-approval-c4-2",
    };
    expect(() => value.supervisor.decideApproval(legacyDecision, "APPROVED"))
      .toThrow("legacy approval request");
    expect(() => value.supervisor.extendApproval({ ...legacyDecision, decision: "EXTEND" }, offsetFuture, []))
      .toThrow("legacy approval request");
    const afterLegacy = value.supervisor.exportRunRecords(checkpoint.runId).approval_decisions as Array<Record<string, unknown>>;
    expect(afterLegacy.some((row) => row.approval_request_id === "legacy-approval-c4-2")).toBe(false);

    const deadlineRequest = await value.supervisor.recordApprovalRequest(
      approval("approval-deadline-crossed"), checkpointAttestor,
    );
    const deadlineDecision = {
      ...decision("decision-after-deadline", "human-late"),
      approvalRequestId: deadlineRequest.approvalRequestId,
    };
    expect(() => lateSupervisor.decideApproval(deadlineDecision, "APPROVED"))
      .toThrow(IdempotencyConflictError);
    expect(value.supervisor.latestApprovalRequest(checkpoint.runId)).toMatchObject({
      approvalRequestId: deadlineRequest.approvalRequestId,
      status: "PENDING",
      approvalRevision: 0,
    });
    expect((value.supervisor.exportRunRecords(checkpoint.runId).approval_decisions as Array<Record<string, unknown>>)
      .some((row) => row.id === deadlineDecision.approvalDecisionId)).toBe(false);

    const racingRequest = await value.supervisor.recordApprovalRequest(
      approval("approval-extension-race"), checkpointAttestor,
    );
    const extensionCandidates = [
      {
        ...decision("decision-extension-race-a", "human-a", "EXTEND"),
        approvalRequestId: racingRequest.approvalRequestId,
      },
      {
        ...decision("decision-extension-race-b", "human-b", "EXTEND"),
        approvalRequestId: racingRequest.approvalRequestId,
      },
    ];
    const extensionOutcomes = await raceApprovalExtensions({
      dbPath: value.dbPath,
      now: timestamp,
      candidates: [
        { decision: extensionCandidates[0]!, deadlineAt: "2031-02-01T00:00:00.000Z" },
        { decision: extensionCandidates[1]!, deadlineAt: "2031-03-01T00:00:00.000Z" },
      ],
    });
    expect(extensionOutcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(extensionOutcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    const extensionWinner = extensionOutcomes.find((outcome) => outcome.ok)?.value;
    expect(extensionWinner).toMatchObject({
      status: "PENDING",
      approvalRevision: 1,
    });
    const afterExtensionRace = value.supervisor.latestApprovalRequest(checkpoint.runId)!;
    expect(afterExtensionRace).toMatchObject({
      approvalRequestId: racingRequest.approvalRequestId,
      status: "PENDING",
      approvalRevision: 1,
    });
    expect(["2031-02-01T00:00:00.000Z", "2031-03-01T00:00:00.000Z"])
      .toContain(afterExtensionRace.deadlineAt);

    const staleExpiry = {
      ...decision("decision-stale-expiry", "engineer-supervisor", "REJECT"),
      approvalRequestId: racingRequest.approvalRequestId,
      reason: "Approval deadline expired.",
    };
    expect(() => lateSupervisor.decideApproval(staleExpiry, "EXPIRED"))
      .toThrow(IdempotencyConflictError);
    const staleBrowserApproval = {
      ...decision("decision-stale-browser", "human-browser"),
      approvalRequestId: racingRequest.approvalRequestId,
    };
    expect(() => value.supervisor.decideApproval(staleBrowserApproval, "APPROVED"))
      .toThrow(IdempotencyConflictError);
    expect(value.supervisor.latestApprovalRequest(checkpoint.runId)).toEqual(afterExtensionRace);
    const raceDecisions = value.supervisor.exportRunRecords(checkpoint.runId).approval_decisions as Array<Record<string, unknown>>;
    expect(raceDecisions.filter((row) => row.approval_request_id === racingRequest.approvalRequestId)).toHaveLength(1);
    second.close();
    lateSupervisor.close();
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("Git operation persistence and replay are bound to the exact checkpoint pair", async () => {
    const value = promotionFixture("run-checkpoint-git-operation-c45");
    const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const checkpoint = promoted.checkpoint;
    const gitOperation: NewGitOperationRecord = {
      gitOperationId: "git-checkpoint-c45",
      runId: checkpoint.runId,
      operationType: "CREATE_BRANCH",
      requestedBy: "SUPERVISOR",
      idempotencyKey: `git:branch:${checkpoint.runId}:${checkpoint.checkpointHash.slice("sha256:".length)}:${checkpoint.resultCommitSha}`,
      expectedBaseCommitSha: checkpoint.baseCommitSha,
      resultCommitSha: checkpoint.resultCommitSha,
      approvalId: null,
      evidenceBundleHash: checkpoint.evidenceBundleHash,
      status: "STARTED",
      remoteReference: null,
      startedAt: timestamp,
      completedAt: null,
      errorCode: null,
      verifiedCheckpointId: checkpoint.checkpointId,
      verifiedCheckpointHash: checkpoint.checkpointHash,
    };
    expect(value.supervisor.recordGitOperation(gitOperation)).toEqual(gitOperation);
    expect(value.supervisor.findGitOperation(checkpoint.runId, gitOperation.idempotencyKey)).toEqual(gitOperation);
    const completedOperation: NewGitOperationRecord = {
      ...gitOperation,
      status: "SUCCEEDED",
      remoteReference: "refs/heads/zintus/engineer/run-checkpoint-git-operation-c45",
      completedAt: offsetFuture,
    };
    expect(value.supervisor.recordGitOperation(completedOperation)).toEqual(completedOperation);
    expect(value.supervisor.findGitOperation(checkpoint.runId, gitOperation.idempotencyKey)).toEqual(completedOperation);
    expect(() => value.supervisor.recordGitOperation({
      ...gitOperation,
      verifiedCheckpointHash: sha256("conflicting-checkpoint-pair"),
    })).toThrow(IdempotencyConflictError);
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("approval creation rechecks REVIEW_APPROVED after asynchronous attestation", async () => {
    const value = promotionFixture("run-checkpoint-approval-state-race");
    const promoted = await value.supervisor.promoteVerifiedCandidate(value.promotion, value.run.stateVersion);
    const checkpoint = promoted.checkpoint;
    let signalVerification!: () => void;
    let releaseVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { signalVerification = resolve; });
    const verificationRelease = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const delayedAttestor: CheckpointAttestor = {
      ...checkpointAttestor,
      async verify(payload, signature) {
        signalVerification();
        await verificationRelease;
        return checkpointAttestor.verify(payload, signature);
      },
    };
    const replayable: NewApprovalRequestRecord = {
      approvalRequestId: "approval-before-state-race", runId: checkpoint.runId, riskTier: value.frozen.riskTier,
      assignedReviewerId: "reviewer@example.test", requestedAt: timestamp, deadlineAt: offsetFuture,
      reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED",
      manifestHash: checkpoint.manifestHash, diffHash: checkpoint.diffHash,
      evidenceBundleHash: checkpoint.evidenceBundleHash, reviewerSessionId: checkpoint.reviewerSessionId,
      classificationHash: checkpoint.classificationHash, classificationResult: checkpoint.classificationResult,
      status: "PENDING", verifiedCheckpointId: checkpoint.checkpointId,
      verifiedCheckpointHash: checkpoint.checkpointHash, approvalRevision: 0,
    };
    expect(await value.supervisor.recordApprovalRequest(replayable, checkpointAttestor)).toEqual(replayable);
    const pending = value.supervisor.recordApprovalRequest({
      ...replayable, approvalRequestId: "approval-state-race",
    }, delayedAttestor);
    await verificationStarted;
    const current = value.supervisor.getRun(checkpoint.runId);
    value.supervisor.transition({
      runId: checkpoint.runId, expectedStateVersion: current.stateVersion,
      nextState: "HUMAN_APPROVAL_PENDING", reasonCode: "TEST_APPROVAL_STATE_RACE",
      actorType: "SUPERVISOR", actorId: "race-test", manifestHash: checkpoint.manifestHash,
      evidenceIds: [], idempotencyKey: "approval-state-race-transition",
    });
    releaseVerification();
    await expect(pending).rejects.toThrow("no longer REVIEW_APPROVED");
    expect(await value.supervisor.recordApprovalRequest(replayable, checkpointAttestor)).toEqual(replayable);
    await expect(value.supervisor.recordApprovalRequest({ ...replayable, assignedReviewerId: "changed@example.test" }, checkpointAttestor))
      .rejects.toThrow(IdempotencyConflictError);
    expect(value.supervisor.latestApprovalRequest(checkpoint.runId)).toEqual(replayable);
    value.supervisor.close();
    rmSync(value.root, { recursive: true, force: true });
  });
});
