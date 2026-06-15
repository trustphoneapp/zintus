import type { ProviderId } from "@multipleai/types";

export interface ProviderDisplay {
  id: ProviderId;
  name: string;
  color: string;
  priority: number;
  quotaLimit: number;
}

export const PROVIDERS: ProviderDisplay[] = [
  { id: "cerebras", name: "Cerebras", color: "#10B981", priority: 1, quotaLimit: 1_000_000 },
  { id: "groq", name: "Groq", color: "#F59E0B", priority: 2, quotaLimit: 1_000_000 },
  { id: "gemini", name: "Gemini", color: "#3B82F6", priority: 3, quotaLimit: 1_000_000 },
  { id: "openrouter", name: "OpenRouter", color: "#A855F7", priority: 4, quotaLimit: 1_000_000 },
  { id: "cohere", name: "Cohere", color: "#06B6D4", priority: 5, quotaLimit: 1_000_000 },
  { id: "mistral", name: "Mistral", color: "#F97316", priority: 6, quotaLimit: 1_000_000 },
  { id: "deepseek", name: "DeepSeek", color: "#EC4899", priority: 7, quotaLimit: 1_000_000 },
  { id: "ollama", name: "Ollama", color: "#8B5CF6", priority: 99, quotaLimit: 1_000_000 },
];

export const PROVIDER_BY_ID = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider]),
) as Record<ProviderId, ProviderDisplay>;
