// Zintus public catalog data — providers and models, split honestly by what the
// router can ACTUALLY reach today vs. what is planned.
//
// HONESTY RULE (hard): the catalog must never imply a capability with no real
// code path. The router can route to exactly 22 provider IDs — the closed
// `ProviderId` union in @zintus/types (engine wiring in @zintus/router): the
// original 12 (cerebras, groq, gemini, openrouter, cohere, mistral, deepseek,
// fireworks, xai, huggingface, lmstudio, ollama) plus the 10 added 2026-07-02
// via the provider manifest (packages/providers/src/manifest.ts): together,
// sambanova, nvidia, novita, moonshot, zai, qwen, openai, anthropic,
// perplexity. Those 22 are ROUTABLE; their badges are "integrated" (or
// "add-key" for the openrouter BYOK key) and that is honest. EVERY other
// provider/model below is listed for transparency/roadmap only and is NOT yet
// routable: providers carry badge "coming-soon" and models are flagged via
// `isRoutableModel()` so the UI renders an honest "Planned — not yet routable"
// label and shows NO actionable "Add your key" CTA. Under-claim when unsure.
// Core stays free; no key custody.
//
// SPLIT (derived live in catalog-stats.ts): 22 routable providers; the rest of
// the listed providers/models are planned (not yet routable).
//
// A catalog names what it routes to, so provider and model names are verbatim.
// `freetier` records whether a provider exposes a no-key free tier.
//
// DATA PROVENANCE: pricing/capabilities verified against provider pricing pages,
// June 2026 (Anthropic, OpenAI, Google, Groq, Cerebras, DeepSeek, Mistral spot-
// checked and matched). `inputPer1M` / `outputPer1M` are USD per 1,000,000 tokens;
// a `free` model carries 0 / 0 and renders as "Free". `provider` is always a
// PROVIDERS id so the catalog stays internally consistent. Re-verify before
// relying on a specific price — provider rates change. 100 models across the
// families: Anthropic 5, OpenAI 10, Google 10, Meta Llama 10, DeepSeek 7, xAI 7,
// Qwen 8, Mistral 8, NVIDIA 5, Cohere 5, Perplexity 5, Chinese labs 12, Misc 8.

export interface Provider {
  id: string;
  name: string;
  type: string;
  models: number;
  contextMax: string;
  freetier: boolean;
  tier: "direct" | "meta" | "local" | "cloud";
  badge: "integrated" | "add-key" | "coming-soon";
  specialty: string;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  family: string;
  contextWindow: string;
  inputPer1M: number;
  outputPer1M: number;
  tier: "T0" | "T1" | "T2" | "BYOK" | "FREE";
  free: boolean;
  specialty: string;
  routingTags: string[];
}

// The provider IDs the router can actually reach today. This is the closed
// `ProviderId` union from @zintus/types, kept in sync by the catalog honesty test.
// Anything not in this set is "Planned — not yet routable" in the catalog UI.
export const ROUTABLE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "cohere",
  "mistral",
  "deepseek",
  "fireworks",
  "xai",
  "huggingface",
  "lmstudio",
  "ollama",
  // Added 2026-07-02 via the provider manifest (P1: 12 → 22).
  "together",
  "sambanova",
  "nvidia",
  "novita",
  "moonshot",
  "zai",
  "qwen",
  "openai",
  "anthropic",
  "perplexity",
]);

/** True if the router can reach this provider today. */
export function isRoutableProvider(id: string): boolean {
  return ROUTABLE_PROVIDER_IDS.has(id);
}

/** True if the router can reach this model's provider today. A non-routable
 *  model is "Planned — not yet routable" and must not show an "Add your key" CTA. */
export function isRoutableModel(model: Pick<Model, "provider">): boolean {
  return ROUTABLE_PROVIDER_IDS.has(model.provider);
}

// ── PROVIDERS — 22 routable (integrated + openrouter BYOK), rest planned ────────
//     Planned providers carry badge "coming-soon": listed for transparency, not
//     yet routable. They render as "Planned", never "Add your key".
export const PROVIDERS: Provider[] = [
  // Original 12 — integrated
  { id: "cerebras", name: "Cerebras", type: "inference", models: 4, contextMax: "128K", freetier: true, tier: "direct", badge: "integrated", specialty: "Fastest sustained throughput (~1,800 tok/s)" },
  { id: "groq", name: "Groq", type: "inference", models: 7, contextMax: "128K", freetier: true, tier: "direct", badge: "integrated", specialty: "LPU hardware · 500 tok/s · lowest latency" },
  { id: "gemini", name: "Google Gemini", type: "frontier", models: 8, contextMax: "1M", freetier: true, tier: "direct", badge: "integrated", specialty: "Multimodal · 1M context · 1.5K req/day free" },
  { id: "deepseek", name: "DeepSeek", type: "frontier", models: 6, contextMax: "1M", freetier: true, tier: "direct", badge: "integrated", specialty: "MIT licensed · best price-quality open model" },
  { id: "openrouter", name: "OpenRouter", type: "meta", models: 400, contextMax: "10M", freetier: true, tier: "meta", badge: "add-key", specialty: "400+ models · 70+ providers via single key" },
  { id: "cohere", name: "Cohere", type: "frontier", models: 5, contextMax: "128K", freetier: true, tier: "direct", badge: "integrated", specialty: "RAG-optimized · Command R family" },
  { id: "mistral", name: "Mistral AI", type: "frontier", models: 7, contextMax: "131K", freetier: true, tier: "direct", badge: "integrated", specialty: "EU-hosted · GDPR-friendly · Apache 2.0" },
  { id: "fireworks", name: "Fireworks AI", type: "inference", models: 201, contextMax: "1M", freetier: true, tier: "direct", badge: "integrated", specialty: "201 models · SOC 2 · zero data retention" },
  { id: "xai", name: "xAI (Grok)", type: "frontier", models: 6, contextMax: "2M", freetier: false, tier: "direct", badge: "integrated", specialty: "2M context window · real-time data access" },
  { id: "huggingface", name: "Hugging Face", type: "inference", models: 50, contextMax: "128K", freetier: true, tier: "direct", badge: "integrated", specialty: "Inference endpoints · widest OSS catalog" },
  { id: "ollama", name: "Ollama", type: "local", models: 999, contextMax: "∞", freetier: true, tier: "local", badge: "integrated", specialty: "Unlimited local · any open-weight model" },
  { id: "lmstudio", name: "LM Studio", type: "local", models: 999, contextMax: "∞", freetier: true, tier: "local", badge: "integrated", specialty: "Desktop GUI · local inference · offline" },

  // Added 2026-07-02 via the provider manifest (P1: 12 → 22) — integrated
  { id: "anthropic", name: "Anthropic", type: "frontier", models: 5, contextMax: "1M", freetier: false, tier: "direct", badge: "integrated", specialty: "Claude via OpenAI-compat surface · BYOK (paid)" },
  { id: "openai", name: "OpenAI", type: "frontier", models: 8, contextMax: "1M", freetier: false, tier: "direct", badge: "integrated", specialty: "GPT-4o family · BYOK (paid)" },
  { id: "together", name: "Together AI", type: "inference", models: 200, contextMax: "128K", freetier: true, tier: "direct", badge: "integrated", specialty: "Free Llama 3.3 70B Turbo route + 200 models" },
  { id: "nvidia", name: "NVIDIA NIM", type: "inference", models: 30, contextMax: "128K", freetier: true, tier: "direct", badge: "integrated", specialty: "build.nvidia.com hosted models · trial credits" },
  { id: "qwen", name: "Qwen (DashScope)", type: "frontier", models: 10, contextMax: "131K", freetier: true, tier: "direct", badge: "integrated", specialty: "Alibaba Qwen · intl OpenAI-compat endpoint" },
  { id: "deepinfra", name: "DeepInfra", type: "inference", models: 100, contextMax: "1M", freetier: false, tier: "direct", badge: "coming-soon", specialty: "Cheapest per-token · widest open catalog" },
  { id: "novita", name: "Novita AI", type: "inference", models: 100, contextMax: "131K", freetier: false, tier: "direct", badge: "integrated", specialty: "100+ models · competitive pricing" },
  { id: "sambanova", name: "SambaNova", type: "inference", models: 4, contextMax: "131K", freetier: false, tier: "direct", badge: "integrated", specialty: "Highest throughput · enterprise SLA" },
  { id: "nebius", name: "Nebius AI", type: "inference", models: 20, contextMax: "131K", freetier: false, tier: "direct", badge: "coming-soon", specialty: "EU sovereign · GDPR · data residency" },
  { id: "perplexity", name: "Perplexity (Sonar)", type: "search", models: 5, contextMax: "200K", freetier: false, tier: "direct", badge: "integrated", specialty: "Web-grounded · live citations per response" },
  { id: "cloudflare", name: "Cloudflare AI", type: "inference", models: 30, contextMax: "128K", freetier: true, tier: "direct", badge: "coming-soon", specialty: "Edge inference · Workers native · free tier" },
  { id: "bedrock", name: "AWS Bedrock", type: "cloud", models: 30, contextMax: "1M", freetier: false, tier: "cloud", badge: "coming-soon", specialty: "Enterprise compliance · VPC · regional routing" },
  { id: "vertex", name: "Google Vertex AI", type: "cloud", models: 15, contextMax: "1M", freetier: false, tier: "cloud", badge: "coming-soon", specialty: "Gemini with data residency · HIPAA · SOC 2" },
  { id: "azure", name: "Azure OpenAI", type: "cloud", models: 12, contextMax: "128K", freetier: false, tier: "cloud", badge: "coming-soon", specialty: "GPT family · enterprise · private endpoints" },
  { id: "replicate", name: "Replicate", type: "inference", models: 100, contextMax: "128K", freetier: false, tier: "direct", badge: "coming-soon", specialty: "Model marketplace · community fine-tunes" },
  { id: "featherless", name: "Featherless AI", type: "inference", models: 50, contextMax: "131K", freetier: false, tier: "direct", badge: "coming-soon", specialty: "Flat-rate $99/mo · unlimited open-weight" },
  { id: "lepton", name: "Lepton AI", type: "inference", models: 20, contextMax: "128K", freetier: false, tier: "direct", badge: "coming-soon", specialty: "Fast inference · serverless · OpenAI-compat" },
  { id: "lambda", name: "Lambda AI", type: "inference", models: 10, contextMax: "128K", freetier: false, tier: "direct", badge: "coming-soon", specialty: "GPU cloud · H100 · OpenAI-compatible API" },
  { id: "baseten", name: "Baseten", type: "inference", models: 20, contextMax: "128K", freetier: false, tier: "direct", badge: "coming-soon", specialty: "Custom model deploy · production-grade" },
  { id: "nvidia-nim", name: "NVIDIA NIM", type: "inference", models: 10, contextMax: "1M", freetier: false, tier: "direct", badge: "coming-soon", specialty: "Nemotron family · optimized NVIDIA hardware" },

  // Tier 3 — planned / not yet routable (25) · badge "coming-soon"
  { id: "moonshot", name: "Moonshot AI", type: "frontier", models: 5, contextMax: "1M", freetier: false, tier: "meta", badge: "integrated", specialty: "Kimi K2.7 Code · frontier coding" },
  { id: "minimax", name: "MiniMax", type: "frontier", models: 3, contextMax: "1M", freetier: false, tier: "meta", badge: "coming-soon", specialty: "MiniMax M3 · 1M context · promo pricing" },
  { id: "stepfun", name: "StepFun", type: "frontier", models: 3, contextMax: "256K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Step 3.7 Flash · fast · multimodal" },
  { id: "zai", name: "Z.AI (GLM)", type: "frontier", models: 5, contextMax: "200K", freetier: true, tier: "meta", badge: "integrated", specialty: "GLM family · free tier · multilingual" },
  { id: "poolside", name: "Poolside", type: "coding", models: 2, contextMax: "256K", freetier: true, tier: "meta", badge: "coming-soon", specialty: "Laguna · coding agents · free tier" },
  { id: "nous", name: "Nous Research", type: "inference", models: 5, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Hermes family · strong instruction following" },
  { id: "noushermes", name: "01.AI", type: "frontier", models: 3, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Yi family · multilingual · Chinese lab" },
  { id: "inflection", name: "Inflection AI", type: "frontier", models: 2, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Pi · conversational AI · emotional intelligence" },
  { id: "reka", name: "Reka AI", type: "frontier", models: 3, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Multimodal · strong on video understanding" },
  { id: "ai21", name: "AI21 Labs", type: "frontier", models: 4, contextMax: "256K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Jamba family · hybrid SSM-Transformer" },
  { id: "comet", name: "Comet API", type: "inference", models: 10, contextMax: "128K", freetier: true, tier: "meta", badge: "coming-soon", specialty: "Aggregator · competitive pricing" },
  { id: "siliconflow", name: "SiliconFlow", type: "inference", models: 30, contextMax: "131K", freetier: true, tier: "meta", badge: "coming-soon", specialty: "Chinese inference · Qwen + DeepSeek hosting" },
  { id: "aihubmix", name: "AiHubMix", type: "inference", models: 50, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Multi-provider aggregator · competitive rates" },
  { id: "ovhcloud", name: "OVHcloud AI", type: "inference", models: 15, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "European sovereign · OpenAI-compatible" },
  { id: "nscale", name: "Nscale", type: "inference", models: 10, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "EU sovereign · GDPR · OpenAI-compatible" },
  { id: "mancer", name: "Mancer", type: "inference", models: 8, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Privacy-first · no logging · uncensored" },
  { id: "klusterai", name: "Kluster AI", type: "inference", models: 5, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Batch processing · cost-optimized" },
  { id: "deepbricks", name: "DeepBricks", type: "inference", models: 20, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "OpenAI-compatible · wide model access" },
  { id: "nineteen", name: "Nineteen AI", type: "inference", models: 10, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Decentralized inference · competitive" },
  { id: "hyperbolic", name: "Hyperbolic", type: "inference", models: 10, contextMax: "131K", freetier: true, tier: "meta", badge: "coming-soon", specialty: "GPU marketplace · fine-tuning · free credits" },
  { id: "infermatic", name: "Infermatic", type: "inference", models: 8, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Low-cost inference · open models" },
  { id: "avian", name: "Avian", type: "inference", models: 5, contextMax: "128K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "OpenAI-compatible · fast routing" },
  { id: "chutes", name: "Chutes AI", type: "inference", models: 10, contextMax: "128K", freetier: true, tier: "meta", badge: "coming-soon", specialty: "Decentralized · community-run GPUs" },
  { id: "friendliai", name: "FriendliAI", type: "inference", models: 8, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "Production-grade · SLA · OpenAI-compat" },
  { id: "predibase", name: "Predibase", type: "inference", models: 10, contextMax: "131K", freetier: false, tier: "meta", badge: "coming-soon", specialty: "LoRA fine-tuning · serverless adapters" },
];

// ── MODELS (100) — curated across families ──────────────────────────────────────
//     64 are routable today (provider in ROUTABLE_PROVIDER_IDS); the other 36 are
//     "Planned — not yet routable" (isRoutableModel() === false) and the catalog
//     UI labels them as such — names/prices are kept verbatim for transparency.
export const MODELS: Model[] = [
  // Anthropic (5)
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", family: "claude", contextWindow: "200K", inputPer1M: 1.00, outputPer1M: 5.00, tier: "T1", free: false, specialty: "Claude quality at T1 price", routingTags: ["claude","quality","balanced"] },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", family: "claude", contextWindow: "1M", inputPer1M: 3.00, outputPer1M: 15.00, tier: "T2", free: false, specialty: "Managed ceiling · best balance", routingTags: ["claude","flagship","ceiling"] },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", family: "claude", contextWindow: "1M", inputPer1M: 5.00, outputPer1M: 25.00, tier: "BYOK", free: false, specialty: "Best coder · frontier · BYOK only", routingTags: ["claude","coding","frontier"] },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic", family: "claude", contextWindow: "1M", inputPer1M: 5.00, outputPer1M: 25.00, tier: "BYOK", free: false, specialty: "Vision + long-horizon agents", routingTags: ["claude","vision","agents"] },
  { id: "claude-haiku-3-5", name: "Claude Haiku 3.5", provider: "anthropic", family: "claude", contextWindow: "200K", inputPer1M: 0.80, outputPer1M: 4.00, tier: "T1", free: false, specialty: "Older Haiku · still available", routingTags: ["claude","budget"] },
  // OpenAI (10)
  { id: "gpt-4-1-nano", name: "GPT-4.1 Nano", provider: "openai", family: "gpt", contextWindow: "1M", inputPer1M: 0.10, outputPer1M: 0.40, tier: "BYOK", free: false, specialty: "Cheapest OpenAI · 1M context", routingTags: ["openai","budget","long-context"] },
  { id: "gpt-4-1-mini", name: "GPT-4.1 Mini", provider: "openai", family: "gpt", contextWindow: "1M", inputPer1M: 0.40, outputPer1M: 1.60, tier: "BYOK", free: false, specialty: "Best budget OpenAI", routingTags: ["openai","budget"] },
  { id: "gpt-4-1", name: "GPT-4.1", provider: "openai", family: "gpt", contextWindow: "1M", inputPer1M: 2.00, outputPer1M: 8.00, tier: "BYOK", free: false, specialty: "OpenAI flagship · 1M context", routingTags: ["openai","flagship"] },
  { id: "gpt-5-5", name: "GPT-5.5", provider: "openai", family: "gpt", contextWindow: "400K", inputPer1M: 5.00, outputPer1M: 30.00, tier: "BYOK", free: false, specialty: "Latest OpenAI frontier", routingTags: ["openai","frontier"] },
  { id: "o3-mini", name: "o3-mini", provider: "openai", family: "o-series", contextWindow: "200K", inputPer1M: 1.10, outputPer1M: 4.40, tier: "BYOK", free: false, specialty: "Budget reasoning", routingTags: ["openai","reasoning","budget"] },
  { id: "o4-mini", name: "o4-mini", provider: "openai", family: "o-series", contextWindow: "200K", inputPer1M: 1.10, outputPer1M: 4.40, tier: "BYOK", free: false, specialty: "Latest budget reasoning", routingTags: ["openai","reasoning"] },
  { id: "o3", name: "o3", provider: "openai", family: "o-series", contextWindow: "200K", inputPer1M: 2.00, outputPer1M: 8.00, tier: "BYOK", free: false, specialty: "Strong reasoning · 80% cheaper than launch", routingTags: ["openai","reasoning","strong"] },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", provider: "groq", family: "gpt-oss", contextWindow: "131K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "OpenAI open-weight · free on Groq/OR", routingTags: ["openai","free","open"] },
  { id: "gpt-oss-20b", name: "GPT-OSS 20B", provider: "together", family: "gpt-oss", contextWindow: "32K", inputPer1M: 0.05, outputPer1M: 0.20, tier: "T0", free: false, specialty: "Ultra-cheap OpenAI open model", routingTags: ["openai","budget","fast"] },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", family: "gpt", contextWindow: "128K", inputPer1M: 2.50, outputPer1M: 10.00, tier: "BYOK", free: false, specialty: "Previous gen · multimodal", routingTags: ["openai","multimodal"] },
  // Google (10)
  { id: "gemini-flash-lite", name: "Gemini 2.5 Flash Lite", provider: "gemini", family: "gemini", contextWindow: "1M", inputPer1M: 0.10, outputPer1M: 0.40, tier: "T0", free: false, specialty: "Cheapest Google paid", routingTags: ["google","budget","fast"] },
  { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash", provider: "gemini", family: "gemini", contextWindow: "1M", inputPer1M: 0.30, outputPer1M: 2.50, tier: "T0", free: false, specialty: "Fast capable Google", routingTags: ["google","fast","balanced"] },
  { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", provider: "gemini", family: "gemini", contextWindow: "1M", inputPer1M: 1.50, outputPer1M: 9.00, tier: "T1", free: false, specialty: "Beats 3.1 Pro on coding · May 2026", routingTags: ["google","coding","multimodal"] },
  { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", provider: "gemini", family: "gemini", contextWindow: "1M", inputPer1M: 1.25, outputPer1M: 10.00, tier: "T1", free: false, specialty: "Best Google reasoning value", routingTags: ["google","reasoning"] },
  { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", provider: "gemini", family: "gemini", contextWindow: "1M", inputPer1M: 2.00, outputPer1M: 12.00, tier: "T2", free: false, specialty: "Google flagship", routingTags: ["google","flagship"] },
  { id: "gemma-4-31b-free", name: "Gemma 4 31B", provider: "openrouter", family: "gemma", contextWindow: "256K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Multimodal · 140 languages · free", routingTags: ["google","multimodal","free"] },
  { id: "gemma-4-26b-moe", name: "Gemma 4 26B MoE", provider: "openrouter", family: "gemma", contextWindow: "256K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Efficient MoE · 3.8B active params", routingTags: ["google","efficient","free"] },
  { id: "gemma-4-31b-paid", name: "Gemma 4 31B (paid)", provider: "together", family: "gemma", contextWindow: "128K", inputPer1M: 0.20, outputPer1M: 0.20, tier: "T0", free: false, specialty: "Equal input/output pricing", routingTags: ["google","multimodal","cheap"] },
  { id: "gemini-flash-15", name: "Gemini 1.5 Flash", provider: "gemini", family: "gemini", contextWindow: "1M", inputPer1M: 0.075, outputPer1M: 0.30, tier: "T0", free: false, specialty: "Legacy · still competitive", routingTags: ["google","budget","legacy"] },
  { id: "gemini-pro-15", name: "Gemini 1.5 Pro", provider: "gemini", family: "gemini", contextWindow: "2M", inputPer1M: 1.25, outputPer1M: 5.00, tier: "T1", free: false, specialty: "Legacy 2M context option", routingTags: ["google","long-context","legacy"] },
  // Meta Llama (10)
  { id: "llama-4-scout-free", name: "Llama 4 Scout", provider: "openrouter", family: "llama4", contextWindow: "10M", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "10M context · longest free ctx ever", routingTags: ["meta","long-context","free"] },
  { id: "llama-4-scout-paid", name: "Llama 4 Scout", provider: "together", family: "llama4", contextWindow: "10M", inputPer1M: 0.10, outputPer1M: 0.30, tier: "T0", free: false, specialty: "Cheapest long-context paid option", routingTags: ["meta","long-context"] },
  { id: "llama-4-maverick-free", name: "Llama 4 Maverick", provider: "openrouter", family: "llama4", contextWindow: "1M", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Multimodal · 1M context · free", routingTags: ["meta","multimodal","free"] },
  { id: "llama-4-maverick", name: "Llama 4 Maverick", provider: "fireworks", family: "llama4", contextWindow: "1M", inputPer1M: 0.15, outputPer1M: 0.60, tier: "T0", free: false, specialty: "Strong general open model", routingTags: ["meta","general"] },
  { id: "llama-3-3-70b-free", name: "Llama 3.3 70B", provider: "groq", family: "llama3", contextWindow: "131K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Most-used free model on OR", routingTags: ["meta","free","reliable"] },
  { id: "llama-3-3-70b", name: "Llama 3.3 70B", provider: "groq", family: "llama3", contextWindow: "128K", inputPer1M: 0.59, outputPer1M: 0.79, tier: "T0", free: false, specialty: "Fastest 70B · 394 TPS on Groq", routingTags: ["meta","fast","reliable"] },
  { id: "llama-3-1-8b", name: "Llama 3.1 8B Instant", provider: "groq", family: "llama3", contextWindow: "128K", inputPer1M: 0.05, outputPer1M: 0.08, tier: "T0", free: false, specialty: "Cheapest + fastest · default T0", routingTags: ["meta","fast","cheap","default"] },
  { id: "llama-3-1-70b", name: "Llama 3.1 70B", provider: "groq", family: "llama3", contextWindow: "128K", inputPer1M: 0.59, outputPer1M: 0.79, tier: "T0", free: false, specialty: "Reliable workhorse", routingTags: ["meta","reliable"] },
  { id: "llama-3-1-405b", name: "Llama 3.1 405B", provider: "together", family: "llama3", contextWindow: "128K", inputPer1M: 3.50, outputPer1M: 3.50, tier: "T2", free: false, specialty: "Largest open model available", routingTags: ["meta","large","powerful"] },
  { id: "llama-3-2-11b", name: "Llama 3.2 11B Vision", provider: "groq", family: "llama3", contextWindow: "128K", inputPer1M: 0.18, outputPer1M: 0.18, tier: "T0", free: false, specialty: "Vision + text · multimodal T0", routingTags: ["meta","vision","cheap"] },
  // DeepSeek (7)
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", family: "deepseek", contextWindow: "1M", inputPer1M: 0.14, outputPer1M: 0.28, tier: "T0", free: false, specialty: "Best cheap coder · MIT · 1M ctx", routingTags: ["deepseek","coding","cheap"] },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", family: "deepseek", contextWindow: "1M", inputPer1M: 1.74, outputPer1M: 3.48, tier: "T1", free: false, specialty: "Hard reasoning + code", routingTags: ["deepseek","reasoning","coding"] },
  { id: "deepseek-r1-free", name: "DeepSeek R1", provider: "openrouter", family: "deepseek", contextWindow: "164K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Best free reasoning model", routingTags: ["deepseek","reasoning","free"] },
  { id: "deepseek-r1", name: "DeepSeek R1", provider: "deepseek", family: "deepseek", contextWindow: "164K", inputPer1M: 0.55, outputPer1M: 2.19, tier: "T0", free: false, specialty: "MIT reasoning · matches o1 benchmarks", routingTags: ["deepseek","reasoning"] },
  { id: "deepseek-v3-free", name: "DeepSeek V3", provider: "openrouter", family: "deepseek", contextWindow: "164K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Strong general · free", routingTags: ["deepseek","general","free"] },
  { id: "deepseek-v3", name: "DeepSeek V3", provider: "deepseek", family: "deepseek", contextWindow: "164K", inputPer1M: 0.20, outputPer1M: 0.77, tier: "T0", free: false, specialty: "Strong general · MIT", routingTags: ["deepseek","general"] },
  { id: "deepseek-v3-1", name: "DeepSeek V3.1", provider: "together", family: "deepseek", contextWindow: "164K", inputPer1M: 0.60, outputPer1M: 1.70, tier: "T0", free: false, specialty: "US-hosted DeepSeek · stable latency", routingTags: ["deepseek","general","us-hosted"] },
  // xAI Grok (7)
  { id: "grok-4-1-fast", name: "Grok 4.1 Fast", provider: "xai", family: "grok", contextWindow: "2M", inputPer1M: 0.20, outputPer1M: 0.50, tier: "T0", free: false, specialty: "2M ctx · cheapest long-context", routingTags: ["xai","long-context","fast"] },
  { id: "grok-4-3", name: "Grok 4.3", provider: "xai", family: "grok", contextWindow: "1M", inputPer1M: 1.25, outputPer1M: 2.50, tier: "T1", free: false, specialty: "Flagship · real-time data · X access", routingTags: ["xai","reasoning","realtime"] },
  { id: "grok-4-20-nr", name: "Grok 4.20 (standard)", provider: "xai", family: "grok", contextWindow: "1M", inputPer1M: 1.25, outputPer1M: 2.50, tier: "T1", free: false, specialty: "xAI production standard", routingTags: ["xai","balanced"] },
  { id: "grok-4-20-r", name: "Grok 4.20 Reasoning", provider: "xai", family: "grok", contextWindow: "1M", inputPer1M: 1.25, outputPer1M: 2.50, tier: "T1", free: false, specialty: "Chain-of-thought reasoning", routingTags: ["xai","reasoning"] },
  { id: "grok-4-20-ma", name: "Grok 4.20 Multi-Agent", provider: "xai", family: "grok", contextWindow: "2M", inputPer1M: 1.25, outputPer1M: 2.50, tier: "T1", free: false, specialty: "2M context · multi-agent orchestration", routingTags: ["xai","agents","long-context"] },
  { id: "grok-build", name: "Grok Build 0.1", provider: "xai", family: "grok", contextWindow: "256K", inputPer1M: 1.00, outputPer1M: 2.00, tier: "T1", free: false, specialty: "Coding specialist", routingTags: ["xai","coding"] },
  { id: "grok-4-heavy", name: "Grok 4 Heavy", provider: "xai", family: "grok", contextWindow: "256K", inputPer1M: 3.00, outputPer1M: 15.00, tier: "BYOK", free: false, specialty: "Multi-agent · HLE 50.7% · BYOK only", routingTags: ["xai","frontier","agents"] },
  // Alibaba Qwen (8)
  { id: "qwen3-coder-free", name: "Qwen3 Coder 480B", provider: "openrouter", family: "qwen", contextWindow: "262K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Best free coder globally · Jun 2026", routingTags: ["qwen","coding","free"] },
  { id: "qwen3-235b-moe", name: "Qwen3 235B MoE", provider: "openrouter", family: "qwen", contextWindow: "131K", inputPer1M: 0.46, outputPer1M: 1.82, tier: "T0", free: false, specialty: "Flagship open-weight · top OR volume", routingTags: ["qwen","flagship","open"] },
  { id: "qwen3-7-plus", name: "Qwen3.7 Plus", provider: "together", family: "qwen", contextWindow: "1M", inputPer1M: 0.40, outputPer1M: 1.60, tier: "T0", free: false, specialty: "1M context Qwen", routingTags: ["qwen","long-context"] },
  { id: "qwen3-6-27b", name: "Qwen3.6 27B", provider: "deepinfra", family: "qwen", contextWindow: "262K", inputPer1M: 0.32, outputPer1M: 3.20, tier: "T0", free: false, specialty: "Multimodal · image + video + text", routingTags: ["qwen","multimodal"] },
  { id: "qwen-2-5-7b-free", name: "Qwen 2.5 7B", provider: "openrouter", family: "qwen", contextWindow: "32K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Lightweight free · classification", routingTags: ["qwen","light","free"] },
  { id: "qwen-3-6-plus", name: "Qwen3.6 Plus", provider: "together", family: "qwen", contextWindow: "1M", inputPer1M: 0.50, outputPer1M: 3.00, tier: "T0", free: false, specialty: "Balanced Qwen · 1M context", routingTags: ["qwen","balanced"] },
  { id: "qwen-2-5-72b", name: "Qwen 2.5 72B", provider: "together", family: "qwen", contextWindow: "131K", inputPer1M: 0.90, outputPer1M: 0.90, tier: "T0", free: false, specialty: "Solid mid-size Qwen", routingTags: ["qwen","reliable"] },
  { id: "qwen-3-5-397b", name: "Qwen3.5 397B MoE", provider: "together", family: "qwen", contextWindow: "131K", inputPer1M: 0.60, outputPer1M: 3.60, tier: "T1", free: false, specialty: "Large MoE Qwen · strong reasoning", routingTags: ["qwen","reasoning","large"] },
  // Mistral (8)
  { id: "mistral-small-free", name: "Mistral Small", provider: "openrouter", family: "mistral", contextWindow: "32K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "EU option · free", routingTags: ["mistral","eu","free"] },
  { id: "mistral-3b", name: "Ministral 3B", provider: "mistral", family: "mistral", contextWindow: "128K", inputPer1M: 0.04, outputPer1M: 0.04, tier: "T0", free: false, specialty: "Cheapest Mistral · equal in/out", routingTags: ["mistral","cheap","fast"] },
  { id: "mistral-nemo", name: "Mistral Nemo", provider: "mistral", family: "mistral", contextWindow: "131K", inputPer1M: 0.13, outputPer1M: 0.13, tier: "T0", free: false, specialty: "Budget EU option", routingTags: ["mistral","budget","eu"] },
  { id: "mistral-medium-3", name: "Mistral Medium 3", provider: "mistral", family: "mistral", contextWindow: "131K", inputPer1M: 0.40, outputPer1M: 2.00, tier: "T0", free: false, specialty: "Solid EU mid-range", routingTags: ["mistral","balanced","eu"] },
  { id: "mistral-large-2", name: "Mistral Large 2", provider: "mistral", family: "mistral", contextWindow: "128K", inputPer1M: 2.00, outputPer1M: 6.00, tier: "T1", free: false, specialty: "EU flagship · GDPR-native", routingTags: ["mistral","flagship","eu"] },
  { id: "mixtral-8x22b", name: "Mixtral 8x22B", provider: "together", family: "mistral", contextWindow: "64K", inputPer1M: 1.20, outputPer1M: 1.20, tier: "T1", free: false, specialty: "MoE classic · strong benchmark", routingTags: ["mistral","moe","reliable"] },
  { id: "mistral-7b", name: "Mistral 7B", provider: "together", family: "mistral", contextWindow: "32K", inputPer1M: 0.10, outputPer1M: 0.10, tier: "T0", free: false, specialty: "Original · ultra-cheap", routingTags: ["mistral","cheap","classic"] },
  { id: "codestral", name: "Codestral", provider: "mistral", family: "mistral", contextWindow: "256K", inputPer1M: 0.30, outputPer1M: 0.90, tier: "T0", free: false, specialty: "Code-specialized Mistral", routingTags: ["mistral","coding"] },
  // NVIDIA (5)
  { id: "nemotron-ultra-free", name: "Nemotron 3 Ultra 550B", provider: "openrouter", family: "nemotron", contextWindow: "1M", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "1M ctx · frontier reasoning · free", routingTags: ["nvidia","reasoning","free","long-context"] },
  { id: "nemotron-super-free", name: "Nemotron 3 Super 120B", provider: "openrouter", family: "nemotron", contextWindow: "1M", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Agentic · 1M ctx · free", routingTags: ["nvidia","agents","free"] },
  { id: "nemotron-super", name: "Nemotron 3 Super 120B", provider: "deepinfra", family: "nemotron", contextWindow: "1M", inputPer1M: 0.09, outputPer1M: 0.45, tier: "T0", free: false, specialty: "Cheapest 1M ctx paid model", routingTags: ["nvidia","long-context","cheap"] },
  { id: "nemotron-nano", name: "Nemotron 3 Nano 30B", provider: "openrouter", family: "nemotron", contextWindow: "128K", inputPer1M: 0.05, outputPer1M: 0.10, tier: "T0", free: false, specialty: "Edge · tiny MoE · fast", routingTags: ["nvidia","fast","light"] },
  { id: "nemotron-4-340b", name: "Nemotron 4 340B", provider: "nvidia-nim", family: "nemotron", contextWindow: "128K", inputPer1M: 0.40, outputPer1M: 0.40, tier: "T0", free: false, specialty: "Reward model · RLHF training data", routingTags: ["nvidia","reward","research"] },
  // Cohere (5)
  { id: "command-r7b", name: "Command R7B", provider: "cohere", family: "command", contextWindow: "128K", inputPer1M: 0.04, outputPer1M: 0.15, tier: "T0", free: false, specialty: "Cheapest first-party RAG model", routingTags: ["cohere","rag","cheap"] },
  { id: "command-r", name: "Command R", provider: "cohere", family: "command", contextWindow: "128K", inputPer1M: 0.15, outputPer1M: 0.60, tier: "T0", free: false, specialty: "Grounded generation · citations", routingTags: ["cohere","rag"] },
  { id: "command-r-plus", name: "Command R+", provider: "cohere", family: "command", contextWindow: "128K", inputPer1M: 2.50, outputPer1M: 10.00, tier: "T1", free: false, specialty: "RAG flagship · full retrieval stack", routingTags: ["cohere","rag","flagship"] },
  { id: "embed-v3-english", name: "Embed v3 English", provider: "cohere", family: "embed", contextWindow: "512", inputPer1M: 0.10, outputPer1M: 0.00, tier: "T0", free: false, specialty: "Best English embeddings", routingTags: ["cohere","embeddings"] },
  // Rerank has no token-based invoice (Cohere bills per search unit, not per
  // token: $2.00 / 1K search units — cohere.com/pricing, matches the $1-2.50/1k
  // range in docs/economics/PROVIDER-SURVEY-2026-07.md). It is genuinely NOT
  // free (unlike this catalog's real free:true entries), so $0/$0 previously
  // rendered as free-looking while being excluded from the "Free only" filter.
  // inputPer1M carries the real $2.00 figure with the unit called out in
  // `specialty` so it is never misread as $2.00-per-million-tokens.
  { id: "rerank-v3", name: "Rerank v3", provider: "cohere", family: "rerank", contextWindow: "4K", inputPer1M: 2.00, outputPer1M: 0.00, tier: "T0", free: false, specialty: "Reranking for RAG pipelines · $2/1K search units (not per-token)", routingTags: ["cohere","reranking","rag"] },
  // Perplexity Sonar (5)
  { id: "sonar-small", name: "Sonar Small", provider: "perplexity", family: "sonar", contextWindow: "131K", inputPer1M: 0.20, outputPer1M: 0.20, tier: "T0", free: false, specialty: "Web-grounded · live citations", routingTags: ["perplexity","search","web"] },
  { id: "sonar", name: "Sonar", provider: "perplexity", family: "sonar", contextWindow: "131K", inputPer1M: 0.30, outputPer1M: 0.30, tier: "T0", free: false, specialty: "Balanced search-grounded", routingTags: ["perplexity","search"] },
  { id: "sonar-pro", name: "Sonar Pro", provider: "perplexity", family: "sonar", contextWindow: "200K", inputPer1M: 3.00, outputPer1M: 15.00, tier: "T1", free: false, specialty: "Deep research · 200K ctx", routingTags: ["perplexity","search","deep"] },
  { id: "sonar-reasoning", name: "Sonar Reasoning", provider: "perplexity", family: "sonar", contextWindow: "131K", inputPer1M: 1.00, outputPer1M: 5.00, tier: "T1", free: false, specialty: "Reasoning + web grounding", routingTags: ["perplexity","reasoning","search"] },
  { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", provider: "perplexity", family: "sonar", contextWindow: "200K", inputPer1M: 2.00, outputPer1M: 8.00, tier: "T1", free: false, specialty: "Deep reasoning + deep research", routingTags: ["perplexity","reasoning","deep"] },
  // Chinese labs (12)
  { id: "kimi-k2-7-code", name: "Kimi K2.7 Code", provider: "openrouter", family: "kimi", contextWindow: "1M", inputPer1M: 0.95, outputPer1M: 4.00, tier: "T1", free: false, specialty: "Frontier coding · Moonshot AI", routingTags: ["moonshot","coding"] },
  { id: "minimax-m3", name: "MiniMax M3", provider: "openrouter", family: "minimax", contextWindow: "1M", inputPer1M: 0.30, outputPer1M: 1.20, tier: "T0", free: false, specialty: "1M ctx · top OR coding rankings", routingTags: ["minimax","long-context"] },
  { id: "step-3-7-flash", name: "Step 3.7 Flash", provider: "openrouter", family: "step", contextWindow: "256K", inputPer1M: 0.20, outputPer1M: 1.15, tier: "T0", free: false, specialty: "Fast · multimodal · coding", routingTags: ["stepfun","fast","coding"] },
  { id: "glm-4-5-air-free", name: "GLM-4.5-Air", provider: "openrouter", family: "glm", contextWindow: "131K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Chinese/multilingual · free", routingTags: ["zai","multilingual","free"] },
  { id: "glm-5-1", name: "GLM-5.1", provider: "together", family: "glm", contextWindow: "200K", inputPer1M: 0.50, outputPer1M: 2.00, tier: "T0", free: false, specialty: "Z.AI coding flagship", routingTags: ["zai","coding"] },
  { id: "minimax-m2-7", name: "MiniMax M2.7", provider: "together", family: "minimax", contextWindow: "1M", inputPer1M: 0.30, outputPer1M: 1.20, tier: "T0", free: false, specialty: "Prior MiniMax · stable pricing", routingTags: ["minimax","balanced"] },
  { id: "poolside-laguna-free", name: "Poolside Laguna", provider: "openrouter", family: "poolside", contextWindow: "256K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Coding agents · free", routingTags: ["poolside","coding","free"] },
  { id: "kimi-k2-6", name: "Kimi K2.6", provider: "fireworks", family: "kimi", contextWindow: "1M", inputPer1M: 0.95, outputPer1M: 4.00, tier: "T1", free: false, specialty: "Coding · Moonshot AI", routingTags: ["moonshot","coding"] },
  { id: "glm-4-plus", name: "GLM-4 Plus", provider: "openrouter", family: "glm", contextWindow: "128K", inputPer1M: 0.10, outputPer1M: 0.10, tier: "T0", free: false, specialty: "Budget GLM · equal in/out pricing", routingTags: ["zai","budget"] },
  { id: "qwq-32b", name: "QwQ 32B", provider: "together", family: "qwen", contextWindow: "131K", inputPer1M: 0.15, outputPer1M: 0.15, tier: "T0", free: false, specialty: "Alibaba reasoning · strong benchmarks", routingTags: ["qwen","reasoning"] },
  { id: "yi-large", name: "Yi Large", provider: "openrouter", family: "yi", contextWindow: "32K", inputPer1M: 0.30, outputPer1M: 0.30, tier: "T0", free: false, specialty: "01.AI · multilingual", routingTags: ["01ai","multilingual"] },
  { id: "yi-lightning", name: "Yi Lightning", provider: "openrouter", family: "yi", contextWindow: "16K", inputPer1M: 0.14, outputPer1M: 0.14, tier: "T0", free: false, specialty: "Fast · cheap · 01.AI", routingTags: ["01ai","fast","cheap"] },
  // Specialty + misc (8)
  { id: "nous-hermes-3-70b", name: "Hermes 3 70B", provider: "deepinfra", family: "hermes", contextWindow: "131K", inputPer1M: 0.70, outputPer1M: 0.70, tier: "T0", free: false, specialty: "Strong instruction · agentic", routingTags: ["nous","instruction","agents"] },
  { id: "owl-alpha", name: "Owl Alpha", provider: "openrouter", family: "owl", contextWindow: "131K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Tool use · agentic · free", routingTags: ["owl","tools","free"] },
  { id: "mimo-v2-5", name: "MiMo V2.5", provider: "openrouter", family: "mimo", contextWindow: "131K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Top OR coding ranking Jun 2026", routingTags: ["mimo","coding","free"] },
  { id: "phi-4", name: "Phi-4", provider: "openrouter", family: "phi", contextWindow: "16K", inputPer1M: 0.00, outputPer1M: 0.00, tier: "FREE", free: true, specialty: "Microsoft open · tiny but capable", routingTags: ["microsoft","light","free"] },
  { id: "jamba-1-6-mini", name: "Jamba 1.6 Mini", provider: "openrouter", family: "jamba", contextWindow: "256K", inputPer1M: 0.20, outputPer1M: 0.40, tier: "T0", free: false, specialty: "Hybrid SSM-Transformer · AI21", routingTags: ["ai21","efficient"] },
  { id: "jamba-1-6-large", name: "Jamba 1.6 Large", provider: "openrouter", family: "jamba", contextWindow: "256K", inputPer1M: 0.40, outputPer1M: 1.60, tier: "T0", free: false, specialty: "Large hybrid SSM-Transformer", routingTags: ["ai21","efficient","powerful"] },
  { id: "command-nightly", name: "Command Nightly", provider: "cohere", family: "command", contextWindow: "128K", inputPer1M: 0.15, outputPer1M: 0.60, tier: "T0", free: false, specialty: "Latest Cohere research build", routingTags: ["cohere","latest"] },
  { id: "solar-pro", name: "SOLAR Pro", provider: "openrouter", family: "solar", contextWindow: "4K", inputPer1M: 0.18, outputPer1M: 0.18, tier: "T0", free: false, specialty: "Upstage AI · Korean/English bilingual", routingTags: ["upstage","bilingual"] },
];
