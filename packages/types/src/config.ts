import type { ProviderId } from "./provider-id.js";

export type RoutingStrategy = "fastest" | "capability" | "economy" | "quality" | "balanced";
export type ContextMode = "fast" | "smart" | "deep";

export interface AppConfig {
  routingStrategy: RoutingStrategy;
  contextMode: ContextMode;
  defaultProvider?: ProviderId;
  providerPriority: ProviderId[];
}

/**
 * Per-provider quota limits, overridable via policy.json so operators can tune
 * caps without editing code. All fields optional; a missing field means "no
 * limit of this kind".
 */
export interface PolicyLimits {
  requestsPerDay?: number;
  tokensPerDay?: number;
  /** Rolling per-minute request cap (TPM/RPM windows). */
  requestsPerMinute?: number;
  /** Rolling per-minute token cap. */
  tokensPerMinute?: number;
}

export type FallbackAction = "next_provider" | "fail";

/**
 * Declarative routing policy. Loaded from ~/.zintus/policy.json (or a
 * repo-root policy.json) and hot-reloaded on change. Every field is optional;
 * sane code defaults apply when the file is missing or partial.
 */
export interface PolicyConfig {
  /** Ordered provider preference used by the `fastest`/priority tie-break. */
  providerPriority?: ProviderId[];
  /** Relative weights for the `weighted` strategy. */
  providerWeights?: Partial<Record<ProviderId, number>>;
  /** Logical model name -> ordered provider list for same-model failover. */
  modelGroups?: Record<string, ProviderId[]>;
  /** What to do on 429 / 5xx. Defaults to next_provider for both. */
  fallbacks?: {
    on_429?: FallbackAction;
    on_5xx?: FallbackAction;
  };
  /** Per-provider quota limit overrides. */
  limits?: Partial<Record<ProviderId, PolicyLimits>>;
}

export const DEFAULT_CONFIG: AppConfig = {
  routingStrategy: "fastest",
  contextMode: "smart",
  providerPriority: [
    "cerebras",
    "groq",
    "gemini",
    "fireworks",
    "xai",
    "huggingface",
    "openrouter",
    "cohere",
    "mistral",
    "deepseek",
    "lmstudio",
    "ollama",
  ],
};
