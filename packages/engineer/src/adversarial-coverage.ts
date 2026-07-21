import { z } from "zod";
import type { TaskManifest } from "./contracts.js";
import { sha256 } from "./hash.js";
import { AdversarialTestGapSchema, type TestAdvisory } from "./terra-advisors.js";

export const ADVERSARIAL_COVERAGE_POLICY_VERSION = "engineer-adversarial-coverage-v1";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const AdversarialCoverageGapSchema = AdversarialTestGapSchema.extend({
  criterionPriorities: z.array(z.enum(["MUST", "SHOULD", "MAY"])).min(1).max(20),
  blocking: z.boolean(),
}).strict();

export const AdversarialCoverageReportSchema = z.object({
  policyVersion: z.literal(ADVERSARIAL_COVERAGE_POLICY_VERSION),
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  advisoryHash: HashSchema,
  uncoveredCriterionIds: z.array(IdentifierSchema),
  warnings: z.array(z.string().min(1).max(10_000)),
  gaps: z.array(AdversarialCoverageGapSchema).max(12),
  blockingGapIds: z.array(IdentifierSchema).max(12),
  reportHash: HashSchema,
}).strict().superRefine((report, context) => {
  const { reportHash, ...content } = report;
  if (sha256(content) !== reportHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "adversarial coverage report hash mismatch", path: ["reportHash"] });
  }
  const expectedBlocking = report.gaps.filter((gap) => gap.blocking).map((gap) => gap.gapId);
  if (JSON.stringify(expectedBlocking) !== JSON.stringify(report.blockingGapIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "blocking gap summary does not match report gaps", path: ["blockingGapIds"] });
  }
});

export type AdversarialCoverageReport = z.infer<typeof AdversarialCoverageReportSchema>;

/**
 * Converts untrusted model advice into a bounded, manifest-grounded risk report.
 * The report proves only that a coverage risk was raised; it never certifies
 * behavior. A Tester-model suggestion is advisory even when it mentions a MUST
 * criterion: frozen requirements and deterministic test/scope/security evidence
 * are the only blocking authorities. Otherwise an unproven suggestion could
 * force a paid repair loop or make Reviewer output formatting a late failure.
 */
export function buildAdversarialCoverageReport(
  manifest: TaskManifest,
  advisory: TestAdvisory,
): AdversarialCoverageReport {
  const criteria = new Map(manifest.acceptanceCriteria.map((criterion) => [criterion.criterionId, criterion]));
  const gapIds = new Set<string>();
  const uncoveredIds = new Set<string>();
  const warnings = [...advisory.warnings];

  for (const criterionId of advisory.uncoveredCriterionIds) {
    if (!criteria.has(criterionId)) {
      warnings.push(`Ignored ungrounded uncovered criterion ${criterionId}.`);
      continue;
    }
    if (uncoveredIds.has(criterionId)) continue;
    uncoveredIds.add(criterionId);
  }

  const gaps = advisory.adversarialGaps.flatMap((gap) => {
    if (gapIds.has(gap.gapId)) {
      warnings.push(`Ignored repeated adversarial gap ${gap.gapId}.`);
      return [];
    }
    gapIds.add(gap.gapId);
    const groundedCriteria = gap.criterionIds.map((criterionId) => criteria.get(criterionId));
    if (groundedCriteria.some((criterion) => !criterion)) {
      warnings.push(`Ignored ungrounded adversarial gap ${gap.gapId}.`);
      return [];
    }
    const criterionPriorities = groundedCriteria.map((criterion) => criterion!.priority);
    return [AdversarialCoverageGapSchema.parse({
      ...gap,
      criterionPriorities,
      blocking: false,
    })];
  });

  for (const criterionId of uncoveredIds) {
    if (!gaps.some((gap) => gap.criterionIds.includes(criterionId))) {
      const criterion = criteria.get(criterionId)!;
      gaps.push(AdversarialCoverageGapSchema.parse({
        gapId: `uncovered-${sha256({ manifestHash: manifest.manifestHash, criterionId }).slice(7, 23)}`,
        criterionIds: [criterionId],
        criterionPriorities: [criterion.priority],
        invariant: criterion.statement,
        counterexample: "The current trusted executor evidence does not distinguish this acceptance criterion from an incomplete implementation.",
        expectedObservation: criterion.verificationMethod,
        recommendedTest: "Add a focused regression test that fails when this criterion is not fully implemented, then repair the implementation without weakening existing checks.",
        blocking: false,
      }));
    }
  }

  const content = {
    policyVersion: ADVERSARIAL_COVERAGE_POLICY_VERSION,
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    advisoryHash: sha256(advisory),
    uncoveredCriterionIds: [...uncoveredIds],
    warnings,
    gaps,
    blockingGapIds: gaps.filter((gap) => gap.blocking).map((gap) => gap.gapId),
  } as const;
  return AdversarialCoverageReportSchema.parse({ ...content, reportHash: sha256(content) });
}

export function blockingAdversarialGapsFromEvidence(
  evidence: readonly { evidenceId: string; eventType: string; payload: Record<string, unknown> }[],
): Array<{ gap: AdversarialCoverageReport["gaps"][number]; evidenceId: string }> {
  return evidence
    .filter((item) => item.eventType === "ADVERSARIAL_COVERAGE_REPORT")
    .flatMap((item) => {
      const report = AdversarialCoverageReportSchema.parse(item.payload);
      return report.gaps.filter((gap) => gap.blocking).map((gap) => ({ gap, evidenceId: item.evidenceId }));
    });
}
