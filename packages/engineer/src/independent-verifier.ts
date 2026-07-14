import { randomUUID } from "node:crypto";
import type { TaskManifest, TrustedEvidence } from "./contracts.js";
import { TrustedEvidenceSchema } from "./contracts.js";
import type { ArtifactRecord, CommandExecutionRecord } from "./execution-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import { sha256 } from "./hash.js";
import { assessRepeatedTest } from "./hardening.js";
import type { EngineerSupervisor } from "./supervisor.js";
import type { TrustedCommandExecutor } from "./trusted-executor.js";
import {
  SecurityFindingRecordSchema,
  VerificationExecutionRecordSchema,
  type SecurityFindingRecord,
  type VerificationExecutionRecord,
} from "./verification-contracts.js";

export const VERIFICATION_POLICY_VERSION = "engineer-verification-v1";
export const SECURITY_POLICY_VERSION = "engineer-security-v1";

type TestPlanItem = TaskManifest["testPlan"][number];

export interface IndependentVerifierOptions {
  supervisor: EngineerSupervisor;
  artifactStore: LocalArtifactStore;
  manifest: TaskManifest;
  executor: TrustedCommandExecutor;
  diff: () => string;
  now?: () => Date;
  idFactory?: () => string;
  verificationPass?: number;
}

export interface IndependentVerificationOutput {
  executions: VerificationExecutionRecord[];
  securityFindings: SecurityFindingRecord[];
  trustedEvidence: TrustedEvidence[];
  securityReportArtifact: ArtifactRecord;
}

const GROUPS: ReadonlyArray<{
  state: "FAST_CHECKS" | "UNIT_TESTING" | "INTEGRATION_TESTING" | "E2E_TESTING";
  types: ReadonlySet<TestPlanItem["type"]>;
}> = [
  { state: "FAST_CHECKS", types: new Set(["FORMAT", "LINT", "TYPECHECK", "BUILD"]) },
  { state: "UNIT_TESTING", types: new Set(["UNIT"]) },
  { state: "INTEGRATION_TESTING", types: new Set(["INTEGRATION", "MIGRATION", "REGRESSION"]) },
  { state: "E2E_TESTING", types: new Set(["E2E"]) },
];

function verificationStatus(command: CommandExecutionRecord): VerificationExecutionRecord["status"] {
  if (command.status === "SUCCEEDED") return "PASSED";
  if (command.status === "TIMED_OUT") return "TIMED_OUT";
  if (command.status === "SPAWN_FAILED") return "BLOCKED";
  return "FAILED";
}

/** Runs frozen-manifest commands independently of Builder-requested commands. */
export class IndependentVerifier {
  private readonly options: IndependentVerifierOptions;

  constructor(options: IndependentVerifierOptions) {
    this.options = options;
  }

  run(): IndependentVerificationOutput {
    const executions: VerificationExecutionRecord[] = [];
    const trustedEvidence: TrustedEvidence[] = [];
    for (let groupIndex = 0; groupIndex < GROUPS.length; groupIndex += 1) {
      const group = GROUPS[groupIndex]!;
      const items = this.options.manifest.testPlan.filter((item) => group.types.has(item.type));
      if (group.state === "E2E_TESTING" && items.length === 0) continue;
      this.ensureState(group.state);
      for (const item of items) {
        const result = this.runItem(item, 1);
        executions.push(result.execution);
        trustedEvidence.push(result.evidence);
        if (result.execution.status !== "PASSED") {
          const repeated = [result];
          for (let attempt = 2; attempt <= 3; attempt += 1) {
            const confirmation = this.runItem(item, attempt);
            repeated.push(confirmation);
            executions.push(confirmation.execution);
            trustedEvidence.push(confirmation.evidence);
          }
          const flake = assessRepeatedTest(repeated.map((attempt, index) => ({
            attempt: index + 1,
            passed: attempt.execution.status === "PASSED",
            commitSha: attempt.command.commitSha,
            environmentDigest: attempt.command.environmentDigest,
          })));
          const reasonCode = flake.quarantineRequired ? "FLAKY_TEST_QUARANTINED" : "INDEPENDENT_VERIFICATION_FAILED";
          this.transition("VERIFICATION_INCOMPLETE", reasonCode, repeated.map((attempt) => attempt.evidence.evidenceId));
          throw new Error(`independent verification failed for ${item.testId}: ${result.execution.status}`);
        }
      }
    }
    this.ensureState("SECURITY_REVIEW");
    for (const item of this.options.manifest.testPlan.filter((candidate) => candidate.type === "SECURITY")) {
      const result = this.runItem(item, 1);
      executions.push(result.execution);
      trustedEvidence.push(result.evidence);
      if (result.execution.status !== "PASSED") {
        this.transition("SECURITY_ESCALATION", "INDEPENDENT_SECURITY_CHECK_FAILED", [result.evidence.evidenceId]);
        throw new Error(`independent security check failed for ${item.testId}: ${result.execution.status}`);
      }
    }
    const securityFindings = this.scanDiff(this.options.diff());
    for (const finding of securityFindings) this.options.supervisor.recordSecurityFinding(finding);
    const report = {
      policyVersion: SECURITY_POLICY_VERSION,
      runId: this.options.manifest.runId,
      diffHash: sha256(this.options.diff()),
      findings: securityFindings,
    };
    const securityReportArtifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId: this.options.manifest.runId,
      type: "SECURITY_REPORT",
      bytes: JSON.stringify(report),
      producerType: "SYSTEM",
      producerId: "deterministic-security-scanner",
      trusted: true,
    }));
    trustedEvidence.push(TrustedEvidenceSchema.parse({
      evidenceId: securityReportArtifact.artifactId,
      runId: this.options.manifest.runId,
      eventType: "SECURITY_REPORT",
      producerType: "SYSTEM",
      producerId: "deterministic-security-scanner",
      sha256: securityReportArtifact.sha256,
      payload: report,
      createdAt: securityReportArtifact.createdAt,
    }));
    if (securityFindings.some((finding) => finding.severity === "CRITICAL")) {
      this.transition("SECURITY_ESCALATION", "CRITICAL_SECURITY_FINDING", [securityReportArtifact.artifactId]);
      throw new Error("critical deterministic security finding blocks review");
    }
    return { executions, securityFindings, trustedEvidence, securityReportArtifact };
  }

  private runItem(item: TestPlanItem, repeatAttempt: number): { execution: VerificationExecutionRecord; evidence: TrustedEvidence; command: CommandExecutionRecord } {
    if (!item.command) throw new Error(`test plan item ${item.testId} has no executable command`);
    const command = this.options.executor.execute(
      item.command,
      `verify:${this.options.verificationPass ?? 1}:${item.testId}:${repeatAttempt}:${sha256(item).slice(7, 23)}`,
    );
    const execution = this.options.supervisor.recordVerificationExecution(VerificationExecutionRecordSchema.parse({
      verificationExecutionId: (this.options.idFactory ?? randomUUID)(),
      runId: this.options.manifest.runId,
      testId: item.testId,
      commandExecutionId: command.commandExecutionId,
      criterionIds: item.criterionIds,
      type: item.type,
      randomSeed: null,
      status: verificationStatus(command),
      startedAt: command.startedAt,
      completedAt: command.finishedAt,
    }));
    const payload = {
      policyVersion: VERIFICATION_POLICY_VERSION,
      testId: item.testId,
      criterionIds: item.criterionIds,
      type: item.type,
      command: command.command,
      commandExecutionId: command.commandExecutionId,
      status: command.status,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      stdoutArtifact: { artifactId: command.stdoutArtifact.artifactId, sha256: command.stdoutArtifact.sha256 },
      stderrArtifact: { artifactId: command.stderrArtifact.artifactId, sha256: command.stderrArtifact.sha256 },
      environmentDigest: command.environmentDigest,
      commitSha: command.commitSha,
    };
    return {
      execution,
      command,
      evidence: TrustedEvidenceSchema.parse({
        evidenceId: execution.verificationExecutionId,
        runId: this.options.manifest.runId,
        eventType: "INDEPENDENT_VERIFICATION",
        producerType: "EXECUTOR",
        producerId: command.executorId,
        sha256: sha256(payload),
        payload,
        createdAt: execution.completedAt,
      }),
    };
  }

  private scanDiff(diff: string): SecurityFindingRecord[] {
    const rules = [
      { category: "POSSIBLE_SECRET", severity: "CRITICAL" as const, pattern: /^\+.*(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i,
        description: "A newly added line appears to contain a hard-coded credential." },
      { category: "UNSAFE_EVAL", severity: "HIGH" as const, pattern: /^\+.*\beval\s*\(/,
        description: "A newly added line invokes eval()." },
      { category: "SHELL_EXECUTION", severity: "MEDIUM" as const, pattern: /^\+.*\b(?:exec|spawn)\s*\([^\n]*shell\s*:\s*true/,
        description: "A newly added process invocation enables a shell." },
    ];
    const findings: SecurityFindingRecord[] = [];
    let file: string | null = null;
    let newLine = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) file = line.slice(6);
      else if (line.startsWith("@@")) {
        const match = /\+(\d+)/.exec(line);
        newLine = match ? Number(match[1]) - 1 : 0;
      } else if (!line.startsWith("-")) newLine += 1;
      for (const rule of rules) {
        if (!rule.pattern.test(line)) continue;
        findings.push(SecurityFindingRecordSchema.parse({
          securityFindingId: (this.options.idFactory ?? randomUUID)(),
          runId: this.options.manifest.runId,
          severity: rule.severity,
          category: rule.category,
          description: rule.description,
          file,
          lineStart: newLine || null,
          lineEnd: newLine || null,
          evidenceIds: [],
          status: "OPEN",
          createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
        }));
      }
    }
    return findings;
  }

  private ensureState(target: "FAST_CHECKS" | "UNIT_TESTING" | "INTEGRATION_TESTING" | "E2E_TESTING" | "SECURITY_REVIEW"): void {
    let state = this.options.supervisor.getRun(this.options.manifest.runId).state;
    if (state === target) return;
    const path: Record<string, string> = {
      FAST_CHECKS: "UNIT_TESTING",
      UNIT_TESTING: "INTEGRATION_TESTING",
      INTEGRATION_TESTING: target === "E2E_TESTING" ? "E2E_TESTING" : "SECURITY_REVIEW",
      E2E_TESTING: "SECURITY_REVIEW",
    };
    while (state !== target) {
      const next = path[state];
      if (!next) throw new Error(`cannot advance verification state ${state} to ${target}`);
      this.transition(next as Parameters<EngineerSupervisor["transition"]>[0]["nextState"], `ENTER_${next}`);
      state = this.options.supervisor.getRun(this.options.manifest.runId).state;
    }
  }

  private transition(nextState: Parameters<EngineerSupervisor["transition"]>[0]["nextState"], reasonCode: string, evidenceIds: string[] = []): void {
    const run = this.options.supervisor.getRun(this.options.manifest.runId);
    this.options.supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState,
      reasonCode,
      evidenceIds,
      manifestHash: run.manifestHash,
      idempotencyKey: `phase3:${nextState.toLowerCase()}:${run.stateVersion + 1}`,
    });
  }
}
