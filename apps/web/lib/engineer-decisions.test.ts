import { describe, expect, test } from "bun:test";
import {
  ASK_NOW_DECISION_FIXTURE,
  AUTO_DECISION_FIXTURE,
  DEFER_DECISION_FIXTURE,
  ENGINEER_DECISION_FIXTURES,
} from "./engineer-decision-fixtures";
import {
  ALL_OF_THE_ABOVE_OPTION_ID,
  canSelectAllOptions,
  getDecisionPresentation,
  getDeferredHumanTaskSummary,
  getPresentedDecisionOptions,
  validateDecisionForPresentation,
} from "./engineer-decisions";

describe("Engineer decision presentation", () => {
  test("keeps every decision simple and exposes one matching recommendation", () => {
    for (const decision of ENGINEER_DECISION_FIXTURES) {
      expect(validateDecisionForPresentation(decision)).toBe(decision);
      expect(decision.options.length).toBeGreaterThanOrEqual(2);
      expect(decision.options.length).toBeLessThanOrEqual(3);
      expect(decision.options.filter((option) => option.recommended)).toHaveLength(1);
    }
  });

  test("explains the distinct ASK_NOW, DEFER, and AUTO behavior", () => {
    expect(getDecisionPresentation("ASK_NOW")).toEqual(expect.objectContaining({ tone: "blocking" }));
    expect(getDecisionPresentation("DEFER")).toEqual(expect.objectContaining({ tone: "deferred" }));
    expect(getDecisionPresentation("AUTO")).toEqual(expect.objectContaining({ tone: "automatic" }));
  });

  test("offers all-of-the-above only for explicitly compatible reversible choices", () => {
    expect(canSelectAllOptions(DEFER_DECISION_FIXTURE)).toBe(true);
    expect(getPresentedDecisionOptions(DEFER_DECISION_FIXTURE).map((option) => option.optionId)).toContain(ALL_OF_THE_ABOVE_OPTION_ID);

    expect(canSelectAllOptions(ASK_NOW_DECISION_FIXTURE)).toBe(false);
    expect(canSelectAllOptions(AUTO_DECISION_FIXTURE)).toBe(false);
    expect(getPresentedDecisionOptions(ASK_NOW_DECISION_FIXTURE)).toHaveLength(2);

    const irreversible = {
      ...DEFER_DECISION_FIXTURE,
      options: DEFER_DECISION_FIXTURE.options.map((option, index) => index === 1 ? { ...option, reversibility: "IRREVERSIBLE" as const } : option),
    };
    expect(canSelectAllOptions(irreversible)).toBe(false);
  });

  test("summarizes only unresolved deferred human work", () => {
    expect(getDeferredHumanTaskSummary(ENGINEER_DECISION_FIXTURES.slice())).toEqual({
      count: 1,
      tasks: [{
        decisionId: DEFER_DECISION_FIXTURE.decisionId,
        question: DEFER_DECISION_FIXTURE.question,
        recommendedOption: "Operations runbook",
      }],
    });
  });

  test("rejects malformed recommendation and unsafe all-of-the-above selections", () => {
    expect(() => validateDecisionForPresentation({ ...ASK_NOW_DECISION_FIXTURE, recommendedOptionId: "local-keychain" })).toThrow("exactly one");
    expect(() => validateDecisionForPresentation({ ...ASK_NOW_DECISION_FIXTURE, selectedOptionId: ALL_OF_THE_ABOVE_OPTION_ID })).toThrow("not semantically valid");
  });
});
