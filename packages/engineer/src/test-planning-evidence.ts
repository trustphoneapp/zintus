import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./artifact-store.js";
import {
  CONTEXT_MAX_EXCERPT_CHARS,
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_MAX_RELEVANT_FILES,
  CONTEXT_MAX_SOURCE_FILES,
  ContextManifestContentSchema,
  ContextManifestSchema,
} from "./context-contracts.js";
import type { EngineerRun, TaskManifestContent } from "./contracts.js";
import { sha256 } from "./hash.js";
import { PlanProposalSchema, planProposalContentHash } from "./planning.js";
import type { EngineerSupervisor } from "./supervisor.js";

/** Test-only fixture that exercises the real artifact, context, proposal, and PLAN_READY guards. */
export function transitionToPlanReadyForTest(input: {
  supervisor: EngineerSupervisor;
  received: EngineerRun;
  normalizedRequest: string;
  manifest: TaskManifestContent;
  key: string;
  artifactRoot?: string;
}): EngineerRun {
  const { supervisor, received, normalizedRequest, manifest, key } = input;
  const store = new LocalArtifactStore({ root: input.artifactRoot ?? mkdtempSync(join(tmpdir(), "zintus-plan-evidence-")) });
  const contextContent = ContextManifestContentSchema.parse({
    contextVersion: 1,
    runId: received.runId,
    repositoryId: received.repository.repositoryId,
    baseCommitSha: received.repository.baseCommitSha,
    requestHash: sha256(received.requestOriginal),
    caps: {
      maxSourceFiles: CONTEXT_MAX_SOURCE_FILES,
      maxRelevantFiles: CONTEXT_MAX_RELEVANT_FILES,
      maxExcerptChars: CONTEXT_MAX_EXCERPT_CHARS,
      maxFileBytes: CONTEXT_MAX_FILE_BYTES,
    },
    filesDiscovered: 0,
    filesConsidered: 0,
    symlinksSkipped: 0,
    oversizedFilesSkipped: 0,
    binaryFilesSkipped: 0,
    sources: [],
    detections: {
      trust: "UNTRUSTED_REPOSITORY_CONTENT",
      stacks: [], scripts: [], ciCommands: [], configPaths: [], lockfilePaths: [], testPaths: [], ciPaths: [],
    },
    warnings: [],
  });
  const context = ContextManifestSchema.parse({ ...contextContent, manifestHash: sha256(contextContent) });
  const contextArtifact = supervisor.recordArtifact(store.put({
    runId: received.runId,
    type: "CONTEXT_MANIFEST",
    bytes: JSON.stringify(context),
    producerType: "SYSTEM",
    producerId: "test-fixture",
    trusted: true,
  }));
  supervisor.recordContextSnapshot({ manifest: context, artifactId: contextArtifact.artifactId, createdAt: manifest.createdAt });

  let run = supervisor.normalizeRequest({
    runId: received.runId,
    expectedStateVersion: received.stateVersion,
    normalizedRequest,
    idempotencyKey: `${key}:normalize`,
  }).run;
  run = supervisor.transition({
    runId: run.runId,
    expectedStateVersion: run.stateVersion,
    nextState: "PLANNING",
    reasonCode: "TEST_PLANNING_STARTED",
    idempotencyKey: `${key}:planning`,
  }).run;
  const planningAnalysis = { architectureSummary: "Test fixture", assumptions: [], unresolvedQuestions: [], touchedFileEstimates: [] };
  const proposalHash = planProposalContentHash({ manifest, planningAnalysis, contextManifestHash: context.manifestHash });
  const proposalArtifact = supervisor.recordArtifact(store.put({
    runId: run.runId,
    type: "PLAN_PROPOSAL",
    bytes: JSON.stringify({ proposalSchemaVersion: "plan-proposal-v2", plannerPolicyVersion: "engineer-planner-v1", manifest, planningAnalysis, contextManifestHash: context.manifestHash }),
    producerType: "SYSTEM",
    producerId: "test-fixture",
    trusted: true,
  }));
  supervisor.recordPlanProposal(PlanProposalSchema.parse({
    proposalSchemaVersion: "plan-proposal-v2",
    plannerPolicyVersion: "engineer-planner-v1",
    planProposalId: `${key}:proposal`,
    runId: run.runId,
    manifest,
    planningAnalysis,
    proposalHash,
    artifactId: proposalArtifact.artifactId,
    contextManifestHash: context.manifestHash,
    createdAt: manifest.createdAt,
  }));
  return supervisor.transition({
    runId: run.runId,
    expectedStateVersion: run.stateVersion,
    nextState: "PLAN_READY",
    reasonCode: "TEST_PLAN_READY",
    evidenceIds: [contextArtifact.artifactId, proposalArtifact.artifactId],
    idempotencyKey: `${key}:ready`,
  }).run;
}

/** Test-only replan fixture; reuses the frozen exact-base context but records new proposal evidence. */
export function transitionReplanToPlanReadyForTest(input: {
  supervisor: EngineerSupervisor;
  replanning: EngineerRun;
  manifest: TaskManifestContent;
  key: string;
  artifactRoot?: string;
}): EngineerRun {
  const { supervisor, replanning, manifest, key } = input;
  const context = supervisor.latestContextSnapshot(replanning.runId);
  if (!context) throw new Error("test replan fixture requires existing context");
  const store = new LocalArtifactStore({ root: input.artifactRoot ?? mkdtempSync(join(tmpdir(), "zintus-replan-evidence-")) });
  const planningAnalysis = { architectureSummary: "Test replan fixture", assumptions: [], unresolvedQuestions: [], touchedFileEstimates: [] };
  const proposalHash = planProposalContentHash({ manifest, planningAnalysis, contextManifestHash: context.manifest.manifestHash });
  const artifact = supervisor.recordArtifact(store.put({
    runId: replanning.runId,
    type: "PLAN_PROPOSAL",
    bytes: JSON.stringify({ proposalSchemaVersion: "plan-proposal-v2", plannerPolicyVersion: "engineer-planner-v1", manifest, planningAnalysis, contextManifestHash: context.manifest.manifestHash }),
    producerType: "SYSTEM",
    producerId: "test-fixture",
    trusted: true,
  }));
  supervisor.recordPlanProposal(PlanProposalSchema.parse({
    proposalSchemaVersion: "plan-proposal-v2",
    plannerPolicyVersion: "engineer-planner-v1",
    planProposalId: `${key}:proposal`,
    runId: replanning.runId,
    manifest,
    planningAnalysis,
    proposalHash,
    artifactId: artifact.artifactId,
    contextManifestHash: context.manifest.manifestHash,
    createdAt: manifest.createdAt,
  }));
  return supervisor.transition({
    runId: replanning.runId,
    expectedStateVersion: replanning.stateVersion,
    nextState: "PLAN_READY",
    reasonCode: "TEST_REPLAN_READY",
    evidenceIds: [context.artifactId, artifact.artifactId],
    manifestHash: replanning.manifestHash,
    idempotencyKey: `${key}:ready`,
  }).run;
}
