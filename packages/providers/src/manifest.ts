import type { ProviderId } from "@zintus/types";
import { createOpenAiCompatProvider } from "./openai-compat.js";
import type { Provider } from "@zintus/types";
import type { ModelCapabilities } from "./capabilities.js";
import type { DataPolicy } from "./data-policies.js";
import type { ProviderMetadata } from "./provider-metadata.js";
import type { ModelPricing } from "./pricing.js";

/**
 * DECLARATIVE PROVIDER MANIFEST — P1 of the OpenRouter×Manus plan
 * (docs/audit/2026-07-02/openrouter-manus-plan.md).
 *
 * One entry here is EVERYTHING a new OpenAI-compatible provider needs: runtime
 * adapter config, default-model capabilities, data policy, BYOK metadata, quota
 * defaults, savings anchor, list pricing, and catalog seeds. The cross-cutting
 * registries (factory, capabilities, data-policies, provider-metadata, pricing,
 * catalog, router limits) each SPREAD their slice from this table, so adding
 * provider #23 = one `ProviderId` line + one entry below. The original 12
 * providers keep their entries in the per-registry files (migration is
 * mechanical and deferred); every provider ADDED after 2026-07-02 lives here.
 *
 * HONESTY BAR (same as capabilities.ts / data-policies.ts): every value is
 * best-effort against public provider docs, reviewed 2026-07-02 — re-verify
 * before relying on a flag or price. Capabilities are CONSERVATIVE: a flag is
 * false / "none" unless the provider's docs are unambiguous. Unknown training
 * policies say "unknown", never a guess. Prices are public list prices.
 *
 * Catalog-seed contract (enforced by catalog.test.ts): a NON-default model's
 * flags must be conservative (vision:false, tools:false, structuredOutput:
 * "none") unless the model is also added to the capability allowlists; the
 * DEFAULT model's seed flags must exactly mirror `capabilities` below. A
 * vision-true default must ALSO appear in `visionModels` (supportsVision with
 * an explicit model id checks only the allowlist).
 */

/** Quota defaults, structurally identical to the router's `ProviderLimits`
 *  (providers can't import the router package — that would be a dep cycle). */
export interface ManifestLimits {
  requestsPerDay?: number;
  tokensPerDay?: number;
  requestsPerMinute?: number;
  rollingWindow?: boolean;
}

/** One catalog seed (mirrors catalog.ts's local `CatalogSeed`). */
export interface ManifestCatalogSeed {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  tools: boolean;
  structuredOutput: ModelCapabilities["structuredOutput"];
  free: boolean;
}

export interface ExtendedProviderEntry {
  runtime: {
    name: string;
    color: string;
    priority: number;
    keyRegex: RegExp | null;
    defaultModel: string;
    baseUrl: string;
    validatePath?: string;
    supportsNativeWebSearch?: boolean;
  };
  capabilities: ModelCapabilities;
  /** Extra model ids (beyond a vision-true default) verified to accept images. */
  visionModels?: readonly string[];
  dataPolicy: DataPolicy;
  metadata: ProviderMetadata;
  limits: ManifestLimits;
  /** Savings anchor: USD per 1M tokens (blended) a paid equivalent would charge. */
  paidEquivalentUsdPerMTok: number;
  /** List pricing rows (provider field is filled in by the derive). */
  pricing: ReadonlyArray<Omit<ModelPricing, "provider">>;
  catalogSeeds: readonly ManifestCatalogSeed[];
}

// Same key stance as skeletons.ts: when a key format is not reliably
// documented, sanity-check shape only and let validateKey()'s live call decide.
const GENERIC_KEY = /^\S{8,}$/;

const VERIFIED = "2026-07-02";

export const EXTENDED_PROVIDERS: Partial<Record<ProviderId, ExtendedProviderEntry>> = {
  // ── Free-tier-bearing additions (priority 11–17, after the original free lane) ──

  together: {
    runtime: {
      name: "Together AI",
      color: "#0EA5E9",
      priority: 11,
      keyRegex: GENERIC_KEY,
      defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      baseUrl: "https://api.together.xyz/v1",
    },
    capabilities: {
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      contextWindow: 131_072,
      vision: false,
      tools: true,
      json: true,
      structuredOutput: "json_object",
      capabilityTier: 6,
    },
    dataPolicy: {
      trainsOnData: false,
      dataRetention: "Not used for training by default",
      zdr: false,
      badge: "no-training",
      policyUrl: "https://www.together.ai/privacy",
      note: "States API data is not used to train models without opt-in.",
    },
    metadata: {
      name: "Together AI",
      description: "Open-model serving with a genuinely free Llama 3.3 70B route.",
      keyUrl: "https://api.together.ai/settings/api-keys",
      keyPrefix: "",
      freeTier: "Llama-3.3-70B-Instruct-Turbo-Free is $0 (rate-limited).",
      color: "#0EA5E9",
      trainsOnData: false,
      dataPolicy: "States API data is not used for training without opt-in.",
    },
    limits: { requestsPerMinute: 6 },
    paidEquivalentUsdPerMTok: 0.88,
    pricing: [
      {
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
        inputPer1M: 0,
        outputPer1M: 0,
        freeLimitNotes: "Free route, rate-limited (~6 req/min class).",
        updatedAt: VERIFIED,
      },
      {
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        inputPer1M: 0.88,
        outputPer1M: 0.88,
        updatedAt: VERIFIED,
      },
    ],
    catalogSeeds: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free", displayName: "Llama 3.3 70B Turbo (free)", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "json_object", free: true },
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", displayName: "Llama 3.3 70B Turbo", contextWindow: 131_072, vision: false, tools: false, structuredOutput: "none", free: false },
    ],
  },

  sambanova: {
    runtime: {
      name: "SambaNova",
      color: "#7C3AED",
      priority: 12,
      keyRegex: GENERIC_KEY,
      defaultModel: "Meta-Llama-3.3-70B-Instruct",
      baseUrl: "https://api.sambanova.ai/v1",
    },
    capabilities: {
      model: "Meta-Llama-3.3-70B-Instruct",
      contextWindow: 128_000,
      vision: false,
      tools: true,
      json: true,
      structuredOutput: "json_object",
      capabilityTier: 9,
    },
    dataPolicy: {
      trainsOnData: "unknown",
      dataRetention: "Not clearly documented for the cloud API",
      zdr: false,
      badge: "unknown",
      policyUrl: "https://sambanova.ai/privacy-policy",
      note: "Training/retention posture for API traffic not clearly documented; treated as unknown.",
    },
    metadata: {
      name: "SambaNova",
      description: "RDU-accelerated open models with a rate-limited free tier.",
      keyUrl: "https://cloud.sambanova.ai/apis",
      keyPrefix: "",
      freeTier: "Free tier with per-minute rate limits.",
      color: "#7C3AED",
      trainsOnData: true,
      dataPolicy: "Policy for API traffic not clearly documented — treated conservatively as may-train.",
    },
    limits: { requestsPerMinute: 10 },
    paidEquivalentUsdPerMTok: 0.6,
    pricing: [
      {
        model: "Meta-Llama-3.3-70B-Instruct",
        inputPer1M: 0.6,
        outputPer1M: 1.2,
        freeLimitNotes: "Free tier rate-limited per minute.",
        updatedAt: VERIFIED,
      },
    ],
    catalogSeeds: [
      { id: "Meta-Llama-3.3-70B-Instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: true },
    ],
  },

  nvidia: {
    runtime: {
      name: "NVIDIA NIM",
      color: "#76B900",
      priority: 13,
      keyRegex: /^nvapi-\S{16,}$/,
      defaultModel: "meta/llama-3.3-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
    },
    capabilities: {
      model: "meta/llama-3.3-70b-instruct",
      contextWindow: 128_000,
      vision: false,
      tools: false,
      json: false,
      structuredOutput: "none",
      capabilityTier: 9,
    },
    dataPolicy: {
      trainsOnData: "unknown",
      dataRetention: "Trial/build endpoint retention not clearly documented",
      zdr: false,
      badge: "unknown",
      policyUrl: "https://www.nvidia.com/en-us/about-nvidia/privacy-policy/",
      note: "build.nvidia.com trial endpoints; production NIM is self-hosted. Treated as unknown.",
    },
    metadata: {
      name: "NVIDIA NIM",
      description: "build.nvidia.com hosted open models (trial credits).",
      keyUrl: "https://build.nvidia.com/settings/api-keys",
      keyPrefix: "nvapi-",
      freeTier: "Trial credits for hosted endpoints; rate-limited.",
      color: "#76B900",
      trainsOnData: true,
      dataPolicy: "Trial endpoint data handling not clearly documented — treated conservatively.",
    },
    limits: { requestsPerMinute: 40 },
    paidEquivalentUsdPerMTok: 0.6,
    pricing: [],
    catalogSeeds: [
      { id: "meta/llama-3.3-70b-instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: true },
    ],
  },

  novita: {
    runtime: {
      name: "Novita AI",
      color: "#14B8A6",
      priority: 14,
      keyRegex: GENERIC_KEY,
      defaultModel: "meta-llama/llama-3.3-70b-instruct",
      baseUrl: "https://api.novita.ai/v3/openai",
    },
    capabilities: {
      model: "meta-llama/llama-3.3-70b-instruct",
      contextWindow: 131_072,
      vision: false,
      tools: true,
      json: false,
      structuredOutput: "none",
      capabilityTier: 9,
    },
    dataPolicy: {
      trainsOnData: "unknown",
      dataRetention: "Not clearly documented",
      zdr: false,
      badge: "unknown",
      policyUrl: "https://novita.ai/legal/privacy-policy",
      note: "Training/retention posture not clearly documented; treated as unknown.",
    },
    metadata: {
      name: "Novita AI",
      description: "Low-cost open-model serving (OpenAI-compatible).",
      keyUrl: "https://novita.ai/settings/key-management",
      keyPrefix: "",
      freeTier: "New-account trial credits; otherwise pay-as-you-go.",
      color: "#14B8A6",
      trainsOnData: true,
      dataPolicy: "Policy not clearly documented — treated conservatively as may-train.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 0.39,
    pricing: [
      {
        model: "meta-llama/llama-3.3-70b-instruct",
        inputPer1M: 0.39,
        outputPer1M: 0.39,
        updatedAt: VERIFIED,
      },
    ],
    catalogSeeds: [
      { id: "meta-llama/llama-3.3-70b-instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "none", free: false },
    ],
  },

  moonshot: {
    runtime: {
      name: "Moonshot (Kimi)",
      color: "#111827",
      priority: 15,
      keyRegex: GENERIC_KEY,
      defaultModel: "kimi-k2-0711-preview",
      baseUrl: "https://api.moonshot.ai/v1",
    },
    capabilities: {
      model: "kimi-k2-0711-preview",
      contextWindow: 131_072,
      vision: false,
      tools: true,
      json: true,
      structuredOutput: "json_object",
      capabilityTier: 5,
    },
    dataPolicy: {
      trainsOnData: "unknown",
      dataRetention: "Not clearly documented for the international API",
      zdr: false,
      badge: "unknown",
      policyUrl: "https://platform.moonshot.ai/docs/agreement/privacy-policy",
      note: "International (moonshot.ai) API; training posture not clearly documented.",
    },
    metadata: {
      name: "Moonshot (Kimi)",
      description: "Kimi K2 — strong open agentic/coding model, OpenAI-compatible.",
      keyUrl: "https://platform.moonshot.ai/console/api-keys",
      keyPrefix: "sk-",
      freeTier: "Small new-account credit; otherwise pay-as-you-go.",
      color: "#111827",
      trainsOnData: true,
      dataPolicy: "Policy not clearly documented — treated conservatively as may-train.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 1.0,
    pricing: [
      {
        model: "kimi-k2-0711-preview",
        inputPer1M: 0.6,
        outputPer1M: 2.5,
        updatedAt: VERIFIED,
      },
    ],
    catalogSeeds: [
      { id: "kimi-k2-0711-preview", displayName: "Kimi K2 (preview)", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "json_object", free: false },
      { id: "moonshot-v1-8k", displayName: "Moonshot v1 8K", contextWindow: 8_192, vision: false, tools: false, structuredOutput: "none", free: false },
    ],
  },

  zai: {
    runtime: {
      name: "Z.ai (GLM)",
      color: "#2563EB",
      priority: 16,
      keyRegex: GENERIC_KEY,
      defaultModel: "glm-4.5-air",
      baseUrl: "https://api.z.ai/api/paas/v4",
      validatePath: "/chat/completions",
    },
    capabilities: {
      model: "glm-4.5-air",
      contextWindow: 128_000,
      vision: false,
      tools: true,
      json: true,
      structuredOutput: "json_object",
      capabilityTier: 5,
    },
    dataPolicy: {
      trainsOnData: "unknown",
      dataRetention: "Not clearly documented for the international API",
      zdr: false,
      badge: "unknown",
      policyUrl: "https://z.ai/privacy-policy",
      note: "International Z.ai API; training posture not clearly documented.",
    },
    metadata: {
      name: "Z.ai (GLM)",
      description: "GLM-4.5 family — cost-efficient agentic models, OpenAI-compatible.",
      keyUrl: "https://z.ai/manage-apikey/apikey-list",
      keyPrefix: "",
      freeTier: "Small new-account credit; otherwise pay-as-you-go.",
      color: "#2563EB",
      trainsOnData: true,
      dataPolicy: "Policy not clearly documented — treated conservatively as may-train.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 0.6,
    pricing: [
      { model: "glm-4.5-air", inputPer1M: 0.2, outputPer1M: 1.1, updatedAt: VERIFIED },
      { model: "glm-4.5", inputPer1M: 0.6, outputPer1M: 2.2, updatedAt: VERIFIED },
    ],
    catalogSeeds: [
      { id: "glm-4.5-air", displayName: "GLM-4.5 Air", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: false },
      { id: "glm-4.5", displayName: "GLM-4.5", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: false },
    ],
  },

  qwen: {
    runtime: {
      name: "Qwen (DashScope)",
      color: "#9333EA",
      priority: 17,
      keyRegex: GENERIC_KEY,
      defaultModel: "qwen-plus",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      validatePath: "/chat/completions",
    },
    capabilities: {
      model: "qwen-plus",
      contextWindow: 131_072,
      vision: false,
      tools: true,
      json: true,
      structuredOutput: "json_object",
      capabilityTier: 6,
    },
    dataPolicy: {
      trainsOnData: "unknown",
      dataRetention: "Alibaba Cloud Model Studio retention applies",
      zdr: false,
      badge: "unknown",
      policyUrl: "https://www.alibabacloud.com/help/en/model-studio/support/faq-about-alibaba-cloud-model-studio",
      note: "International DashScope endpoint; training posture not clearly documented.",
    },
    metadata: {
      name: "Qwen (DashScope)",
      description: "Alibaba Qwen models via the international OpenAI-compatible endpoint.",
      keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
      keyPrefix: "sk-",
      freeTier: "Time-limited new-account free quota per model.",
      color: "#9333EA",
      trainsOnData: true,
      dataPolicy: "Policy not clearly documented — treated conservatively as may-train.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 0.5,
    pricing: [
      { model: "qwen-plus", inputPer1M: 0.4, outputPer1M: 1.2, updatedAt: VERIFIED },
    ],
    catalogSeeds: [
      { id: "qwen-plus", displayName: "Qwen Plus", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "json_object", free: false },
    ],
  },

  // ── Paid BYOK anchors (priority 18–20): the frontier keys users already own. ──

  openai: {
    runtime: {
      name: "OpenAI",
      color: "#10A37F",
      priority: 18,
      keyRegex: /^sk-[A-Za-z0-9_-]{20,}$/,
      defaultModel: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
    capabilities: {
      model: "gpt-4o-mini",
      contextWindow: 128_000,
      vision: true,
      tools: true,
      json: true,
      structuredOutput: "json_schema",
      capabilityTier: 2,
    },
    visionModels: ["gpt-4o-mini", "gpt-4o"],
    dataPolicy: {
      trainsOnData: false,
      dataRetention: "API data not used for training; ~30-day abuse logs",
      zdr: false,
      badge: "no-training",
      policyUrl: "https://openai.com/policies/api-data-usage-policies",
      note: "API traffic is not used for training by default.",
    },
    metadata: {
      name: "OpenAI",
      description: "GPT-4o family via your own OpenAI API key (paid).",
      keyUrl: "https://platform.openai.com/api-keys",
      keyPrefix: "sk-",
      freeTier: "None — paid API (BYOK).",
      color: "#10A37F",
      trainsOnData: false,
      dataPolicy: "API data is not used for training by default; short-term abuse logs.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 0.4,
    pricing: [
      { model: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6, updatedAt: VERIFIED },
      { model: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10, updatedAt: VERIFIED },
    ],
    catalogSeeds: [
      { id: "gpt-4o-mini", displayName: "GPT-4o mini", contextWindow: 128_000, vision: true, tools: true, structuredOutput: "json_schema", free: false },
      { id: "gpt-4o", displayName: "GPT-4o", contextWindow: 128_000, vision: true, tools: false, structuredOutput: "none", free: false },
    ],
  },

  anthropic: {
    runtime: {
      name: "Anthropic",
      color: "#D97706",
      priority: 19,
      keyRegex: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
      defaultModel: "claude-haiku-4-5",
      // Anthropic's OpenAI-SDK compatibility surface (beta): standard
      // /chat/completions with Authorization: Bearer. Feature coverage is
      // narrower than the native Messages API — capabilities below are
      // deliberately conservative to what the compat layer serves.
      baseUrl: "https://api.anthropic.com/v1",
      validatePath: "/chat/completions",
    },
    capabilities: {
      model: "claude-haiku-4-5",
      contextWindow: 200_000,
      vision: false,
      tools: true,
      json: false,
      structuredOutput: "none",
      capabilityTier: 2,
    },
    dataPolicy: {
      trainsOnData: false,
      dataRetention: "API data not used for training by default",
      zdr: false,
      badge: "no-training",
      policyUrl: "https://www.anthropic.com/legal/privacy",
      note: "API traffic is not used for training by default.",
    },
    metadata: {
      name: "Anthropic",
      description: "Claude via the OpenAI-compat surface with your own key (paid).",
      keyUrl: "https://console.anthropic.com/settings/keys",
      keyPrefix: "sk-ant-",
      freeTier: "None — paid API (BYOK).",
      color: "#D97706",
      trainsOnData: false,
      dataPolicy: "API data is not used for training by default.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 2.0,
    pricing: [
      { model: "claude-haiku-4-5", inputPer1M: 1, outputPer1M: 5, updatedAt: VERIFIED },
    ],
    catalogSeeds: [
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", contextWindow: 200_000, vision: false, tools: true, structuredOutput: "none", free: false },
    ],
  },

  perplexity: {
    runtime: {
      name: "Perplexity",
      color: "#20B8CD",
      priority: 20,
      keyRegex: /^pplx-\S{16,}$/,
      defaultModel: "sonar",
      baseUrl: "https://api.perplexity.ai",
      // No /models endpoint; validate against the chat surface.
      validatePath: "/chat/completions",
      supportsNativeWebSearch: true,
    },
    capabilities: {
      model: "sonar",
      contextWindow: 128_000,
      vision: false,
      tools: false,
      json: false,
      structuredOutput: "none",
      capabilityTier: 7,
    },
    dataPolicy: {
      trainsOnData: false,
      dataRetention: "States API data is not used for training",
      zdr: false,
      badge: "no-training",
      policyUrl: "https://www.perplexity.ai/hub/legal/perplexity-api-privacy-policy",
      note: "Search-grounded answers; API data stated as not used for training.",
    },
    metadata: {
      name: "Perplexity",
      description: "Search-grounded Sonar models with citations (paid).",
      keyUrl: "https://www.perplexity.ai/settings/api",
      keyPrefix: "pplx-",
      freeTier: "None — paid API (BYOK).",
      color: "#20B8CD",
      trainsOnData: false,
      dataPolicy: "States API data is not used for training.",
    },
    limits: {},
    paidEquivalentUsdPerMTok: 1.0,
    pricing: [
      {
        model: "sonar",
        inputPer1M: 1,
        outputPer1M: 1,
        freeLimitNotes: "Search request fees billed separately by Perplexity.",
        updatedAt: VERIFIED,
      },
    ],
    catalogSeeds: [
      { id: "sonar", displayName: "Sonar", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: false },
    ],
  },
};

/** The extended ids actually present (typed, for spreads and tests). */
export const EXTENDED_PROVIDER_IDS = Object.keys(
  EXTENDED_PROVIDERS,
) as ProviderId[];

function entries(): Array<[ProviderId, ExtendedProviderEntry]> {
  return Object.entries(EXTENDED_PROVIDERS) as Array<
    [ProviderId, ExtendedProviderEntry]
  >;
}

/** Runtime `Provider` impls (openai-compat) for every manifest entry. */
export function extendedRuntimeProviders(): Partial<Record<ProviderId, Provider>> {
  const out: Partial<Record<ProviderId, Provider>> = {};
  for (const [id, entry] of entries()) {
    out[id] = createOpenAiCompatProvider({ id, ...entry.runtime });
  }
  return out;
}

/** `MODEL_CAPABILITIES` slice for the manifest providers. */
export function extendedCapabilities(): Partial<Record<ProviderId, ModelCapabilities>> {
  const out: Partial<Record<ProviderId, ModelCapabilities>> = {};
  for (const [id, entry] of entries()) out[id] = entry.capabilities;
  return out;
}

/** `VISION_MODELS` slice (only providers that declare extra vision models). */
export function extendedVisionModels(): Partial<Record<ProviderId, ReadonlySet<string>>> {
  const out: Partial<Record<ProviderId, ReadonlySet<string>>> = {};
  for (const [id, entry] of entries()) {
    if (entry.visionModels?.length) out[id] = new Set(entry.visionModels);
  }
  return out;
}

/** `DATA_POLICIES` slice. */
export function extendedDataPolicies(): Partial<Record<ProviderId, DataPolicy>> {
  const out: Partial<Record<ProviderId, DataPolicy>> = {};
  for (const [id, entry] of entries()) out[id] = entry.dataPolicy;
  return out;
}

/** `PROVIDER_METADATA` slice. */
export function extendedMetadata(): Partial<Record<ProviderId, ProviderMetadata>> {
  const out: Partial<Record<ProviderId, ProviderMetadata>> = {};
  for (const [id, entry] of entries()) out[id] = entry.metadata;
  return out;
}

/** Router `DEFAULT_PROVIDER_LIMITS` slice (structural `ManifestLimits`). */
export function extendedLimits(): Partial<Record<ProviderId, ManifestLimits>> {
  const out: Partial<Record<ProviderId, ManifestLimits>> = {};
  for (const [id, entry] of entries()) out[id] = entry.limits;
  return out;
}

/** Router `PAID_EQUIVALENT_USD_PER_MTOK` slice. */
export function extendedPaidEquivalents(): Partial<Record<ProviderId, number>> {
  const out: Partial<Record<ProviderId, number>> = {};
  for (const [id, entry] of entries()) out[id] = entry.paidEquivalentUsdPerMTok;
  return out;
}

/** `PRICING_CATALOG` rows for the manifest providers. */
export function extendedPricing(): ModelPricing[] {
  const out: ModelPricing[] = [];
  for (const [id, entry] of entries()) {
    for (const row of entry.pricing) out.push({ provider: id, ...row });
  }
  return out;
}

/** Catalog seeds, as (provider, seed) pairs for catalog.ts to append. */
export function extendedCatalogSeeds(): ReadonlyArray<
  readonly [ProviderId, ManifestCatalogSeed]
> {
  const out: Array<readonly [ProviderId, ManifestCatalogSeed]> = [];
  for (const [id, entry] of entries()) {
    for (const seed of entry.catalogSeeds) out.push([id, seed] as const);
  }
  return out;
}
