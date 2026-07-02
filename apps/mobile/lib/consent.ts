import { createMMKV } from "react-native-mmkv";

/**
 * One-time, revocable consent that the user's prompts/files/images may leave the
 * device — sent to the AI provider they choose, THROUGH their gateway. Apple
 * Guideline 5.1.2(i) (and good practice) requires explicit consent before
 * sharing personal data with third-party AI; this is the gate the chat composer
 * checks before the first provider send. Local-only (Private) turns never leave
 * the user's machines, so they don't require this consent.
 *
 * The relay is never a destination for this data — see lib/data-flow.ts.
 */

const storage = createMMKV({ id: "zintus.consent" });
const PROVIDER_SEND_KEY = "providerSendConsent.v1";

export function hasProviderSendConsent(): boolean {
  return storage.getBoolean(PROVIDER_SEND_KEY) ?? false;
}

export function grantProviderSendConsent(): void {
  storage.set(PROVIDER_SEND_KEY, true);
}

/** Exposed in Settings so consent is reversible (5.1.2(i) expectation). */
export function revokeProviderSendConsent(): void {
  storage.set(PROVIDER_SEND_KEY, false);
}
