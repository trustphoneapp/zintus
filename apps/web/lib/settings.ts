import type { AppConfig, RoutingStrategy } from "@multipleai/types";
import { DEFAULT_CONFIG } from "@multipleai/types";

const STORAGE_KEY = "multipleai.web.settings";

export function loadSettings(): AppConfig {
  if (typeof window === "undefined") {
    return DEFAULT_CONFIG;
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return DEFAULT_CONFIG;
  }

  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveSettings(settings: Partial<AppConfig>): void {
  const current = loadSettings();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...settings }));
}

export const ROUTING_STRATEGIES: Array<{
  value: RoutingStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "fastest",
    label: "Fastest",
    description: "Prefer providers with the most remaining quota.",
  },
  {
    value: "capability",
    label: "Capability",
    description: "Prefer higher-priority models first.",
  },
  {
    value: "economy",
    label: "Economy",
    description: "Spread usage across providers evenly.",
  },
];
