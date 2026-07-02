import { createMMKV } from "react-native-mmkv";

/**
 * First-run onboarding completion flag. Kept separate from app config so
 * clearing config/keys doesn't silently re-trigger (or skip) onboarding. The
 * flow is skippable — a user can dismiss it and use the app in a limited state
 * (no gateway / no key), which the chat screen surfaces honestly.
 */

const storage = createMMKV({ id: "zintus.onboarding" });
const DONE_KEY = "completed.v1";

export function hasCompletedOnboarding(): boolean {
  return storage.getBoolean(DONE_KEY) ?? false;
}

export function setOnboardingComplete(): void {
  storage.set(DONE_KEY, true);
}

/** For testing / a "replay onboarding" Settings affordance. */
export function resetOnboarding(): void {
  storage.set(DONE_KEY, false);
}

const PENDING_PROMPT_KEY = "pendingPrompt";

/** Hand the chat screen a sample prompt the user picked during onboarding. */
export function setPendingPrompt(text: string): void {
  storage.set(PENDING_PROMPT_KEY, text);
}

/** Read and clear the pending sample prompt (one-shot prefill). */
export function takePendingPrompt(): string | null {
  const value = storage.getString(PENDING_PROMPT_KEY)?.trim() || null;
  if (value) storage.set(PENDING_PROMPT_KEY, "");
  return value;
}
