// MIT License — see LICENSE file
export type Provider = "anthropic" | "openai" | "gemini" | "groq" | "generic";

export interface CompressContext {
  provider: Provider;
  model: string;
  tokenBudget?: number;
  /** 0.0–1.0; used by quota controller to dial aggressiveness */
  quotaRemaining?: number;
  /** For CCR BM25 retrieval */
  query?: string;
  sessionId?: string;
}

export interface CompressResult {
  content: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  transforms: string[];
  ccrHashes: string[];
  cacheHit: boolean;
}

export interface Transform {
  name: string;
  detect?(content: string, ctx: CompressContext): boolean;
  compress(content: string, ctx: CompressContext): CompressResult;
}

export type ContentType =
  | "json"
  | "code"
  | "diff"
  | "log"
  | "prose"
  | "unknown";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_use_id?: string;
  tool_call_id?: string;
}

export interface TokenSavings {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  ratio: number;
}
