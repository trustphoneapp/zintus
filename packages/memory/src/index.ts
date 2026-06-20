import type { ChatMessage, MemoryThreadState } from "@zintus/types";
import { MemoryStore, type ThreadStateRow } from "./memory-store.js";

export { MemoryStore } from "./memory-store.js";
export { extractFacts } from "./extract.js";
export { extractFactsWithLlm, summarizeWithLlm, consolidateFactsWithLlm } from "./llm-memory.js";
export { summarizeTurns } from "./summarize.js";
export { chunkText, embedBatch, embedText } from "./embeddings.js";
export type {
  CompileTraceRow,
  MemoryChunkRow,
  MemoryFactRow,
  ThreadStateRow,
} from "./memory-store.js";

export type ThreadState = MemoryThreadState;

export function createMemoryStore(): MemoryStore {
  const store = new MemoryStore();
  store.init();
  return store;
}

export function toSummaryMessages(stateRow: ThreadStateRow | null): ChatMessage[] {
  const state = (stateRow?.state ?? null) as MemoryThreadState | null;
  if (!state?.workingSummary?.trim()) {
    return [];
  }
  return [{ role: "system", content: `Working summary:\n${state.workingSummary.trim()}` }];
}
