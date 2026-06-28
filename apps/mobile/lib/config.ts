import { createMMKV } from "react-native-mmkv";
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type ProviderId,
  type RoutingStrategy,
} from "@zintus/types";

const storage = createMMKV({ id: "zintus.config" });
const STORAGE_KEY = "config";
const SELECTED_PROVIDER_KEY = "selectedProvider";
const SELECTED_MODEL_KEY = "zintus:selected-model";
const JSON_MODE_KEY = "jsonMode";
const TOOLS_MODE_KEY = "toolsMode";

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

/**
 * The catalog model the user picked via "Use this model" on the catalog screen.
 * Mirrors the web's persisted `zintus:selected-model` ({ id, provider,
 * displayName }). Mobile routes chat by PROVIDER (the gateway picks the concrete
 * model), so saving a selection also calls {@link saveSelectedProvider}; this
 * record is what the catalog/chat surfaces read to show the ACTIVE selection.
 */
export interface SelectedModel {
  id: string;
  provider: ProviderId;
  displayName: string;
}

export function loadSelectedModel(): SelectedModel | null {
  const raw = storage.getString(SELECTED_MODEL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SelectedModel>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.provider === "string" &&
      typeof parsed.displayName === "string"
    ) {
      return parsed as SelectedModel;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the picked model AND switch the active provider so chat routes to it. */
export function saveSelectedModel(model: SelectedModel): void {
  storage.set(SELECTED_MODEL_KEY, JSON.stringify(model));
  saveSelectedProvider(model.provider);
}

export function clearSelectedModel(): void {
  storage.remove(SELECTED_MODEL_KEY);
}

/**
 * Structured-output (JSON) toggle for the chat composer, persisted across
 * launches. When on, a turn requests `response_format: { type: "json_object" }`;
 * the gateway resolves the best level the routed provider can serve. Mirrors
 * desktop's persisted `zintus:desktop-json` flag.
 */
export function loadJsonMode(): boolean {
  return storage.getBoolean(JSON_MODE_KEY) ?? false;
}

export function saveJsonMode(enabled: boolean): void {
  storage.set(JSON_MODE_KEY, enabled);
}

/**
 * Built-in tool-execution toggle for the chat composer, persisted across
 * launches. When on, a turn sends the eval-free BUILTIN_TOOL_DEFINITIONS and the
 * chat runs the bounded execute→feed-back loop locally (calculator /
 * current_datetime / random_number). Mirrors web/desktop/CLI tool support — the
 * last surface to gain it ("one Zintus" tools-everywhere parity).
 */
export function loadToolsMode(): boolean {
  return storage.getBoolean(TOOLS_MODE_KEY) ?? false;
}

export function saveToolsMode(enabled: boolean): void {
  storage.set(TOOLS_MODE_KEY, enabled);
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
