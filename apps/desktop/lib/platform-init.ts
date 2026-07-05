/**
 * Pre-paint platform stamp: sets `data-platform="mac|windows|linux"` on <html>
 * before first paint (layout.tsx <head>, same contract as THEME_INIT_SCRIPT).
 * Platform-specific chrome (titlebar strip height, Windows caption buttons,
 * top-bar padding) is pure CSS keyed on this attribute — no post-mount reflow
 * and no hydration mismatch, which the old `isMac` state in AppShell had
 * (defaulted true → Windows/Linux flashed mac chrome; R6 item 1).
 *
 * Kept in its own module without "use client" so the server layout can inline
 * it. The regex must stay the mirror of `desktopPlatform()` in lib/platform.ts
 * (unit test pins them together).
 */
export const PLATFORM_INIT_SCRIPT = `(function(){try{var u=navigator.userAgent;document.documentElement.dataset.platform=/Windows/i.test(u)?"windows":/Mac/i.test(u)?"mac":"linux"}catch(e){}})();`;
