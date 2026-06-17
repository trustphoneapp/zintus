export { allocateTokenBudget } from "./budget.js";
export {
  FactSummaryBlock,
  mergeBlocks,
  StaticProfileBlock,
  VectorRecallBlock,
} from "./blocks/index.js";
export { compileContext } from "./compiler.js";
export { buildHandoffBlock } from "./handoff.js";
export {
  compressTerminalOutput,
  type TerminalCompressOptions,
  type TerminalCompressResult,
} from "./util/terminal-compress.js";
export {
  formatDiffContext,
  tryGitDiff,
  type DiffContextOptions,
} from "./util/diff-context.js";
export type {
  BudgetBreakdown,
  CodeContextHit,
  CompileMode,
  CompileRequest,
  CompileResult,
  ModelContextBundle,
} from "./types.js";
