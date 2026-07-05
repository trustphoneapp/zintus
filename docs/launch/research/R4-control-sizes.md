# R4 — Control-size conventions vs Zintus buttons

Researched 2026-07-05.

## Zintus actuals (apps/desktop/app/globals.css)

- Global `button`: `padding: 8px 15px`, `font-size: 13px`, weight 600, radius 9px
  → rendered height ≈ 34 CSS px (13px × ~1.4 line + 16px padding).
- Pills/segments: radius 999px; cards 12px; composer send button ~36px circle
  (ChatPanel); sidebar rows ~36px; command-palette rows ~40px.
- These are identical on all platforms today because the UI is one codebase with
  bundled fonts (Inter/JetBrains Mono via next/font) — parity of *dimension* is
  already structural; only rasterization differs (see R2).

## Platform conventions (cited)

- **Apple HIG:** touch minimum 44×44 pt (touch surfaces); macOS pointer targets
  can be smaller — image-only buttons commonly 24×24 pt minimum; standard AppKit
  push buttons render ~28 px tall.
  https://developer.apple.com/design/human-interface-guidelines/buttons ,
  https://developer.apple.com/forums/thread/739201 (checked 2026-07-05).
- **Microsoft Fluent 2:** standard web/React Button medium size is 32 epx tall,
  radius 4px; touch target guidance 40×40 epx (7.5 mm).
  https://fluent2.microsoft.design/components/web/react/button/usage (checked
  2026-07-05; 32px medium confirmed against Fluent UI React tokens).
- **GNOME HIG:** minimum pointer target ~24 px, comfortable rows 32–36 px;
  https://developer.gnome.org/hig/ (checked 2026-07-05).
- **WCAG 2.5.8 (AA):** minimum target size 24×24 CSS px.
  https://adrianroselli.com/2019/06/target-size-and-2-5-5.html (checked 2026-07-05).

## Comparison

| Check | Zintus (~34px buttons, ≥24px icon buttons) | Verdict |
|---|---|---|
| Fluent 32px standard | 34px — within 2px of native feel | ✅ |
| macOS ~28px push buttons | 34px — slightly larger, consistent w/ branded apps | ✅ |
| GNOME 24px min / 32-36px comfortable | ✅ | ✅ |
| WCAG 2.5.8 24px | all interactive controls ≥24px (verify icon buttons in S6 metrics) | ✅ pending S6 |

## Decision

**Identical pixel-for-pixel branding on every platform.** No per-platform sizing.
Rationale: Zintus is a branded product app (like VS Code/Figma/Slack), not a
native-widget app; every metric already satisfies or exceeds each platform's
minimums, and per-platform sizing would break the "same buttons, same length"
requirement and double the QA surface.

Two scoped exceptions, both platform chrome rather than product UI:
1. **Windows caption buttons (S2):** follow Fluent caption metrics — 46×32 px hit
   targets, centered 10px glyphs, full-height from the top edge — because users
   aim at them from muscle memory; colors stay Zintus.
2. **macOS traffic-light inset (existing):** unchanged.

S6 encodes this decision as CI: a DOM-metrics script asserts key controls report
identical `getBoundingClientRect` CSS dimensions on all three OS builds and that
every interactive control is ≥24×24 CSS px (WCAG 2.5.8).
