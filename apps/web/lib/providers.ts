import type { ProviderId } from "@zintus/types";

export interface ProviderDisplay {
  id: ProviderId;
  name: string;
  color: string;
  priority: number;
  quotaLimit: number;
}

export const PROVIDERS: ProviderDisplay[] = [
  { id: "cerebras", name: "Cerebras", color: "#f59e0b", priority: 1, quotaLimit: 1_000_000 },
  { id: "groq", name: "Groq", color: "#10b981", priority: 2, quotaLimit: 1_000_000 },
  { id: "gemini", name: "Gemini", color: "#3b82f6", priority: 3, quotaLimit: 1_000_000 },
  { id: "openrouter", name: "OpenRouter", color: "#8b5cf6", priority: 4, quotaLimit: 1_000_000 },
  { id: "cohere", name: "Cohere", color: "#06B6D4", priority: 5, quotaLimit: 1_000_000 },
  { id: "mistral", name: "Mistral", color: "#F97316", priority: 6, quotaLimit: 1_000_000 },
  { id: "deepseek", name: "DeepSeek", color: "#EC4899", priority: 7, quotaLimit: 1_000_000 },
  { id: "fireworks", name: "Fireworks AI", color: "#22C55E", priority: 8, quotaLimit: 1_000_000 },
  { id: "xai", name: "xAI Grok", color: "#0EA5E9", priority: 9, quotaLimit: 1_000_000 },
  { id: "huggingface", name: "Hugging Face", color: "#F59E0B", priority: 10, quotaLimit: 1_000_000 },
  { id: "lmstudio", name: "LM Studio", color: "#6366F1", priority: 98, quotaLimit: 1_000_000 },
  { id: "ollama", name: "Ollama", color: "#8B5CF6", priority: 99, quotaLimit: 1_000_000 },
];

export const PROVIDER_BY_ID = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider]),
) as Record<ProviderId, ProviderDisplay>;

/** Local, on-device runtimes — no API key, no quota, detected by probing a
 *  loopback port. Shared by the Providers page and the chat composer's
 *  pinned-provider notice so "is this provider local?" has one answer. */
export const LOCAL_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "ollama",
  "lmstudio",
]);
