import type { ContextBlock } from "./base.js";

export class VectorRecallBlock implements ContextBlock {
  readonly sectionId = "retrieved-memory" as const;
  readonly budgetKey = "facts" as const;
  readonly priority = 80;

  build(input: Parameters<ContextBlock["build"]>[0]) {
    if (!input.retrievedChunks.length) {
      return undefined;
    }
    const chunkLines = input.retrievedChunks.map(
      (chunk, index) => `${index + 1}. ${chunk.content.trim()}`,
    );
    return {
      role: "system" as const,
      content: `[RETRIEVED_MEMORY]\n${chunkLines.join("\n")}`,
    };
  }
}
