import type { ProviderId } from "@zintus/types";
import { SELECTED_MODEL_KEY, type SelectedModel } from "@/app/(app)/models/format";

export { SELECTED_MODEL_KEY };

/**
 * Read the catalog "pin" — written by the Models page's "Use this model"
 * button and the chat composer's model picker (`ProviderPicker`'s `pick()`)
 * — from localStorage. Returns null on missing/malformed storage or SSR
 * (no `localStorage`), never throws.
 */
export function readPinnedModel(): SelectedModel | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SELECTED_MODEL_KEY);
    if (!raw) return null;
    const sel = JSON.parse(raw) as Partial<SelectedModel>;
    if (!sel.id || !sel.provider) return null;
    return { id: sel.id, provider: sel.provider, displayName: sel.displayName ?? sel.id };
  } catch {
    return null;
  }
}

/**
 * Clear the pin and drop back to Auto (per-message) routing. This is the ONE
 * unpin action — the model picker's "Auto" row and the chat composer's
 * pinned-provider notice ("use Auto instead") both call it, so there is a
 * single source of truth for what "unpin" means.
 */
export function unpinModel(setSelectedProvider: (id: ProviderId | null) => void): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(SELECTED_MODEL_KEY);
  } catch {
    /* ignore storage failures — provider is still cleared below */
  }
  setSelectedProvider(null);
}
