import type { ChatMessage, MemoryChunkHit, MemoryFact, MemoryThreadState } from "@multipleai/types";
import type { BudgetBreakdown } from "../types.js";

export type ContextBlockSectionId = "working-summary" | "top-facts" | "retrieved-memory";
export type ContextBlockBudgetKey = "summary" | "facts";

export interface ContextBlockBuildInput {
  threadState: MemoryThreadState | null;
  topFacts: MemoryFact[];
  retrievedChunks: MemoryChunkHit[];
}

export interface ContextBlock {
  sectionId: ContextBlockSectionId;
  budgetKey: ContextBlockBudgetKey;
  priority: number;
  build(input: ContextBlockBuildInput): ChatMessage | undefined;
}

export interface MergeBlocksInput {
  blocks: ContextBlock[];
  data: ContextBlockBuildInput;
  budget: BudgetBreakdown;
  estimateTokens: (text: string) => number;
}

export interface MergeBlocksResult {
  messages: ChatMessage[];
  includedSections: ContextBlockSectionId[];
  droppedSections: string[];
}

export function mergeBlocks(input: MergeBlocksInput): MergeBlocksResult {
  const sorted = [...input.blocks].sort((a, b) => b.priority - a.priority);
  const messages: ChatMessage[] = [];
  const includedSections: ContextBlockSectionId[] = [];
  const droppedSections: string[] = [];
  const remaining = {
    summary: input.budget.summary,
    facts: input.budget.facts,
  };

  for (const block of sorted) {
    const message = block.build(input.data);
    if (!message) {
      continue;
    }
    const tokens = input.estimateTokens(message.content);
    if (tokens > remaining[block.budgetKey]) {
      droppedSections.push(`${block.sectionId} over budget`);
      continue;
    }
    remaining[block.budgetKey] -= tokens;
    messages.push(message);
    includedSections.push(block.sectionId);
  }

  return {
    messages,
    includedSections,
    droppedSections,
  };
}
