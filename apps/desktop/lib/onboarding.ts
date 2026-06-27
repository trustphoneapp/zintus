/**
 * First-run onboarding completion flag (localStorage). The overlay is skippable;
 * desktop users are technical, so it's a short orientation (BYOK + local gateway
 * + where data goes) rather than a long wizard.
 */

const KEY = "zintus:desktop-onboarding.v1";

export function hasCompletedOnboarding(): boolean {
  if (typeof localStorage === "undefined") return true; // SSR: don't gate render
  return localStorage.getItem(KEY) === "true";
}

export function setOnboardingComplete(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, "true");
}

export function resetOnboarding(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, "false");
}
