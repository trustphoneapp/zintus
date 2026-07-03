/**
 * Theme management: "light" | "dark" | "system", persisted in localStorage and
 * applied as `data-theme` on <html> (tokens live in globals.css). layout.tsx
 * runs INIT_SCRIPT inline before paint so there is never a wrong-theme flash.
 */

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "zintus:theme";

export function getThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** The theme actually on screen right now. */
export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  if (pref !== "system") return pref;
  if (typeof matchMedia === "undefined") return "dark";
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["theme"] = resolvedTheme(pref);
}

export function setThemePreference(pref: ThemePreference): void {
  if (typeof localStorage !== "undefined") {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  }
  applyTheme(pref);
}

/** Toggle between light/dark from whatever is currently resolved. */
export function toggleTheme(): "light" | "dark" {
  const next = resolvedTheme() === "light" ? "dark" : "light";
  setThemePreference(next);
  return next;
}

/** Keep a "system" preference in sync when macOS/Windows appearance changes. */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia === "undefined") return () => {};
  const mq = matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Inline pre-hydration script (layout.tsx <head>): applies the stored/system
 * theme before first paint. Must stay dependency-free and tiny.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var p=q==="light"||q==="dark"?q:localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});var t=p==="light"||p==="dark"?p:(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;
