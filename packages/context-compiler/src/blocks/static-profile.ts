import type { ContextBlock } from "./base.js";

export class StaticProfileBlock implements ContextBlock {
  readonly sectionId = "working-summary" as const;
  readonly budgetKey = "summary" as const;
  readonly priority = 100;

  build(input: Parameters<ContextBlock["build"]>[0]) {
    if (!input.threadState?.workingSummary) {
      return undefined;
    }
    return {
      role: "system" as const,
      content: `Working summary:\n${input.threadState.workingSummary}`,
    };
  }
}
