import type { ProviderId } from "./provider-id.js";

export type RoutingStrategy = "fastest" | "capability" | "economy";

export interface AppConfig {
  routingStrategy: RoutingStrategy;
  defaultProvider?: ProviderId;
  providerPriority: ProviderId[];
}

export const DEFAULT_CONFIG: AppConfig = {
  routingStrategy: "fastest",
  providerPriority: [
    "cerebras",
    "groq",
    "gemini",
    "openrouter",
    "cohere",
    "mistral",
    "deepseek",
    "ollama",
  ],
};
