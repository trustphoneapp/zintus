import type {
  ChatMessage,
  MemoryChunkHit,
  MemoryFact,
  MemoryStore,
  MemoryThreadState,
  ThreadMessage,
} from "@zintus/types";

export type CompileMode = "fast" | "smart" | "deep";

export interface BudgetBreakdown {
  contextWindow: number;
  system: number;
  summary: number;
  recentTurns: number;
  facts: number;
  handoff: number;
  user: number;
  reserveForResponse: number;
  availableForPrompt: number;
}

export interface ModelContextBundle {
  threadId: string;
  mode: CompileMode;
  targetModel?: string;
  contextWindow: number;
  budget: BudgetBreakdown;
  threadState: MemoryThreadState | null;
  topFacts: MemoryFact[];
  retrievedChunks: MemoryChunkHit[];
  selectedHistory: ThreadMessage[];
  handoffBlock?: ChatMessage;
}

/** A relevant source-code chunk retrieved by the codebase indexer. */
export interface CodeContextHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface CompileRequest {
  threadId: string;
  newUserMessage: string;
  mode: CompileMode;
  targetModel?: string;
  contextWindow?: number;
  memory: MemoryStore;
  episodicMessages: ThreadMessage[];
  lastModel?: string;
  /**
   * Optional codebase retrieval (injected by the engine; keeps the compiler
   * decoupled from the indexer package). Returns the most relevant code chunks
   * for the new message; the compiler sizes how many fit the model's window.
   */
  codeSearch?: (query: string, topK: number) => Promise<CodeContextHit[]>;
  /** Raw unified git diff for this turn (CLI/desktop coding flows). Compressed before inclusion. */
  diffText?: string;
  /** Raw terminal/build/log output for this turn. Compressed before inclusion. */
  terminalText?: string;
}

export interface CompileTrace {
  mode: CompileMode;
  selectedTurnCount: number;
  factCount: number;
  retrievedChunkCount: number;
  includedSections: Array<
    | "minimal-system"
    | "working-summary"
    | "recent-turns"
    | "top-facts"
    | "retrieved-memory"
    | "handoff"
    | "code-recall"
    | "diff"
    | "terminal"
  >;
  droppedSections: string[];
}

export interface CompileResult {
  messages: ChatMessage[];
  tokenEstimate: number;
  compileTrace: CompileTrace;
  bundle: ModelContextBundle;
}
