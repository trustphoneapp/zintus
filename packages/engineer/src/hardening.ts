import { z } from "zod";

export const FLAKE_POLICY_VERSION = "engineer-flake-v1";

export const TestAttemptOutcomeSchema = z.object({
  attempt: z.number().int().positive(),
  passed: z.boolean(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i),
  environmentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type TestAttemptOutcome = z.infer<typeof TestAttemptOutcomeSchema>;

export interface FlakeDecision {
  classification: "INSUFFICIENT_EVIDENCE" | "STABLE_PASS" | "STABLE_FAIL" | "FLAKY" | "INVALID_EVIDENCE";
  authoritativePass: boolean;
  quarantineRequired: boolean;
  reasonCode: string;
  policyVersion: typeof FLAKE_POLICY_VERSION;
}

/**
 * Repeated test evidence is comparable only at one commit and environment.
 * Mixed outcomes are never averaged into success; they fail closed as flaky.
 */
export function assessRepeatedTest(attempts: readonly TestAttemptOutcome[], minimumAttempts = 3): FlakeDecision {
  const parsed = attempts.map((attempt) => TestAttemptOutcomeSchema.parse(attempt));
  const result = (classification: FlakeDecision["classification"], authoritativePass: boolean, quarantineRequired: boolean, reasonCode: string): FlakeDecision => ({
    classification, authoritativePass, quarantineRequired, reasonCode, policyVersion: FLAKE_POLICY_VERSION,
  });
  if (parsed.length < minimumAttempts) return result("INSUFFICIENT_EVIDENCE", false, false, "FLAKE_REPETITIONS_INCOMPLETE");
  const commits = new Set(parsed.map((item) => item.commitSha));
  const environments = new Set(parsed.map((item) => item.environmentDigest));
  const attemptNumbers = new Set(parsed.map((item) => item.attempt));
  if (commits.size !== 1 || environments.size !== 1 || attemptNumbers.size !== parsed.length) {
    return result("INVALID_EVIDENCE", false, true, "FLAKE_EVIDENCE_NOT_COMPARABLE");
  }
  const passed = parsed.filter((item) => item.passed).length;
  if (passed === parsed.length) return result("STABLE_PASS", true, false, "REPEATED_TEST_PASSED");
  if (passed === 0) return result("STABLE_FAIL", false, false, "REPEATED_TEST_FAILED");
  return result("FLAKY", false, true, "MIXED_TEST_OUTCOMES");
}
