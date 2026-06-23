import type { ProviderId, RoutingStrategy } from "@zintus/types";

const STORAGE_KEY = "zintus:presets";

/** A named bundle of routing + prompt + params, stored locally in the browser. */
export interface Preset {
  id: string;
  name: string;
  provider?: ProviderId;
  strategy?: RoutingStrategy;
  systemPrompt?: string;
  temperature?: number;
}

export function loadPresets(): Preset[] {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: Preset[]): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  }
}
