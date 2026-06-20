import { DEFAULT_CONFIG, type AppConfig, type RoutingStrategy } from "@zintus/types";

const STORAGE_KEY = "zintus.config";

export function loadConfig(): AppConfig {
  if (typeof window === "undefined") {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...config };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function isRoutingStrategy(value: string): value is RoutingStrategy {
  return ["fastest", "capability", "economy"].includes(value);
}
