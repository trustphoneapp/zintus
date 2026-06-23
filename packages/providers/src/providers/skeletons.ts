import { createOpenAiCompatProvider } from "../openai-compat.js";

// For providers whose key format is not reliably documented, do a cheap sanity
// check (non-empty, no whitespace) and rely on the live API call in
// validateKey() as the source of truth. This avoids both rejecting valid keys
// and accepting obvious junk.
const GENERIC_KEY = /^\S{8,}$/;

export const openrouterProvider = createOpenAiCompatProvider({
  id: "openrouter",
  name: "OpenRouter",
  color: "#A855F7",
  priority: 4,
  keyRegex: /^sk-or-[a-zA-Z0-9-]{40,}$/,
  defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  baseUrl: "https://openrouter.ai/api/v1",
  supportsNativeWebSearch: true,
});

export const cohereProvider = createOpenAiCompatProvider({
  id: "cohere",
  name: "Cohere",
  color: "#06B6D4",
  priority: 5,
  keyRegex: GENERIC_KEY,
  defaultModel: "command-r-plus-08-2024",
  baseUrl: "https://api.cohere.com/compatibility/v1",
});

export const mistralProvider = createOpenAiCompatProvider({
  id: "mistral",
  name: "Mistral",
  color: "#F97316",
  priority: 6,
  keyRegex: GENERIC_KEY,
  defaultModel: "mistral-large-latest",
  baseUrl: "https://api.mistral.ai/v1",
});

export const deepseekProvider = createOpenAiCompatProvider({
  id: "deepseek",
  name: "DeepSeek",
  color: "#EC4899",
  priority: 7,
  keyRegex: /^sk-[a-zA-Z0-9]{32,}$/,
  defaultModel: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
});

export const fireworksProvider = createOpenAiCompatProvider({
  id: "fireworks",
  name: "Fireworks AI",
  color: "#22C55E",
  priority: 8,
  keyRegex: GENERIC_KEY,
  defaultModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  baseUrl: "https://api.fireworks.ai/inference/v1",
});

export const xaiProvider = createOpenAiCompatProvider({
  id: "xai",
  name: "xAI Grok",
  color: "#0EA5E9",
  priority: 9,
  keyRegex: /^xai-\S+$/,
  defaultModel: "grok-2-latest",
  baseUrl: "https://api.x.ai/v1",
});

export const huggingFaceProvider = createOpenAiCompatProvider({
  id: "huggingface",
  name: "Hugging Face",
  color: "#F59E0B",
  priority: 10,
  keyRegex: /^hf_[a-zA-Z0-9]{24,}$/,
  defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
  baseUrl: "https://router.huggingface.co/v1",
  validatePath: "/chat/completions",
});

export const lmStudioProvider = createOpenAiCompatProvider({
  id: "lmstudio",
  name: "LM Studio",
  color: "#6366F1",
  priority: 98,
  keyRegex: null,
  defaultModel: "local-model",
  baseUrl: process.env.LM_STUDIO_HOST ?? "http://localhost:1234/v1",
});
