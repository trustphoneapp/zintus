import type { ProviderId } from "@zintus/types";
import { extendedMetadata } from "./manifest.js";

/**
 * UI-facing metadata for each BYOK provider. This describes *how a user obtains
 * and pastes a key* and *what the provider does with their data* — it is not the
 * runtime {@link import("@zintus/types").Provider} (streaming/validation) impl.
 *
 * Keyed by {@link ProviderId} so it can never drift from the real provider set
 * (`packages/types/src/provider-id.ts`). Providers added after 2026-07-02
 * (including the paid-BYOK anchors `openai`/`anthropic`/`perplexity` from the
 * P1 plan) declare their metadata in manifest.ts and are spread in below.
 */
export interface ProviderMetadata {
  /** Human-facing display name (matches the runtime provider's `name`). */
  name: string;
  /** One-line description shown under the provider title in the BYOK list. */
  description: string;
  /** Official console URL where the user creates/copies an API key. */
  keyUrl: string;
  /**
   * Literal prefix of a valid key for this provider, used as an input hint /
   * client-side sanity check. Empty string for local runtimes that take no key.
   */
  keyPrefix: string;
  /** Short, honest summary of the provider's free tier (or local = free). */
  freeTier: string;
  /** Brand color (hex), matches the runtime provider's `color`. */
  color: string;
  /**
   * Whether the provider may train on data sent through its (free) API by
   * default. Conservative: `true` when the public policy permits training on
   * free-tier traffic, `false` when it contractually does not, for local
   * runtimes (data never leaves the machine).
   */
  trainsOnData: boolean;
  /** Plain-language data-handling note shown to the user before they paste a key. */
  dataPolicy: string;
  /** True for local runtimes that can be auto-detected on the host. */
  autoDetect?: boolean;
  /** Default localhost port to probe when `autoDetect` is set. */
  detectPort?: number;
}

/**
 * Authoritative provider metadata for the Zintus BYOK UI. Keys MUST exactly
 * cover {@link ProviderId} (TypeScript enforces this via the Record type).
 */
export const PROVIDER_METADATA: Record<ProviderId, ProviderMetadata> = {
  ...(extendedMetadata() as Record<ProviderId, ProviderMetadata>),
  cerebras: {
    name: "Cerebras",
    description: "Fastest Llama inference on wafer-scale chips.",
    keyUrl: "https://cloud.cerebras.ai/platform/apikeys",
    keyPrefix: "csk-",
    freeTier: "Free tier ~1M tokens/day.",
    color: "#10B981",
    trainsOnData: false,
    dataPolicy: "Does not train on API inputs/outputs; prompts not used for model training.",
  },
  groq: {
    name: "Groq",
    description: "Ultra-low-latency LPU inference for open models.",
    keyUrl: "https://console.groq.com/keys",
    keyPrefix: "gsk_",
    freeTier: "Free tier ~1,000 req/day, ~30 req/min (per model).",
    color: "#F59E0B",
    trainsOnData: false,
    dataPolicy: "Does not train on or retain prompts beyond serving the request.",
  },
  gemini: {
    name: "Gemini",
    description: "Google's multimodal models with native search grounding.",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyPrefix: "AIza",
    freeTier: "Free tier ~1,500 req/day, ~15 req/min.",
    color: "#3B82F6",
    trainsOnData: true,
    dataPolicy: "Free-tier (AI Studio) prompts may be reviewed and used to improve Google products. Do not send sensitive data on the free tier.",
  },
  openrouter: {
    name: "OpenRouter",
    description: "One key for many models, including free routes.",
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    freeTier: "Free `:free` models; ~50 req/day, ~20 req/min on free routes.",
    color: "#A855F7",
    trainsOnData: false,
    dataPolicy: "Routing is configurable; logging/training depend on the upstream model and your account's data settings.",
  },
  cohere: {
    name: "Cohere",
    description: "Command R models tuned for RAG and tool use.",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    keyPrefix: "",
    freeTier: "Free trial keys: limited, ~33 req/day, ~10 req/min.",
    color: "#06B6D4",
    trainsOnData: true,
    dataPolicy: "Trial-key data may be used to improve Cohere's services. Production keys are excluded from training.",
  },
  mistral: {
    name: "Mistral",
    description: "European open-weight and frontier models.",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyPrefix: "",
    freeTier: "Free experiment tier with generous token allowance.",
    color: "#F97316",
    trainsOnData: true,
    dataPolicy: "Free (experiment) tier traffic may be used to improve models; opt out or use a paid tier to exclude your data.",
  },
  deepseek: {
    name: "DeepSeek",
    description: "Strong, low-cost chat and reasoning models.",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPrefix: "sk-",
    freeTier: "Pay-as-you-go with low pricing; promotional credits vary.",
    color: "#EC4899",
    trainsOnData: true,
    dataPolicy: "Inputs/outputs may be stored on servers in China and used to improve services. Avoid sending sensitive data.",
  },
  fireworks: {
    name: "Fireworks AI",
    description: "Fast hosted open models and fine-tunes.",
    keyUrl: "https://fireworks.ai/account/api-keys",
    keyPrefix: "",
    freeTier: "Free trial credits; ~10 req/min, model/token credits vary.",
    color: "#22C55E",
    trainsOnData: false,
    dataPolicy: "Does not train on customer prompts; data used only to serve requests.",
  },
  xai: {
    name: "xAI Grok",
    description: "Grok models from xAI.",
    keyUrl: "https://console.x.ai",
    keyPrefix: "xai-",
    freeTier: "Trial credits vary by account.",
    color: "#0EA5E9",
    trainsOnData: true,
    dataPolicy: "xAI may use API data to train and improve models unless you opt out in console settings.",
  },
  huggingface: {
    name: "Hugging Face",
    description: "Inference router across many open models.",
    keyUrl: "https://huggingface.co/settings/tokens",
    keyPrefix: "hf_",
    freeTier: "Free credit-based usage; limits vary by account.",
    color: "#F59E0B",
    trainsOnData: false,
    dataPolicy: "Router forwards to third-party providers; training/retention depend on the selected upstream provider.",
  },
  lmstudio: {
    name: "LM Studio",
    description: "Run local models on your own machine.",
    keyUrl: "https://lmstudio.ai",
    keyPrefix: "",
    freeTier: "Local — free, no quota beyond your hardware.",
    color: "#6366F1",
    trainsOnData: false,
    dataPolicy: "Runs entirely on your machine; prompts never leave your device.",
    autoDetect: true,
    detectPort: 1234,
  },
  ollama: {
    name: "Ollama",
    description: "Run local models on your own machine.",
    keyUrl: "https://ollama.com/download",
    keyPrefix: "",
    freeTier: "Local — free, no quota beyond your hardware.",
    color: "#8B5CF6",
    trainsOnData: false,
    dataPolicy: "Runs entirely on your machine; prompts never leave your device.",
    autoDetect: true,
    detectPort: 11434,
  },
};
