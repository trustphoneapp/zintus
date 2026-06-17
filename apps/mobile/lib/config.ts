import { createMMKV } from "react-native-mmkv";
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type ProviderId,
  type RoutingStrategy,
} from "@multipleai/types";

const storage = createMMKV({ id: "multipleai.config" });
const STORAGE_KEY = "config";
const SELECTED_PROVIDER_KEY = "selectedProvider";

export function loadConfig(): AppConfig {
  const raw = storage.getString(STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...partial };
  storage.set(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function isRoutingStrategy(value: string): value is RoutingStrategy {
  return ["fastest", "capability", "economy"].includes(value);
}

export function loadSelectedProvider(): ProviderId {
  return (storage.getString(SELECTED_PROVIDER_KEY) as ProviderId | undefined) ?? "groq";
}

export function saveSelectedProvider(providerId: ProviderId): void {
  storage.set(SELECTED_PROVIDER_KEY, providerId);
}

export const ROUTING_STRATEGIES: Array<{
  value: RoutingStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "fastest",
    label: "Fastest",
    description:
      "Prefer the provider with the lowest recent p95 latency; falls back to priority order until enough samples exist.",
  },
  {
    value: "capability",
    label: "Capability",
    description: "Prefer higher-capability models first.",
  },
  {
    value: "economy",
    label: "Economy",
    description: "Spread usage across providers with the most remaining quota.",
  },
];
