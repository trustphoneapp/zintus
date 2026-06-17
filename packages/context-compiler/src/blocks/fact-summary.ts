import type { ContextBlock } from "./base.js";

export class FactSummaryBlock implements ContextBlock {
  readonly sectionId = "top-facts" as const;
  readonly budgetKey = "facts" as const;
  readonly priority = 90;

  build(input: Parameters<ContextBlock["build"]>[0]) {
    if (!input.topFacts.length) {
      return undefined;
    }
    const factLines = input.topFacts.map((fact, index) => `${index + 1}. ${fact.content}`);
    return {
      role: "system" as const,
      content: `Top facts:\n${factLines.join("\n")}`,
    };
  }
}
