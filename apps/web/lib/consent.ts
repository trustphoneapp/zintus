/**
 * One-time, revocable consent that the user's prompts/files leave the browser —
 * sent to the AI provider they choose, THROUGH their gateway. Parity with the
 * mobile + desktop consent gates (Apple 5.1.2(i) / good practice). The relay is
 * never a destination for this data (auth/session only).
 */

const KEY = "zintus:provider-send-consent.v1";

export function hasProviderSendConsent(): boolean {
  if (typeof localStorage === "undefined") return true; // SSR: don't gate render
  return localStorage.getItem(KEY) === "true";
}

export function grantProviderSendConsent(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, "true");
}

export function revokeProviderSendConsent(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, "false");
}

/** Where each kind of data travels — shown in the consent dialog. */
export const DATA_FLOW: Array<{ data: string; dest: string; detail: string }> = [
  {
    data: "Provider API keys",
    dest: "On device (browser vault)",
    detail: "Encrypted in your browser. Never sent to the relay.",
  },
  {
    data: "Your prompt & files",
    dest: "Your gateway → AI provider",
    detail: "Routed by the gateway you run to the provider you chose, with your key.",
  },
  {
    data: "Sign-in session (if you log in)",
    dest: "Zintus relay",
    detail: "Auth cookie only. The relay never sees prompts, files, or keys.",
  },
];
