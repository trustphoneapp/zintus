# R2 — DPI, hairline widths, and font smoothing per engine

Researched 2026-07-05. Applies to the `--hairline` token system introduced in
`apps/desktop/app/globals.css` (commit 612b2c07).

## Scale factors in the field

- Windows exposes display scaling directly as `devicePixelRatio` (dPR): 100%→1,
  125%→1.25, 150%→1.5, 175%→1.75, 200%→2, 225%→2.25.
  Sources: https://silvawebdesigns.com/how-to-fix-windows-scaling-issues-above-100-for-your-website/ ,
  https://browsertrace.online/details/browser/device-pixel-ratio.html (checked 2026-07-05).
- No authoritative public telemetry on the Windows scale-factor distribution
  exists; Windows' own *recommended* defaults imply the shape: 125–150% on
  1080p/1440p 13–15" laptops, 150–200% on 4K panels, 100% on 1080p desktop
  monitors ≥24". Planning assumption: **1.0, 1.25, 1.5 are all first-class**, 1.75+
  present. Fractional dPR is the Windows norm, not the exception.
- macOS is effectively binary: 1 (external non-Retina) or 2 (Retina, incl. scaled
  modes — macOS renders at 2x and downsamples, so CSS still sees dPR 2).
- Linux: X11 commonly 1 or 2; Wayland supports fractional (1.25/1.5) with
  compositor+toolkit support; WebKitGTK ≥2.38 handles device scale factors.
- Tauri/WebView2 DPI awareness: Tauri embeds a Per-Monitor-V2 manifest on Windows;
  historical blurry-at-1x issues (https://github.com/tauri-apps/tauri/issues/1074)
  were v1-era and fixed. Multi-monitor mixed-DPI still has WebView2 edge cases
  (https://github.com/MicrosoftEdge/WebView2Feedback/issues/4826) — reason to make
  the hairline system react to monitor changes rather than compute once.

## Hairline math

A line is crisp when its rasterized width is a whole number of device pixels:
`css_px × dPR ∈ ℕ`. One device pixel = `1/dPR` CSS px:

| dPR  | Windows scale | 1 device px (CSS) | current 2-bucket system gives | device px result | verdict |
|------|--------------|-------------------|-------------------------------|------------------|---------|
| 1.0  | 100%         | 1px               | 1px                           | 1.0 ✅           | crisp |
| 1.25 | 125%         | 0.8px             | 1px                           | 1.25 ❌          | soft |
| 1.5  | 150%         | 0.667px           | 1px                           | 1.5 ❌           | soft |
| 1.75 | 175%         | 0.571px           | 0.5px (Retina bucket!)        | 0.875 ❌         | soft + wrong bucket |
| 2.0  | 200%/Retina  | 0.5px             | 0.5px                         | 1.0 ✅           | crisp |
| 2.25 | 225%         | 0.444px           | 0.5px                         | 1.0 ✅ (rounds)  | acceptable |
| 3.0  | 300%         | 0.333px           | 0.5px                         | 1.5 ❌ (minor)   | acceptable at 3x density |

The 1.75 row is the worst bug in the current system: `max-resolution: 1.5dppx`
puts 175% Windows users in the *Retina* bucket (0.5px → 0.875 device px — blurry).

## Font smoothing per engine

- `-webkit-font-smoothing` / `-moz-osx-font-smoothing` affect **macOS renderers
  only** (WebKit + Chromium on macOS honor the -webkit one). They are no-ops on
  Windows and Linux — the current `body` rule and its 1x override are inert there.
- Windows / WebView2 (Chromium): DirectWrite + ClearType subpixel AA; generally
  the crispest light-on-dark small text of the three engines. Nothing to set in
  CSS; verify visually in S6 screenshots.
- Linux / WebKitGTK: FreeType + fontconfig; honors the user's system
  hinting/subpixel settings. Do not override; bundled Inter (next/font) guarantees
  identical glyph outlines everywhere.

## Decision

**JS-driven hairline (exactly 1 device pixel on every display), media query kept
as no-JS/first-paint fallback:**

1. A tiny module (runs before hydration paint, in the root layout) sets
   `document.documentElement.style.setProperty('--hairline', (1/devicePixelRatio) + 'px')`
   and re-runs on dPR change via the standard `matchMedia(\`(resolution: ${dPR}dppx)\`)`
   re-subscription pattern (fires when the window moves between monitors or the
   user changes scaling). Ref: https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio
   (checked 2026-07-05).
2. Values are emitted rounded to 4 decimals; engines snap to the device grid.
3. The existing `max-resolution: 1.5dppx` media query stays as fallback for the
   pre-JS first frame; JS overrides it immediately after.
4. macOS Retina result is byte-identical: 1/2 = 0.5px, same as today. macOS 1x:
   1px, same as today. Windows 125/150/175% become exactly 1 device pixel —
   the fix the 2-bucket system cannot express.
5. Font smoothing: keep the current macOS-only rules unchanged; no Windows/Linux
   CSS. S6 screenshots are the acceptance gate for ClearType/FreeType output.
