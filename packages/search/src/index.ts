export * from "./types.js";
export {
  getSearchStrategy,
  isNativeStrategy,
  runFallbackSearch,
  type FallbackSearchOutcome,
} from "./router.js";
export {
  extractSearchQuery,
  formatSearchContext,
  injectSearchResults,
} from "./inject.js";
export { groqCompoundModel, parseGroqSearchResults } from "./providers/groq.js";
export { geminiSearchTool, parseGeminiGrounding } from "./providers/gemini.js";
export {
  openrouterSearchTool,
  parseOpenRouterCitations,
  type OpenRouterSearchTool,
} from "./providers/openrouter.js";
export { tavilySearch, SearchQuotaExceededError } from "./providers/tavily.js";
export { serperSearch } from "./providers/serper.js";
export {
  deepResearch,
  subQueryCount,
  verificationPassCount,
  sourceCeiling,
  normalizeUrl,
  dedupeResults,
  rankSources,
  bindCitations,
  MAX_VERIFICATION_PASSES,
  MAX_SOURCES,
  MAX_VERIFY_QUERIES,
  type ResearchDepth,
  type DeepResearchOptions,
  type DeepResearchDeps,
  type DeepResearchEvent,
  type VerificationConfig,
  type VerificationSummary,
  type ResearchSource,
  type Citation,
  type Corroboration,
} from "./deep-research.js";
