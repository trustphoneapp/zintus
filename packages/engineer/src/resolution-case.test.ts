import { describe, expect, test } from "bun:test";
import { sha256 } from "./hash.js";
import {
  buildCaseAuthority,
  type CanonicalBlocker,
  classifyPhase3UnderlyingCause,
  evaluateReverifyEligibility,
  isWithinCumulativeCeiling,
  orderBlockersCanonically,
  signDirective,
  verifyDirectiveSignature,
} from "./resolution-case.js";

function blocker(overrides: Partial<CanonicalBlocker> & Pick<CanonicalBlocker, "reasonCode">): CanonicalBlocker {
  return {
    blockerId: sha256({ b: overrides.reasonCode, k: overrides.kind ?? "BLOCKING" }),
    kind: "BLOCKING",
    description: `blocker ${overrides.reasonCode}`,
    ...overrides,
  };
}

describe("resolution reverify eligibility", () => {
  const transient = blocker({ reasonCode: "PROVIDER_REQUEST_TIMEOUT" });

  test("eligible only for a single typed transient cause with a retained candidate", () => {
    expect(evaluateReverifyEligibility({ blockers: [transient], sourceClassExcluded: false, preVerificationCandidatePresent: true }))
      .toEqual({ eligible: true, reason: "PROVIDER_REQUEST_TIMEOUT" });
  });

  test("a retained candidate is mandatory even for a typed transient cause", () => {
    expect(evaluateReverifyEligibility({ blockers: [transient], sourceClassExcluded: false, preVerificationCandidatePresent: false }))
      .toEqual({ eligible: false, reason: "NO_PRE_VERIFICATION_CANDIDATE" });
  });

  test.each([
    ["failed required tests", blocker({ reasonCode: "REQUIRED_TEST_FAILED" }), "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT"],
    ["security finding", blocker({ reasonCode: "POSSIBLE_SECRET" }), "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT"],
    ["scope defect", blocker({ reasonCode: "PATH_OUT_OF_SCOPE" }), "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT"],
    ["integrity defect", blocker({ reasonCode: "BASELINE_TAMPERED" }), "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT"],
    ["generic phase 3 failure", blocker({ reasonCode: "PHASE3_UNEXPECTED_FAILURE" }), "PHASE3_CAUSE_UNTYPED"],
    ["budget exhaustion", blocker({ reasonCode: "RUNTIME_BUDGET_EXHAUSTED" }), "NON_TRANSIENT_BLOCKER"],
    ["model-call limit", blocker({ reasonCode: "MODEL_CALL_LIMIT_REACHED" }), "NON_TRANSIENT_BLOCKER"],
    ["builder failure", blocker({ reasonCode: "BUILDER_DISPATCH_FAILED" }), "NON_TRANSIENT_BLOCKER"],
  ] as const)("refuses reverify for %s", (_label, item, reason) => {
    expect(evaluateReverifyEligibility({ blockers: [item], sourceClassExcluded: false, preVerificationCandidatePresent: true }))
      .toEqual({ eligible: false, reason });
  });

  test("optional-hardening / v2 sources are excluded regardless of blockers", () => {
    expect(evaluateReverifyEligibility({ blockers: [transient], sourceClassExcluded: true, preVerificationCandidatePresent: true }))
      .toEqual({ eligible: false, reason: "SOURCE_CLASS_EXCLUDED" });
  });

  test("an advisory alongside a transient blocker does not block reverify", () => {
    expect(evaluateReverifyEligibility({
      blockers: [transient, blocker({ reasonCode: "STYLE_NIT", kind: "ADVISORY" })],
      sourceClassExcluded: false, preVerificationCandidatePresent: true,
    })).toEqual({ eligible: true, reason: "PROVIDER_REQUEST_TIMEOUT" });
  });

  test("a transient cause mixed with a correction-eligible blocker is refused as correction-eligible", () => {
    expect(evaluateReverifyEligibility({
      blockers: [transient, blocker({ reasonCode: "LOGIC_ERROR" })],
      sourceClassExcluded: false, preVerificationCandidatePresent: true,
    })).toEqual({ eligible: false, reason: "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT" });
  });

  test("multiple distinct transient causes are refused", () => {
    expect(evaluateReverifyEligibility({
      blockers: [transient, blocker({ reasonCode: "INFRA_NETWORK_UNAVAILABLE" })],
      sourceClassExcluded: false, preVerificationCandidatePresent: true,
    })).toEqual({ eligible: false, reason: "MULTIPLE_TRANSIENT_CAUSES" });
  });

  test("no blockers is not reverifiable", () => {
    expect(evaluateReverifyEligibility({ blockers: [], sourceClassExcluded: false, preVerificationCandidatePresent: true }))
      .toEqual({ eligible: false, reason: "NO_BLOCKERS" });
  });
});

describe("phase-3 underlying cause typing (P1)", () => {
  test.each([
    ["provider request timed out", "PROVIDER_REQUEST_TIMEOUT"],
    ["ECONNRESET while reading model stream", "PROVIDER_CONNECTION_RESET"],
    ["warm sandbox timeout during provision", "SANDBOX_PROVISION_TIMEOUT"],
    ["npm registry download timed out", "DEPENDENCY_FETCH_TIMEOUT"],
    ["getaddrinfo ENOTFOUND: network is unreachable", "INFRA_NETWORK_UNAVAILABLE"],
  ] as const)("types %s", (message, cause) => {
    expect(classifyPhase3UnderlyingCause(message)).toBe(cause);
  });

  test("never types an unrecognized failure (no false positives)", () => {
    expect(classifyPhase3UnderlyingCause("assertion failed: expected 2 to equal 3")).toBeNull();
    expect(classifyPhase3UnderlyingCause("segmentation fault in builder")).toBeNull();
  });
});

describe("cumulative ceiling arithmetic", () => {
  test("admits a cap that fits and rejects one that breaches", () => {
    const base = { priorReplacementActualMicrousd: 4_000_000, ambiguousLiabilityMicrousd: 1_000_000, cumulativeCeilingMicrousd: 10_000_000 };
    expect(isWithinCumulativeCeiling({ ...base, newCapMicrousd: 5_000_000 })).toBe(true);
    expect(isWithinCumulativeCeiling({ ...base, newCapMicrousd: 5_000_001 })).toBe(false);
  });
});

describe("blocker canonical ordering", () => {
  test("orders BLOCKING before ADVISORY then reasonCode then id, deterministically", () => {
    const items = [
      blocker({ reasonCode: "ZEBRA_DEFECT" }),
      blocker({ reasonCode: "STYLE_NIT", kind: "ADVISORY" }),
      blocker({ reasonCode: "ALPHA_DEFECT" }),
    ];
    const ordered = orderBlockersCanonically(items).map((item) => item.reasonCode);
    expect(ordered).toEqual(["ALPHA_DEFECT", "ZEBRA_DEFECT", "STYLE_NIT"]);
    expect(orderBlockersCanonically([...items].reverse()).map((item) => item.reasonCode)).toEqual(ordered);
  });
});

describe("directive signing", () => {
  const content = {
    caseId: sha256({ case: 1 }),
    caseHash: sha256({ hash: 1 }),
    type: "CREATE_REVERIFY_RUN" as const,
    expectedCaseVersion: 0,
    expectedSourceRunVersion: 3,
    selectedBlockers: [],
    budget: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-19T00:15:00.000Z",
  };

  test("signs deterministically and verifies against the secret", () => {
    const a = signDirective(content, "secret-key", "resolution-v1");
    const b = signDirective(content, "secret-key", "resolution-v1");
    expect(a.signature.value).toBe(b.signature.value);
    expect(a.directiveHash).toBe(b.directiveHash);
    expect(verifyDirectiveSignature(a, "secret-key")).toBe(true);
    expect(verifyDirectiveSignature(a, "wrong-secret")).toBe(false);
  });

  test("a different secret yields a different signature", () => {
    const a = signDirective(content, "secret-a", "resolution-v1");
    const b = signDirective(content, "secret-b", "resolution-v1");
    expect(a.signature.value).not.toBe(b.signature.value);
  });

  test("corrected directives select every open blocker in canonical order", () => {
    const blockers = [
      blocker({ reasonCode: "ZEBRA_TEST_FAILED" }),
      blocker({ reasonCode: "ALPHA_LOGIC_ERROR" }),
    ];
    const directive = signDirective({
      ...content, type: "CREATE_CORRECTED_RUN",
      budget: { maxCostUsd: 1, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: sha256({ p: 1 }) },
      selectedBlockers: blockers,
    }, "secret", "resolution-v1");
    expect(directive.selectedBlockers.map((item) => item.reasonCode)).toEqual(["ALPHA_LOGIC_ERROR", "ZEBRA_TEST_FAILED"]);
    expect(directive.budget?.maxCostMicrousd).toBe(1_000_000);
  });
});

describe("case authority", () => {
  test("binds a self-excluding hash and derived eligibility", () => {
    const authority = buildCaseAuthority({
      caseId: sha256({ c: 1 }),
      sourceRunId: "run-1",
      ownerUserId: "user-1",
      repositoryId: "repo-1",
      sourceState: "VERIFICATION_INCOMPLETE",
      sourceStateVersion: 3,
      baseCommitSha: "a".repeat(40),
      manifestHash: sha256({ m: 1 }),
      requiredLaneContractHash: sha256({ contract: 1 }),
      blockers: [blocker({ reasonCode: "REQUIRED_TEST_FAILED" })],
      preVerificationCandidateDigest: null,
      spendingMicrousd: { sourceActual: 2_000_000, priorReplacementActual: 0, ambiguousLiability: 0, cumulativeCeiling: 10_000_000 },
      pricingPolicyDigest: sha256({ pricing: 1 }),
      sourceClassExcluded: false,
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
    });
    expect(authority.correctionEligible).toBe(true);
    expect(authority.reverifyEligibility).toEqual({ eligible: false, reason: "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT" });
    expect(authority.caseHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The hash is stable and self-excluding: rebuilding yields the same hash.
    expect(JSON.parse(authority.json).caseHash).toBe(authority.caseHash);
  });
});
