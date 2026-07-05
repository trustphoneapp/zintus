"use client";

/**
 * Pre-hydration boot: theme, platform stamp, device-pixel hairline.
 *
 * These were once inline <script> tags in the layout <head>, but the Next
 * static export streams ALL head content through the RSC payload — React
 * inserts such scripts client-side via innerHTML, which never executes them.
 * Verified live by the S6 selftest: data-platform was null and --hairline
 * stayed on its CSS fallback in the packaged app. Module scope of the first
 * client chunk is the earliest point that reliably runs in this setup; the
 * CSS fallbacks (dark default theme, 2-bucket hairline media query,
 * platform-neutral chrome) cover the pre-JS frames.
 */
import { applyHairline, watchHairline } from "./hairline";
import { stampPlatform } from "./platform";
import { applyTheme, getThemePreference } from "./theme";

if (typeof document !== "undefined") {
  stampPlatform();
  applyHairline();
  watchHairline();
  applyTheme(getThemePreference());
}
