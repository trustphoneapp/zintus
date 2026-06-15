import { createOpenAiCompatProvider } from "../openai-compat.js";

export const openrouterProvider = createOpenAiCompatProvider({
  id: "openrouter",
  name: "OpenRouter",
  color: "#A855F7",
  priority: 4,
  keyRegex: /^sk-or-[a-zA-Z0-9-]{40,}/,
  defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  baseUrl: "https://openrouter.ai/api/v1",
});

export const cohereProvider = createOpenAiCompatProvider({
  id: "cohere",
  name: "Cohere",
  color: "#06B6D4",
  priority: 5,
  keyRegex: /^[a-zA-Z0-9]{40}$/,
  defaultModel: "command-r-plus-08-2024",
  baseUrl: "https://api.cohere.com/compatibility/v1",
});

export const mistralProvider = createOpenAiCompatProvider({
  id: "mistral",
  name: "Mistral",
  color: "#F97316",
  priority: 6,
  keyRegex: /^[a-zA-Z0-9]{32}$/,
  defaultModel: "mistral-large-latest",
  baseUrl: "https://api.mistral.ai/v1",
});

export const deepseekProvider = createOpenAiCompatProvider({
  id: "deepseek",
  name: "DeepSeek",
  color: "#EC4899",
  priority: 7,
  keyRegex: /^sk-[a-zA-Z0-9]{32,}/,
  defaultModel: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
});
