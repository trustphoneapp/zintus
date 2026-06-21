// MIT License — see LICENSE file

// Core compression
export { compress } from "./pipeline/pipeline.js";
export type { CompressContext, CompressResult, Transform, Message, TokenSavings, ContentType, Provider } from "./pipeline/types.js";

// CCR store
export { createCCRStore, getDefaultCCRStore } from "./ccr/store.js";
export { retrieve } from "./ccr/retrieve.js";
export { injectRetrieveTool, handleRetrieveCall, TOKZEN_RETRIEVE_TOOL } from "./ccr/tool.js";

// Token counting
export { countTokensFast, countTokensExact, isWithinBudget, estimateSavings } from "./tokenizer/count.js";

// Standalone compressors — MIT licensed, usable without pipeline
export { compressJSON } from "./compressors/json.js";
export { compressCode } from "./compressors/code.js";
export { compressLog } from "./compressors/log.js";
export { compressDiff } from "./compressors/diff.js";
export { compressProse } from "./compressors/prose.js";

// Content detection
export { detectContentType } from "./transforms/content-router.js";

// Cache alignment
export { alignCache } from "./transforms/cache-aligner.js";

// Context window management
export { manageContext } from "./transforms/context-manager.js";

// Cache hints
export { getCacheMinTokens, injectAnthropicCacheControl, applyProviderCacheHints } from "./transforms/cache-hints.js";

// [BUSL-1.1] Quota-aware controller — clearly marked
export { QuotaController } from "./quota/controller.js";
export type { AggressivenessLevel, QuotaSignals } from "./quota/controller.js";
export { dialCompress } from "./quota/dial.js";

// [BUSL-1.1] ML compressor — imported separately via "tokzen/ml" to keep base bundle light
// Use: import { createMLCompressor } from "tokzen/ml"
