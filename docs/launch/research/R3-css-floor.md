# R3 — CSS support floor across WKWebView / WebView2 / WebKitGTK

Researched 2026-07-05. Features actually used by `apps/desktop/app/globals.css`:
`color-mix(in oklch|srgb, …)` (10+ uses), `oklch()`-adjacent color handling,
`backdrop-filter` (1 use, `.nav`), resolution media queries incl. the minified
`1.5x` unit (hairline system), CSS custom properties (everywhere).

## Engine facts

| Feature | WebKit/Safari first | Chromium first | WebKitGTK first |
|---|---|---|---|
| `oklch()` | Safari 15.4 | Chrome 111 | 2.38-era |
| `color-mix()` | Safari 16.2 | Chrome 111 | 2.40-era |
| `backdrop-filter` (unprefixed) | Safari 18 / 9 prefixed | Chrome 76 | **2.30** (2020-09) |
| resolution MQ + `x` unit | Safari 16.0 | old | 2.38-era |

Sources (checked 2026-07-05):
- https://caniuse.com/mdn-css_types_color_oklch (Safari 15.4, Chrome 111)
- https://caniuse.com/mdn-css_types_color_color-mix (Safari 16.2, Chrome/Edge 111, Firefox 113)
- https://www2.webkit.org/show_bug.cgi?id=169988 + https://webkitgtk.org/2020/09/11/webkitgtk2.30.0-released.html (backdrop-filter in WebKitGTK 2.30)
- WebKitGTK releases track Safari's WebKit trunk: the 2.40 series (2023-03) carries
  the Safari 16.x feature set, which covers everything above.

## What each platform actually ships

- **Windows / WebView2:** Evergreen runtime — auto-updated Chromium, ≥111 since
  March 2023. Everything supported. Only risk is the *fixed-version* distribution
  mode, which we do not use.
- **macOS / WKWebView:** system WebKit, updated via OS/Safari updates. Needs the
  Safari 16.2-era WebKit → effectively macOS 13.1+ (or 12.6 with current Safari
  updates). Declaring **macOS 13+** as the floor.
- **Linux / WebKitGTK (webkit2gtk-4.1):** distros roll full-version WebKitGTK
  security updates in stable: Ubuntu 22.04 is at 2.50.4, Ubuntu 24.04 at 2.52.3,
  Debian 12 at 2.50.4 (https://launchpad.net/ubuntu/+source/webkit2gtk ,
  https://tracker.debian.org/pkg/webkit2gtk , checked 2026-07-05). Any patched
  Ubuntu 22.04+/Debian 12+/current Fedora is ≥2.40 and supports everything used.
  Only an *unpatched* pre-2023 install falls below the floor.

## Declared support floor (goes in PLATFORM-PARITY + launch docs)

- Windows 10 1809+ / Windows 11, Evergreen WebView2.
- macOS 13 Ventura+.
- Linux: distro with webkit2gtk-4.1 ≥ 2.40 (Ubuntu 22.04+, Debian 12+, Fedora 38+,
  all assuming normal security updates).

## Fallback decision (S3 scope — deliberately small)

1. **`color-mix()` insurance:** for the handful of *load-bearing* uses (nav
   background, borders on pills/agent chrome), add a literal color declaration on
   the line before the `color-mix` one. Engines below the floor ignore the
   `color-mix` line and keep the literal; engines at floor override it. Zero
   visual change at floor. Purely decorative color-mix uses get no fallback.
2. **`backdrop-filter`:** supported everywhere at floor (WebKitGTK since 2.30);
   the `.nav` rule already sits on a 90%-opaque `color-mix` background — add the
   literal fallback per (1) and no further work.
3. **Resolution MQ:** fallback is inherent — the JS-driven hairline (R2) does not
   depend on the media query; below-floor engines get 1px hairlines from the JS
   path anyway.
4. No polyfills, no build-time transpilation changes (lightningcss already
   lowers what it can), no `@supports` forks.
