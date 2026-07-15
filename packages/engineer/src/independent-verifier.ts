import { randomUUID } from "node:crypto";
import type { TaskManifest, TrustedEvidence } from "./contracts.js";
import { TrustedEvidenceSchema } from "./contracts.js";
import { FailureRecordSchema, type FailureRecord } from "./control-contracts.js";
import type { ArtifactRecord, CommandExecutionRecord } from "./execution-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import { sha256 } from "./hash.js";
import { assessRepeatedTest } from "./hardening.js";
import type { EngineerSupervisor } from "./supervisor.js";
import type { TrustedCommandExecutor } from "./trusted-executor.js";
import {
  buildVerificationCoverageMatrix,
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
  beforeCommand?: (command: string) => string | Promise<string>;
  afterCommand?: (command: string, beforeSnapshot: string) => void | Promise<void>;
}

export interface IndependentVerificationOutput {
  executions: VerificationExecutionRecord[];
  securityFindings: SecurityFindingRecord[];
  trustedEvidence: TrustedEvidence[];
  securityReportArtifact: ArtifactRecord;
}

/**
 * A deterministic, repository-fixable failure of a frozen MUST check.
 *
 * The verifier deliberately does not change workflow state for this error. The
 * verification manager is the retry authority: it can grant a bounded Builder
 * repair or fail closed when that budget is exhausted.
 */
export class StableRequiredTestFailure extends Error {
  readonly test: TestPlanItem;
  readonly requiredCriterionIds: string[];
  readonly executions: VerificationExecutionRecord[];
  readonly evidence: TrustedEvidence[];
  readonly failureFingerprint: string;

  constructor(input: {
    test: TestPlanItem;
    requiredCriterionIds: string[];
    executions: VerificationExecutionRecord[];
    evidence: TrustedEvidence[];
  }) {
    super(`stable required verification failed for ${input.test.testId}`);
    this.name = "StableRequiredTestFailure";
    this.test = input.test;
    this.requiredCriterionIds = [...input.requiredCriterionIds];
    this.executions = [...input.executions];
    this.evidence = [...input.evidence];
    this.failureFingerprint = sha256({
      policyVersion: VERIFICATION_POLICY_VERSION,
      classification: "STABLE_FAIL",
      testId: input.test.testId,
      type: input.test.type,
      command: input.test.command,
      requiredCriterionIds: [...input.requiredCriterionIds].sort(),
    });
  }
}

/** A deterministic terminal classification that can be summarized, but never overridden, by LUNA. */
export class IndependentVerificationFailure extends Error {
  readonly failureClass: FailureRecord["failureClass"];
  readonly reasonCode: string;
  readonly evidenceIds: string[];
  readonly details: Record<string, unknown>;

  constructor(input: {
    failureClass: FailureRecord["failureClass"];
    reasonCode: string;
    evidenceIds: string[];
    details: Record<string, unknown>;
    message: string;
  }) {
    super(input.message);
    this.name = "IndependentVerificationFailure";
    this.failureClass = input.failureClass;
    this.reasonCode = input.reasonCode;
    this.evidenceIds = [...input.evidenceIds];
    this.details = { ...input.details };
  }
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

  async run(): Promise<IndependentVerificationOutput> {
    const executions: VerificationExecutionRecord[] = [];
    const trustedEvidence: TrustedEvidence[] = [];
    const coverageMatrix = buildVerificationCoverageMatrix(this.options.manifest);
    const coverageArtifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId: this.options.manifest.runId,
      type: "VERIFICATION_COVERAGE_MATRIX",
      bytes: JSON.stringify(coverageMatrix),
      producerType: "SYSTEM",
      producerId: "verification-coverage-policy",
      trusted: true,
    }));
    const coverageEvidence = TrustedEvidenceSchema.parse({
      evidenceId: coverageArtifact.artifactId,
      runId: this.options.manifest.runId,
      eventType: "VERIFICATION_COVERAGE_MATRIX",
      producerType: "SYSTEM",
      producerId: "verification-coverage-policy",
      sha256: coverageArtifact.sha256,
      payload: coverageMatrix,
      createdAt: coverageArtifact.createdAt,
    });
    trustedEvidence.push(coverageEvidence);
    if (!coverageMatrix.allPlanItemsExecutable || !coverageMatrix.securityGateCovered || !coverageMatrix.allMustCriteriaCovered) {
      const uncoveredCriterionIds = coverageMatrix.criteria
        .filter((criterion) => criterion.priority === "MUST" && criterion.status === "UNCOVERED")
        .map((criterion) => criterion.criterionId);
      const reasonCode = !coverageMatrix.allPlanItemsExecutable
        ? "NON_EXECUTABLE_VERIFICATION_PLAN_ITEM"
        : !coverageMatrix.securityGateCovered
          ? "MANDATORY_SECURITY_GATE_MISSING"
          : "MANDATORY_VERIFICATION_COVERAGE_GAP";
      const failureClass = reasonCode === "MANDATORY_SECURITY_GATE_MISSING" ? "SECURITY_FAILURE" : "TEST_FAILURE";
      this.recordFailure(failureClass, reasonCode, [coverageArtifact.artifactId], false, {
        matrixHash: coverageMatrix.matrixHash,
        uncoveredCriterionIds,
        nonExecutableTestIds: coverageMatrix.nonExecutableTestIds,
        executableSecurityTestIds: coverageMatrix.executableSecurityTestIds,
      });
      const nextState = reasonCode === "MANDATORY_SECURITY_GATE_MISSING" ? "SECURITY_ESCALATION" : "VERIFICATION_INCOMPLETE";
      this.transition(nextState, reasonCode, [coverageArtifact.artifactId]);
      throw new IndependentVerificationFailure({
        failureClass,
        reasonCode,
        evidenceIds: [coverageArtifact.artifactId],
        details: { uncoveredCriterionIds, nonExecutableTestIds: coverageMatrix.nonExecutableTestIds },
        message: `verification plan rejected: ${reasonCode}`,
      });
    }
    for (let groupIndex = 0; groupIndex < GROUPS.length; groupIndex += 1) {
      const group = GROUPS[groupIndex]!;
      const items = this.options.manifest.testPlan.filter((item) => group.types.has(item.type));
      if (group.state === "E2E_TESTING" && items.length === 0) continue;
      this.ensureState(group.state);
      for (const item of items) {
        const result = await this.runItem(item, 1);
        executions.push(result.execution);
        trustedEvidence.push(result.evidence);
        if (result.execution.status !== "PASSED") {
          const repeated = [result];
          for (let attempt = 2; attempt <= 3; attempt += 1) {
            const confirmation = await this.runItem(item, attempt);
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
          const requiredCriterionIds = item.criterionIds.filter((criterionId) =>
            this.options.manifest.acceptanceCriteria.some(
              (criterion) => criterion.criterionId === criterionId && criterion.priority === "MUST",
            ),
          );
          if (
            flake.classification === "STABLE_FAIL" &&
            repeated.every((attempt) => attempt.execution.status === "FAILED") &&
            requiredCriterionIds.length > 0
          ) {
            throw new StableRequiredTestFailure({
              test: item,
              requiredCriterionIds,
              executions: repeated.map((attempt) => attempt.execution),
              evidence: repeated.map((attempt) => attempt.evidence),
            });
          }
          const reasonCode = flake.quarantineRequired ? "FLAKY_TEST_QUARANTINED" : "INDEPENDENT_VERIFICATION_FAILED";
          const evidenceIds = repeated.map((attempt) => attempt.evidence.evidenceId);
          const statuses = repeated.map((attempt) => attempt.execution.status);
          const failureClass = statuses.includes("BLOCKED") ? "SANDBOX_FAILURE" : "TEST_FAILURE";
          const failureReason = statuses.includes("BLOCKED")
            ? "INDEPENDENT_TEST_COMMAND_BLOCKED"
            : statuses.includes("TIMED_OUT")
              ? "INDEPENDENT_TEST_TIMED_OUT"
              : reasonCode;
          this.recordFailure(failureClass, failureReason, evidenceIds, false, {
            testId: item.testId, type: item.type, statuses,
            classification: flake.classification, quarantineRequired: flake.quarantineRequired,
          });
          this.transition("VERIFICATION_INCOMPLETE", reasonCode, evidenceIds);
          throw new IndependentVerificationFailure({
            failureClass,
            reasonCode: failureReason,
            evidenceIds,
            details: { testId: item.testId, statuses, classification: flake.classification },
            message: `independent verification failed for ${item.testId}: ${result.execution.status}`,
          });
        }
      }
    }
    this.ensureState("SECURITY_REVIEW");
    for (const item of this.options.manifest.testPlan.filter((candidate) => candidate.type === "SECURITY")) {
      const result = await this.runItem(item, 1);
      executions.push(result.execution);
      trustedEvidence.push(result.evidence);
      if (result.execution.status !== "PASSED") {
        const failureClass = result.execution.status === "BLOCKED" ? "SANDBOX_FAILURE" : "SECURITY_FAILURE";
        const reasonCode = result.execution.status === "BLOCKED"
          ? "INDEPENDENT_SECURITY_COMMAND_BLOCKED"
          : result.execution.status === "TIMED_OUT"
            ? "INDEPENDENT_SECURITY_CHECK_TIMED_OUT"
            : "INDEPENDENT_SECURITY_CHECK_FAILED";
        this.recordFailure(failureClass, reasonCode, [result.evidence.evidenceId], false, {
          testId: item.testId, status: result.execution.status,
        });
        this.transition("SECURITY_ESCALATION", reasonCode, [result.evidence.evidenceId]);
        throw new IndependentVerificationFailure({
          failureClass,
          reasonCode,
          evidenceIds: [result.evidence.evidenceId],
          details: { testId: item.testId, status: result.execution.status },
          message: `independent security check failed for ${item.testId}: ${result.execution.status}`,
        });
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
    if (securityFindings.some((finding) => finding.severity === "HIGH" || finding.severity === "CRITICAL")) {
      this.recordFailure("SECURITY_FAILURE", "HIGH_OR_CRITICAL_SECURITY_FINDING", [securityReportArtifact.artifactId], false, {
        reportSha256: securityReportArtifact.sha256,
        blockingFindingIds: securityFindings
          .filter((finding) => finding.severity === "HIGH" || finding.severity === "CRITICAL")
          .map((finding) => finding.securityFindingId)
          .sort(),
      });
      this.transition("SECURITY_ESCALATION", "HIGH_OR_CRITICAL_SECURITY_FINDING", [securityReportArtifact.artifactId]);
      throw new IndependentVerificationFailure({
        failureClass: "SECURITY_FAILURE",
        reasonCode: "HIGH_OR_CRITICAL_SECURITY_FINDING",
        evidenceIds: [securityReportArtifact.artifactId],
        details: { reportSha256: securityReportArtifact.sha256 },
        message: "high or critical deterministic security finding blocks review",
      });
    }
    return { executions, securityFindings, trustedEvidence, securityReportArtifact };
  }

  private async runItem(item: TestPlanItem, repeatAttempt: number): Promise<{ execution: VerificationExecutionRecord; evidence: TrustedEvidence; command: CommandExecutionRecord }> {
    if (!item.command) throw new Error(`test plan item ${item.testId} has no executable command`);
    const beforeSnapshot = await this.options.beforeCommand?.(item.command);
    let command: CommandExecutionRecord;
    try {
      command = await this.options.executor.executeAsync(
        item.command,
        `verify:${this.options.verificationPass ?? 1}:${item.testId}:${repeatAttempt}:${sha256(item).slice(7, 23)}`,
      );
    } finally {
      if (beforeSnapshot !== undefined) await this.options.afterCommand?.(item.command, beforeSnapshot);
    }
    const execution = this.options.supervisor.recordVerificationExecution(VerificationExecutionRecordSchema.parse({
      verificationExecutionId: (this.options.idFactory ?? randomUUID)(),
      runId: this.options.manifest.runId,
      verificationPass: this.options.verificationPass ?? 1,
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
      { category: "TLS_VERIFICATION_DISABLED", severity: "CRITICAL" as const, pattern: /^\+.*(?:rejectUnauthorized|verify)\s*[:=]\s*false\b/i,
        description: "A newly added line disables transport certificate verification." },
      { category: "COOKIE_SECURITY_DISABLED", severity: "HIGH" as const, pattern: /^\+.*(?:httpOnly|secure)\s*:\s*false\b/i,
        description: "A newly added line disables a cookie security control." },
    ];
    const negativeConstraints = [
      { category: "AUTHENTICATION_CONTROL_REMOVED", pattern: /\b(?:authenticate|requireAuth|verifyToken|verifySession|currentUser)\b/i,
        description: "The diff removes an authentication control without a replacement in the same file." },
      { category: "AUTHORIZATION_CONTROL_REMOVED", pattern: /\b(?:authorize|requirePermission|hasPermission|canAccess|enforceRbac)\b/i,
        description: "The diff removes an authorization control without a replacement in the same file." },
      { category: "INPUT_VALIDATION_REMOVED", pattern: /\b(?:safeParse|validate|sanitize|escapeHtml)\s*\(/i,
        description: "The diff removes input validation or sanitization without a replacement in the same file." },
      { category: "CSRF_CONTROL_REMOVED", pattern: /\b(?:csrf|sameSite|originCheck)\b/i,
        description: "The diff removes a request-forgery control without a replacement in the same file." },
    ];
    const findings: SecurityFindingRecord[] = [];
    const changedLines = new Map<string, { added: string[]; removed: string[] }>();
    let file: string | null = null;
    let newLine = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) file = line.slice(6);
      else if (line.startsWith("@@")) {
        const match = /\+(\d+)/.exec(line);
        newLine = match ? Number(match[1]) - 1 : 0;
      } else if (newLine > 0 && (line.startsWith("+") && !line.startsWith("+++") || line.startsWith(" "))) {
        // Only hunk additions and context lines advance the new-file line.
        // Diff metadata (diff/index/---) must not skew finding locations.
        newLine += 1;
      }
      if (file && ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))) {
        const changes = changedLines.get(file) ?? { added: [], removed: [] };
        (line.startsWith("+") ? changes.added : changes.removed).push(line.slice(1));
        changedLines.set(file, changes);
      }
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
    for (const [changedFile, changes] of changedLines) {
      for (const constraint of negativeConstraints) {
        if (!changes.removed.some((line) => constraint.pattern.test(line))) continue;
        if (changes.added.some((line) => constraint.pattern.test(line))) continue;
        findings.push(SecurityFindingRecordSchema.parse({
          securityFindingId: (this.options.idFactory ?? randomUUID)(),
          runId: this.options.manifest.runId,
          severity: "HIGH",
          category: constraint.category,
          description: constraint.description,
          file: changedFile,
          lineStart: null,
          lineEnd: null,
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

  private recordFailure(
    failureClass: FailureRecord["failureClass"],
    reasonCode: string,
    evidenceIds: string[],
    retryable: boolean,
    fingerprintSource: unknown,
  ): void {
    this.options.supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: (this.options.idFactory ?? randomUUID)(),
      runId: this.options.manifest.runId,
      failureClass,
      reasonCode,
      fingerprint: sha256({ policyVersion: VERIFICATION_POLICY_VERSION, failureClass, reasonCode, fingerprintSource }),
      evidenceIds,
      retryable,
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
    }));
  }
}
