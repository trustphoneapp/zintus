# Zintus Web Dark Redesign — Master Spec (feat/web-dark-redesign)

Owner plan by Fable; implementation by Opus agents. Scope: `apps/web` marketing surfaces ONLY.
The chat app shell (`app/(app)`, `app/_components/AppShell.tsx`, `@zintus/ui` tokens) keeps its
existing dark/light behavior — do not restyle it in this branch.

## 1. Direction (locked by user — do not re-litigate)

Replace the current purple identity (near-black purple `#07040f`, violet `#7c3aed`, animated
GalaxyBackground, purple glows, gradient-clipped text, blue-slate muted `#94a3b8`) with a
**dark, neutral-black system in 3 switchable modes**:

| Mode | Reference | Canvas | Panel / surface | Ink | Muted | Hairline | Accent behavior |
|---|---|---|---|---|---|---|---|
| **Indigo** (DEFAULT) | DeepSeek | `#0c0c0f` | `#141419` / `#18181f` | `#ececef` | `#8b8b93` | `#26262c` | one periwinkle `#4D6BFE` (light `#7C92FE`, soft `rgba(77,107,254,.12)`) on primary buttons + active/interactive only |
| **Obsidian** | Z.ai | `#060607` | `#1a1a1d` / `#202024` | `#f5f5f7` | `#8f8f96` | `#2a2a2e` | NO chromatic accent. Primary buttons inverted-white (`#f5f5f7` fill, `#0a0a0b` text). Hero h1 may use silver gradient `#fff → #8f8f96` (the ONLY allowed gradient text). |
| **Graphite** | Perplexity | `#0f1110` | `#191b1a` / `#1f2120` | `#eef0ef` | `#8a908d` | `#2a2d2b` | Primary buttons inverted-light (`#eef0ef` fill, `#101211` text). Teal `#20A8B8` (brand `#20808D`, soft `rgba(32,168,184,.12)`) on links/tags/active ONLY — never as button fill. |

Shared rules (from verified deep-research):
- Neutral near-black substrate; **one** accent, on interactive elements only.
- Depth from hairline borders + at most one raised panel — **NO colored glows, no box-shadow tinted with accent**. Neutral black shadows (`rgba(0,0,0,.5-.7)`) are allowed for lift.
- True-neutral muted gray (no blue cast).
- Whitespace generous (2–3× current where cramped).
- Gradient-clipped headline text: remove everywhere (exception: Obsidian silver hero, above).

KILL LIST (must reach zero occurrences in `apps/web` app/marketing surfaces):
`GalaxyBackground` (component + import + the `body … background: transparent` hack),
`#07040f`, `#7c3aed`, `#a78bfa` (as general fill), `#94a3b8`, `#2e1065`, `#1e0a3c`,
`--marketing-glow` colored values, 24–40px purple button glows.

## 2. Theming mechanism

`next-themes` already wraps the tree (`components/marketing/ThemeProvider.tsx`, attribute="class",
CSP nonce handled — do not touch the nonce plumbing).

- Set `themes={["light", "dark", "obsidian", "indigo", "graphite"]}`, keep `defaultTheme="dark"`, `enableSystem={false}`.
- CSS mapping in `app/globals.css`:
  - `:root` marketing vars = **Indigo** values (so `dark`, `indigo`, and any unknown class all render Indigo).
  - `.obsidian { … }` and `.graphite { … }` override the `--marketing-*` set (and `color-scheme: dark`).
  - **Delete** all `--marketing-*` definitions from `.light` — the light marketing theme is retired. `.light` remains solely for the app shell (@zintus/ui) tokens; leave those alone.
- App shell keeps its Sun/Moon `ThemeToggle` in `AppShell.tsx` (values `dark`/`light`) — untouched.
- Marketing `Navbar.tsx` replaces `ThemeToggle` with the new `ModeSwitcher` (below).

New/renamed tokens (keep the `--marketing-*` prefix so 173 existing usages keep resolving):
`--marketing-bg, -surface, -surface-2, -text, -muted, -border, -accent, -accent-light,
-accent-dim, -accent-soft, -on-accent, -btn-primary-bg, -btn-primary-ink, -red, -red-soft`.
Add `--marketing-btn-primary-bg/-ink` because Obsidian/Graphite primaries are inverted-light
while Indigo's is accent-filled — components must use these, never `--marketing-accent`, for button fills.
Set `--marketing-glow: transparent` (or delete + purge usages).

## 3. Highly interactive buttons (user's explicit priority)

Create a single button system in `globals.css` — classes `.mk-btn`, `.mk-btn-primary`,
`.mk-btn-secondary`, `.mk-btn-ghost` — and migrate `hero-v2-btn-*` and every marketing CTA to it.

Base `.mk-btn`:
- `inline-flex; align-items:center; gap:8px; border-radius:10px; font-weight:600;`
- transition `transform 150ms cubic-bezier(0.2,0,0,1), background 150ms, border-color 150ms, box-shadow 150ms`.
- `:focus-visible`: 2px ring in `--marketing-accent` (Indigo/Graphite) or `--marketing-text` (Obsidian), offset 2px. Never remove outline without replacement.
- `:active`: `transform: translateY(0) scale(0.97)` with a faster 80ms transition (declare via `&:active { transition-duration: 80ms }`).
- `@media (prefers-reduced-motion: reduce)`: no transforms/sheen; keep color transitions.

Primary `.mk-btn-primary` (uses `--marketing-btn-primary-bg/-ink`):
- hover: `transform: translateY(-1px)`, `filter: brightness(1.06)`, neutral shadow `0 4px 16px -8px rgba(0,0,0,.6)` (NEVER accent-tinted).
- Sheen: `::after` linear-gradient (transparent → rgba(255,255,255,.14) → transparent), skewed, translates across on hover over ~600ms; `overflow:hidden` on the button. Skip under reduced-motion.

Secondary: transparent fill, 1px `--marketing-border` hairline; hover: border → 40% ink mix, background → `--marketing-surface`.
Ghost/link: muted ink → full ink on hover; underline offset animation optional.

Micro-interactions to wire in components:
- CTA arrows (`→` / lucide `ArrowRight`) translate `3px` right on button hover (parent-hover selector).
- Copy/install buttons (`CommandBlock.tsx`, `InstallSection.tsx`): icon morphs to a check with a 150ms scale-pop and brief `--marketing-accent-soft` background tint, reverting after ~1.5s (most already have copied state — restyle it).
- Nav links: hover ink + 2px underline that scales-in from left (`transform-origin: left`).

## 4. ModeSwitcher component (new)

`components/marketing/ModeSwitcher.tsx` (client). A segmented pill in the Navbar:
- Three items — Obsidian, Indigo, Graphite — each a small swatch dot pair (canvas + accent color hardcoded per mode) plus label on ≥720px, dot-only below.
- Sliding thumb: absolutely-positioned highlight that animates (transform/width, 200ms same easing) to the active segment.
- `useTheme()` from next-themes; active = `resolvedTheme==="obsidian"|"graphite"` else Indigo (i.e. `dark`, `indigo`, `light`, undefined all show Indigo active). Clicking Indigo sets `"indigo"`.
- Mounted-guard like the old ThemeToggle to avoid hydration mismatch.
- A11y: `role="radiogroup"` + `role="radio"`/`aria-checked`, arrow-key navigation, visible focus ring.
- Same press micro-interaction as `.mk-btn` (`scale(0.97)` on active).

## 5. File map / work slices

### Slice A — Foundation (must land first)
- `app/globals.css`: rewrite `:root`/`.light` marketing var blocks per §2; add `.obsidian`/`.graphite`; add `.mk-btn` system per §3; fix `body:has(.marketing-page)` to `background: var(--marketing-bg)`; sweep ALL hardcoded kill-list hexes inside globals.css (incl. `.hero-v2-terminal-body .t-*` palette → neutral inks + `--marketing-accent` for prompt/route, `#34d399` ok for success) and any `box-shadow` using `--marketing-glow`.
- `app/layout.tsx`: remove `GalaxyBackground` import + element. Delete `app/components/GalaxyBackground.tsx`.
- `components/marketing/ThemeProvider.tsx`: add `themes` list.
- `components/marketing/ModeSwitcher.tsx`: new, per §4.
- `components/marketing/Navbar.tsx`: swap `ThemeToggle` → `ModeSwitcher`.
- Typecheck must pass (`bunx tsc --noEmit -p apps/web` or repo's script).

### Slice B — Marketing components sweep (after A)
`components/marketing/`: Hero, MockChatDemo, Features, HowItWorks, PlatformSection,
ProviderGrid, InstallSection, Stats, TrustBar, CTA, FAQ, Footer, Reveal.
- Replace hardcoded purples/slate hexes with tokens; strip gradient-clipped text (keep Obsidian
  silver on the hero h1 ONLY, implemented as an `.obsidian &` override, solid ink otherwise).
- Migrate CTAs to `.mk-btn*`; add arrow/copy micro-interactions per §3.
- MockChatDemo: assistant = plain full-width text, user = quiet neutral bubble
  (`--marketing-surface-2`, hairline), accent only on send/active elements.
- Respect whitespace rule: bump cramped section paddings toward 2× (keep the 1140px shell).

### Slice C — Secondary pages sweep (after A, parallel with B)
`app/download` (+ CommandBlock), `app/changelog`, `app/blog`, `app/about`, `app/contact`,
`app/developers`, `app/docs`, `app/pricing`, `app/privacy`, `app/security`, `app/terms`,
`app/account/delete`, `app/_components/{LegalPage,PlaceholderPage,TransparencyStrip,MessageBubble†,StructuredOutputControl†}.tsx`,
`app/opengraph-image.tsx`, `app/apple-icon.tsx`/`app/icon.svg` if purple.
† only their marketing-var usages — do not restyle app-shell behavior.
- Same token/button migration; kill-list hexes to zero. `app/dashboard/billing` + `app/(app)/projects`:
  ONLY swap kill-list hexes for tokens, no visual redesign.

### Slice D — Verify (after B+C)
- `rg -n "07040f|7c3aed|94a3b8|2e1065|1e0a3c|GalaxyBackground" apps/web --glob '!node_modules'` → must be empty (`a78bfa` allowed only if genuinely needed nowhere — expect empty).
- Typecheck + `bun run build` (or `next build`) for apps/web green.
- Run dev server, screenshot `/` (hero+nav), `/pricing`, `/download` in all 3 modes via Playwright
  (`bunx playwright screenshot` or a tiny script setting `localStorage.theme`), save to `docs/design/redesign-shots/`.
- Check: no FOUC of purple, mode switcher slides, buttons lift/press, focus rings visible.

## 5b. Slice E — Web chat app redesign (added 2026-07-11, user directive)

User directive: the web **chat app** gets the redesign too — latest CSS, the same 3 modes, and the
same highly-interactive buttons. Inspired by the platform research (DeepSeek restraint, Z.ai silver
hierarchy, Perplexity inverted buttons) but a **unique Zintus synthesis, not a copy**: we keep our
signatures — JetBrains Mono on routing/usage metadata, TransparencyStrip + CompressionBadge,
provider color dots, the Z-constellation empty state — and lay the neutral 3-mode system under them.

### E1. Mode bridge (fixes a real bug)
The app shell reads `--color-*` from `packages/ui/styles/tokens.css`, which only defines `.dark`
(violet hue-295) and `.light`. With the new theme classes (`obsidian`/`indigo`/`graphite`) the shell
matches neither and falls back to the `:root` **light** theme. Fix at the **web layer only** —
append override blocks in `apps/web/app/globals.css`; never edit `packages/ui` (desktop shares it).

For `.dark, .indigo` (Indigo is the dark default), `.obsidian`, `.graphite` define:
`--color-bg/-surface/-elevated/-border/-border-bright` from that mode's neutrals (bg/surface/surface-2/hairline, border-bright ≈ hairline +6% L);
`--color-text/-text-sub/-text-muted` from ink/muted;
`--color-purple[-mid/-light/-bright]` → the mode accent ramp (Indigo `#4d6bfe` ramp; Obsidian near-white ink ramp `#f5f5f7/#e8e8ea/#ffffff`; Graphite teal `#20a8b8` ramp);
`--color-purple-glow/-faint` → LOW-alpha neutral or accent-soft (no violet, no big glows);
`--c-accent`, `--c-accent-light/-mid` (accent at .16/.25 alpha), `--c-accent-contrast` (white for Indigo, `#0a0a0b` for Obsidian, `#101211` for Graphite);
`--c-focus` layered ring using the mode accent at 0.4 alpha;
`--c-user-bubble` = surface-2, `--c-user-bubble-border` = hairline;
`--c-border`/`--c-border-strong` neutral white-alpha (`rgba(255,255,255,.08/.14)`).
This alone de-purples the entire chat app in all three modes. `.light` stays untouched (warm-white app theme remains a valid choice inside the app).

### E2. Chat surface rules (research-derived, ours)
- Assistant messages: plain full-width text, no bubble/panel.
- User messages: quiet neutral bubble — `--c-user-bubble` + 0.5px hairline, radius `--radius-lg`.
- The composer is the ONE raised panel: `--color-surface` + `--shadow-md` (neutral); focused state = accent hairline (`--c-accent` at 40%) instead of glow.
- `.chat-send`: replace hardcoded `#6366f1` with `var(--c-accent)` / `var(--c-accent-contrast)`; add the mk-btn interaction grammar — hover `brightness(1.06)` + `translateY(-1px)`, active `scale(0.95)` at 80ms, `:focus-visible` → `--c-focus`; disabled = accent dimmed toward bg (keep the solid-square rule). Arrow stroke → `var(--c-accent-contrast)` (not `#fff`, which breaks on Obsidian's white button).
- `.chat-mic`: kill the remaining violet `rgba(124,58,237,…)` pulse shadows → `--c-accent`-tinted at ≤0.25 alpha, small radius (this is a state pulse, not a glow).
- Sidebar items: hover = `--color-elevated` fill; active = `--c-accent-light` fill + 2px accent left bar; 150ms `--t-fast`; press `scale(0.98)`.
- Topbar pills/buttons: same press/hover grammar, hairline borders, no glows.

### E3. Mode switcher in the app
`AppShell.tsx` currently mounts the marketing Sun/Moon `ThemeToggle`. Replace with `ModeSwitcher`
extended to accept a `withLight` prop: in the app it shows 4 segments (Light · Obsidian · Indigo ·
Graphite); on marketing it stays 3 (dark-only site). Keep `ThemeToggle.tsx` on disk (unused is fine).

### E4. Scope & verify
Files: `apps/web/app/globals.css` (append mode-bridge blocks + retouch chat-send/mic/sidebar/composer rules), `AppShell.tsx` (toggle swap), `ModeSwitcher.tsx` (withLight), optionally `MessageBubble.tsx`/`Sidebar.tsx` if bubble/active-state classes need markup tweaks. Typecheck green; hex grep for `6366f1` in chat rules → tokenized; screenshot `/chat` in all 3 modes + light.

## 7. V2 — "Machined Dark" (added 2026-07-11 after user review of v1)

User verdict on v1: colors fine, but the page reads flat/weird — gray boxes on a void, no depth,
no motion. V2 keeps ALL v1 tokens/modes and rebuilds the visual bones. Research anchors: Linear's
surface-lightness ladder + hairlines + inset top-highlight (no ambient shadows), grain overlay,
bento grids with hover micro-interactions, spotlight cards, border-beam, magnetic buttons,
scroll reveals, number tickers, marquee. Animation directs attention, never decorates.
`prefers-reduced-motion` disables every transform/loop below (colors still transition).

### 7.1 Phase 1 — Surface & light system

**Elevation ladder** (add per mode next to the existing marketing tokens; surface-0 = bg):
| token | Indigo | Obsidian | Graphite |
|---|---|---|---|
| --surface-1 | `#131316` | `#101012` | `#151716` |
| --surface-2 | `#1a1a1f` | `#1a1a1d` | `#1b1d1c` |
| --surface-3 | `#212127` | `#232326` | `#222523` |
Re-point `--marketing-surface` → surface-1 and `--marketing-surface-2` → surface-2 values (keep both names).

**Card recipe** `.mk-card` (apply to every marketing card: features, pricing, stats, provider chips' containers, terminal frame):
```css
.mk-card {
  position: relative;
  border-radius: 16px;
  background: linear-gradient(180deg, var(--surface-2), var(--surface-1));
  border: 1px solid var(--marketing-border);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 8px 24px -12px rgba(0, 0, 0, 0.5);
}
```
The inset top-highlight is the "machined" signature — never omit it. Hover: border-color brightens
one step + translateY(-2px) (150ms).

**Grain**: on `body:has(.marketing-page)::after` — fixed, inset 0, pointer-events none,
`background-image` = inline SVG feTurbulence data-URI (fractalNoise, baseFrequency .8, 128px tile),
opacity 0.025, z-index 2147483647 is wrong — use z-index 9999 and confirm it sits above content but
is non-interactive. Static asset, no animation.

**Hero atmosphere** (`.hero-v2`): `::before` = `radial-gradient(900px 480px at 50% -12%,
var(--marketing-accent-soft), transparent 70%)` (Obsidian: use rgba(245,245,247,.05));
`::after` = dot grid `radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px)` /
`background-size: 24px 24px`, masked with a radial fade so it dies before the fold. Both
pointer-events none, behind content.

**Navbar**: glass — per-mode `--nav-glass` token (canvas at 72% alpha as a precomputed rgba, NOT
color-mix) + `backdrop-filter: blur(16px) saturate(1.4)` + bottom hairline. Add a tiny scroll hook
(client) that toggles `.condensed` at scrollY>8: min-height 74→56px, logo scales .9. Fix the
"How it works" 3-line wrap: `white-space: nowrap` on `.m-nav-links a` + tighten gap; below 1080px
collapse lesser links into a "More ▾" dropdown or hide. ModeSwitcher on marketing nav becomes
compact: hide `.mode-switcher-label` inside `.m-nav` (CSS only), tighter padding — a 3-swatch-dot
pill with `title` tooltips. Normalize nav CTA: "Open app" uses `.mk-btn mk-btn-primary` small size;
GitHub star uses `.mk-btn-secondary` small.

**Section rhythm**: `.m-section` alternates canvas / `--surface-1` bands (class `.m-band`),
each band separated by a full-width hairline; kill floating-box-in-void look. Section headers get
a JetBrains Mono eyebrow (`--marketing-accent`, 11px, letter-spacing .12em, uppercase).

### 7.2 Phase 2 — Interactive layer

**InteractiveCard utility** `components/marketing/InteractiveCard.tsx` (client): wraps children in
a div; onPointerMove sets `--mx`/`--my` (px, relative) CSS vars; optional `tilt` prop adds
perspective rotateX/rotateY capped at 3deg (spring back on leave, 200ms); optional `spotlight`
(default true). Reduced-motion: hook returns inert handlers.
```css
.mk-spot::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: radial-gradient(240px circle at var(--mx, 50%) var(--my, 50%),
    rgba(255, 255, 255, 0.06), transparent 60%);
  opacity: 0; transition: opacity 200ms;
}
.mk-spot:hover::before { opacity: 1; }
```

**Border beam** `.mk-beam` (featured pricing card + hero primary CTA wrapper):
```css
@property --beam { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
.mk-beam::after {
  content: ""; position: absolute; inset: -1px; border-radius: inherit; padding: 1px;
  background: conic-gradient(from var(--beam), transparent 0deg 300deg,
    var(--marketing-accent) 330deg, transparent 360deg);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  pointer-events: none; animation: mk-beam-spin 6s linear infinite;
}
@keyframes mk-beam-spin { to { --beam: 360deg; } }
```
Verify the built CSS keeps `@property` (lightningcss passthrough); if stripped, fall back to
rotating a wrapper gradient element.

**Magnetic buttons**: `useMagnetic` hook (≤4px translate toward cursor, spring back) applied ONLY to
hero primary CTA and navbar "Open app". No global magnetism.

**Hero terminal**: typing loop — array of (prompt, routed-provider, latency) lines typed
char-by-char with a blinking block caret, 3s hold, then next scenario; loops. Static first frame
under reduced-motion. Keep existing terminal chrome (dots bar) but wrap in `.mk-card` frame.

**Pricing cards**: InteractiveCard with tilt+spotlight; "Most popular" card gets `.mk-beam`,
scale(1.03) base, accent check-chips (`--marketing-accent-soft` circle + accent check).

### 7.3 Phase 3 — Layout & life

**Features → bento**: 6 tiles — 2 wide (col-span-2: routing visual, live-quota visual) + 4 small;
size = importance. Each tile `.mk-card mk-spot`; visuals are framed mini-UI (reuse MockChatDemo
fragments / QuotaBar-style meters), not icons on empty gray.

**Stats**: number tickers — count from 0 to value on first intersection (600ms, easeOut), JetBrains
Mono, accent for the number, muted label.

**Provider marquee**: single-row infinite marquee of provider names/dots (duplicated list + CSS
translateX keyframes, pause on hover) replacing/augmenting TrustBar.

**Reveal.tsx**: upgrade to IntersectionObserver with stagger (children delay 60ms increments,
translateY(12px)→0 + fade, 500ms) — one shared observer.

**Pricing layout**: Ultra becomes a full-width horizontal bento bar under the 4-card grid.

### 7.4 Verify gate (before showing the user)
Typecheck + `next build` green; screenshot home/pricing/download in all 3 modes; check: no navbar
wrap at 1280px, cards show top-highlight + spotlight, beam animates, grain visible at 200% zoom,
reduced-motion kills loops. DO NOT COMMIT — user reviews on localhost:3000 first.

## 8. V3 — Stitch-round ports (added 2026-07-11, user-approved 4 items)

Ideas mined from the user's Stitch exports (same "Machined Dark" system), adapted not copied.
All V2 rules stay in force: accent budget, neutral shadows, machined cards, reduced-motion.
DO NOT COMMIT — localhost review first.

### 8.1 Routing console demo (upgrade MockChatDemo)
Two-panel layout inside the existing section (stack under 900px):
- LEFT RAIL (~240px, .mk-card): "ROUTING LOGIC" mono eyebrow; vertical provider list
  (Cerebras ✓ active, Groq, Gemini) — active row: accent-soft fill + accent check, hairline rows;
  below it a "QUOTA USAGE" mini-card: mono label, thin meter bar (accent fill, 80%),
  "80% used · 1.2M tokens remaining" in mono 10px.
- RIGHT (existing chat demo, .mk-card): title bar reads "zintus.ai/chat — 128ms latency" (mono)
  with a small "● ACTIVE" mono badge (accent dot); keep existing demo messages/behavior; add a
  bottom command strip: fake input "Type a command or query…" with a ⌘↵ kbd chip (non-functional,
  aria-hidden decorative).
The rail is static demo content (marketing page) — no live gateway calls.

### 8.2 Transparency ledger section (NEW, homepage, after Features)
Full-width .m-band section, eyebrow "TRANSPARENCY", h2 "Every route. Every token. Receipted."
- A .mk-card table (mono, 5 demo rows): TIME · MODEL ROUTE (+ sub-label line under model name in
  11px: "Fallback triggered" (amber #f59e0b text ok — semantic, not accent), "Edge optimized",
  "Cheap route enabled", "Direct ingress") · PROVIDER (hairline chip) · TOKENS · LATENCY ·
  COST · status dot (--marketing-green ok / one hollow). Right-aligned numerics, tabular-nums.
  Label the card "Illustrative sample" in muted mono 10px so it's honest demo data.
- Below the table, two half-width .mk-card panels: "Provider spend share" — 4 quiet horizontal
  bars (ink-alpha track, accent fill ONLY on the top provider, others rgba(255,255,255,.25)) with
  mono % labels; "Requests by latency" — 7 vertical bars, tallest in accent, rest neutral.
  Pure divs/CSS, no chart lib. Desktop-only fanciness OK; stack on mobile.

### 8.3 Stats row upgrade
- Each stat tile gets a second line: mono 10px uppercase sub-caption (e.g. providers →
  "DIRECT + BYOK CATALOG", latency → "IN-PROCESS QUOTA CHECK", markup → "ON YOUR OWN API KEYS" —
  adapt to the real stats present, stay honest).
- The savings/markup tile becomes the FEATURED tile: accent-soft background tint + accent-dim
  border + accent number; all other tiles' numbers go ink (replace the :first-child accent rule
  with a .stat-featured class on the right tile).

### 8.4 Hero terminal vocabulary
Typing scenarios end with the receipt: routed provider line gains sub-vocabulary
("fallback triggered → …", "edge optimized", "cheap route enabled") and the last line of each
scenario is "remaining balance: 4,998,727 tokens" (mono, muted). Keep loop/caret/reduced-motion.

## 9. V4-chat — web /chat redesign (added 2026-07-11; user flagged chat untouched)

Slice E only bridged tokens; the chat BONES are still old. Bring /chat to 2026 chat-product
quality (ChatGPT/Claude/DeepSeek patterns: unified composer card, distraction-free column,
quiet sidebar) using our machined system. App-shell tokens only (--color-*/--c-*); all 3 modes
+ light must work. RESTYLE, do not rewrite logic — chat page is live product code.

9.1 Composer (centerpiece): ONE elevated card — --color-elevated, radius 18, 0.5px hairline,
inset top-highlight + --shadow-sm. Inside: auto-grow textarea (transparent, 1→~8 lines), then an
action row INSIDE the card: left = attach (+) and the existing More/tools control folded in;
right = mic, then send (existing .chat-send grammar). focus-within = accent hairline ring
(existing .focused treatment moves to the card). kbd hints stay below, mono 10px muted.

9.2 Messages: assistant plain full-width (768 col); msg action bar (Copy/Regenerate/Report)
becomes quiet — opacity .55, full on message hover (always-on for touch via @media (hover:none)).
User = quiet --c-user-bubble bubble. ERROR messages: detect the existing error rendering path and
wrap in .msg-error — red-soft hairline + rgba red tint bg, leading "⚠ Provider error" line,
first ~2 lines visible, full raw payload inside <details><summary>Show details</summary><pre>.
Keep Copy/Regenerate/Report working.

9.3 Header: 52px slim, hairline bottom, machined model pill + icon buttons with hover fill +
press scale (reuse topbar-button grammar).

9.4 Sidebar: section labels → mono 10px uppercase eyebrow style; "New chat" → accent fill +
--c-accent-contrast ink + full interactive grammar (it currently reads as a flat default-styled
block); search input machined inset; recents rows quiet hover fill (active accent bar exists);
workspace footer card machined.

9.5 Banners: GatewayOfflineBanner + "Local mode" strip → slim single-line strips (~36px,
surface-1, hairline bottom, status dot, inline <code>zintus serve</code>, link) instead of
multi-line blocks.

9.6 Empty state: Z-mark + 3 suggestion chips (mk-btn-secondary-like, small) that prefill the
composer input via existing controlled state.

9.7 Mobile ≤720px: sidebar = off-canvas drawer with scrim (keep whatever collapse exists,
make it work at 390px); composer card full-bleed with 12px side margins; header condensed;
message column padding 16px. Verify at 390×844.

Verify: typecheck + build green; run the existing apps/web tests if fast (gateway-offline.test.ts
lives beside the banner). Headless screenshots /chat at 1440×900 and 390×844. DO NOT COMMIT.

## 10. V5-chat — structural chat parity with 2026 top-tier products (deep-research round)

Research basis (verified): in-composer model picker (ChatGPT web moved the picker INTO the
composer, June 2026), suggestion chips, voice input and attachments as standard composer anatomy;
scroll behavior as a first-class concern (anchored streaming, jump-to-bottom); text-shimmer
"Thinking…" status as THE codified streaming indicator; code-block chrome = language badge +
copy button; hover action toolbars, retries, keyboard shortcuts as table stakes. Strong
unverified-but-sourced: sidebar pinning + date-grouped recents (ChatGPT June 2026), Perplexity
per-answer "Rewrite with different model" menu, send-button secondary interactions.

Implement in apps/web (RESTYLE + small functional additions; never break existing logic):

10.1 **Model picker into the composer.** Move the header "Auto" model pill into the composer
action row (left cluster, after +/More): same dropdown component, compact chip with provider dot.
Header keeps title + search/share/theme only (slimmer). Mobile: chip stays in composer (ChatGPT
parity is reversed on mobile but our header is already crowded at 390px).

10.2 **Send ↔ Stop morph.** While a response is streaming, the send button becomes a Stop button
(square glyph, same 36px footprint, red-soft hover) wired to the existing abort path if one
exists (inspect streamAssistant for an AbortController; if none, add one — abort must cleanly
finalize the partial message). Send disabled state unchanged.

10.3 **Streaming affordances.** (a) Before first token: "Thinking…" status line with a CSS
text-shimmer (background-clip gradient sweep), replaced by content on first token; (b) a
floating "↓ Jump to latest" pill (mk-card mini) appears when the user has scrolled ≥300px away
from bottom during streaming or history browsing — click scrolls smooth to bottom; auto-scroll
stays anchored while at bottom (don't fight the user's scroll).

10.4 **Code block chrome.** Ensure every code block: language badge (mono 10px, top-left),
copy button (top-right, morph-to-check), hairline card chrome consistent with .mk-card family.
Inspect the existing CodeBlock/Markdown components and upgrade in place.

10.5 **Sidebar recents v2.** (a) Date grouping: Today / Yesterday / Previous 7 days / Older
(mono eyebrow group headers); (b) Pin: hover-revealed pin icon per row, pinned ids persisted in
the existing store/localStorage, PINNED group renders first. Keep search filtering working
across groups.

10.6 **Regenerate with model (stretch).** If the existing regenerate path can accept a model/
provider override without deep surgery, upgrade Regenerate into a split control: click =
regenerate as-is; chevron = small menu listing Auto + the providers from the existing provider
list, checkmark on the one that produced the answer (we know the routed provider per message if
stored). If the plumbing does not exist, SKIP and report — do not force it.

10.7 Keyboard: keep ⌘K, Enter-send/Shift-Enter-newline hints; add Esc = stop streaming when 10.2
lands.

Constraints: app-shell tokens only; all modes + light; reduced-motion (shimmer → static
"Thinking…", no smooth-scroll); mobile 390px must stay clean; preserve handlers/stores/aria/
tests; no new deps. Verify: typecheck, build, `bun test` scoped as before, headless screenshots
1440×900 + 390×844 (use --force-prefers-reduced-motion so content shows). DO NOT COMMIT.

## 11. V7 — adaptive app chrome (responsive pass, user directive 2026-07-12)

The app shell must RESHAPE per device class, not merely shrink. Also fixes a live bug: app pages
can scroll the page itself (sidebar header scrolls away, dead band under the composer) — the
height chain is broken.

11.1 **Height integrity (bug).** App pages never scroll the window. `.app-root` = `100dvh`
(dynamic viewport — mobile URL-bar safe), `min-height: 0` down the flex chain
(app-body/app-content/chat column), banners participate in the column without adding page height.
Audit every fixed `100vh` in app-shell CSS → `100dvh`. Verify: at any viewport, window scrollbar
absent on /chat, /settings, /usage (light + dark).

11.2 **Breakpoint system for the shell** (CSS-only where possible; the sidebar store already has
open/collapsed and the ≤720 drawer):
- **Desktop ≥1280**: sidebar 264px expanded (as now).
- **Laptop 1024–1279**: sidebar 240px; conversation column max 720px; paddings step down one notch.
- **Tablet 721–1023**: sidebar defaults to the 60px icon rail (auto-collapse on mount in this
  range, same pattern as the ≤720 auto-close); expanding it overlays content (position absolute +
  scrim, like the mobile drawer) instead of squeezing the chat column.
- **Mobile ≤720**: existing off-canvas drawer (keep), header 48px, composer full-bleed w/ 12px
  margins.
11.3 **Column + composer scaling**: conversation/composer column `min(768px, 100% - 32px)`
(≥1024), `100% - 24px` (tablet), `100% - 16px` (mobile). Kbd hints hidden ≤480. Composer action
row tightens gaps ≤480 (attach/More/model chip must fit with mic+send at 360px without wrap-break).
11.4 **Header adapts**: ≥1024 full pills; 721–1023 search collapses to icon (extend the existing
≤720 rule), title truncates with ellipsis; ≤480 share/private/theme collapse into a single "⋯"
overflow menu if trivial via existing menu primitives — else icons shrink to 32px targets (pick
the simpler, report which).
11.5 Verify with CDP device-metrics screenshots (the plain --window-size flag lies at small
widths): 360×740, 390×844, 768×1024, 834×1112, 1024×768, 1280×800, 1440×900 — /chat with a
seeded conversation; no horizontal overflow at any width; sidebar behavior per class; no window
scrollbar. Light + Indigo modes both.

Constraints: app-shell tokens; no new deps; reduced-motion; DO NOT COMMIT.

## 12. V8 — responsive EVERYWHERE (deep-research round 2, verified playbook)

Research basis (adversarially verified, 2026): media queries own page-level layout + global type
ramps; **@container size queries** (Baseline/widely-available) own reusable-component adaptation;
input adaptation keys off **pointer/hover capability, not width**; WCAG 2.2 SC 2.5.8 = 24×24 CSS px
minimum targets (Apple 44pt / Material 48dp recommended); fluid type = clamp() with **rem+vw
preferred value** (zoom-safe per WCAG 1.4.4); cqi units for container-scoped type; hover-revealed
row actions must have persistent touch fallbacks; responsive tables are per-purpose (reflow-to-
cards vs scroll container); style queries NOT safe yet — size queries only.

Apply across apps/web (marketing + app shell). V7's chrome work stands; don't redo it.

12.1 **Fluid token system** (globals.css, near the marketing tokens): `--fs-display`, `--fs-h2`,
`--fs-h3`, `--fs-body`, `--fs-small` and `--space-section`, `--space-card` as clamp() scales with
rem+vw preferred values (e.g. display: clamp(2.4rem, 1.6rem + 3.2vw, 4.6rem)). Replace the
hardcoded marketing font-sizes/section paddings with these tokens (hero h1 keeps its current
clamp — retune to token). Body line-length: cap prose blocks at 65-75ch where unconstrained.

12.2 **Container queries for reusable components**: make `.m-shell` sections and the chat message
column containers (`container-type: inline-size`). Convert per-component media rules to
@container for: pricing tier cards (stack internals when card < 260px), bento tiles (wide tiles
drop to 1-col internals < 420px), ledger panels pair (side-by-side → stack when container < 640px),
stat tiles (sub-caption hides < 180px). Size queries ONLY.

12.3 **Input adaptation**: `@media (pointer: coarse)` block — composer icons/mic/send/attach and
chat header icons ≥ 40px; sidebar rows min-height 40px; message action toolbar always visible
(exists via hover:none — extend to pointer:coarse) and buttons ≥ 32px with 8px gaps; sidebar pin
button always visible on coarse pointers (it's hover-revealed today). Use any-pointer where the
primary check could misreport hybrids.

12.4 **WCAG 2.5.8 audit**: every interactive target ≥ 24×24 or 24px-spaced — known offenders:
ModeSwitcher swatch dots (give each segment ≥ 24px hit area via padding, keep visual size),
kbd-size chips, ledger status dots (non-interactive — exempt), mk-btn-sm (verify), terminal copy
buttons. Fix by padding/hit-area, not visual inflation.

12.5 **Tables**: transparency ledger → at ≤ 720px reflow rows to compact cards (model+sub-label
title line, mono TIME/TOKENS/LATENCY/COST grid, chip + status inline); pricing model-cost table →
keep table inside an `overflow-x:auto` scroll container with a subtle edge-fade mask and
`tabular-nums` intact (comparison tables scroll, not reflow — per research). If display overrides
strip table semantics in the card reflow, use a definition-list markup variant instead of ARIA
role surgery.

12.6 **Mechanical audits**: (a) grep `100vw` — replace with `100%` where scrollbar-overflow risk;
(b) `env(safe-area-inset-bottom)` on the chat composer wrap + mobile drawer + marketing sticky
nav top inset; (c) next/image usages — ensure `sizes` on any responsive image and explicit
width/height (site is mostly SVG/CSS visuals; audit and report); (d) `content-visibility: auto` +
`contain-intrinsic-size` on below-the-fold marketing sections (Features onward) — verify it
doesn't fight Reveal (reveal wrapper sits inside the section, test scroll behavior).

Verify: typecheck/build/tests green; CDP screenshots at 360/390/768/1024/1280/1440 for /, /pricing,
/chat + a pointer:coarse emulated pass (CDP Emulation.setTouchEmulationEnabled or
--blink-settings) to verify 12.3; no window scroll on app pages (V7 invariant must hold).
DO NOT COMMIT.

## 13. V9 — density + light-grey + contrast fixes (user review 2026-07-12 #2)

Reference: Claude.ai's compact chat (user-chosen benchmark). Three workstreams:

13.1 **Compact density pass (app shell)** — the current chat/sidebar is too airy; target
Claude-like density WITHOUT touching the 2026 features:
- Sidebar: rows ~34px (padding 6-7px 10px), list gap 1-2px, section label margins halved,
  New chat ~36px, account footer compact (smaller avatar, tighter padding), RECENTS rows 32px,
  thread action icons 24px hit-area (keep WCAG).
- Chat: thread-head shrinks (title ~16px/600, meta 12px, padding-bottom ~10px); vertical rhythm
  between turns ~20-24px (it's far larger now); message body 14.5-15px / line-height 1.55;
  action toolbar tucked 4px under the message; error-card margins tightened; kill the large empty
  band above the first message.
- Composer: outer bottom margin ~12px, card padding 8-10px 12px, action row 32px controls
  (pointer:coarse still upsizes to 40px per V8), hint row margin-top 4px.
- Header 48px on all widths.
- Settings/models pages: card paddings step down one notch (16-20px), form rows tighter.

13.2 **Light mode goes neutral-grey too** (web layer only, do NOT edit packages/ui): add a
`.light` override block in apps/web globals.css mirroring the V6 rule — interactive ramp de-tinted:
--color-purple: #3c3c42, -mid #55555c, -light #1f1f24, -bright #000, -glow rgba(20,20,25,.14),
-faint rgba(20,20,25,.05); --c-accent: #1f1f24 (near-black ink fill, like ChatGPT light),
--c-accent-contrast: #ffffff, --c-accent-light: rgba(20,20,25,.06), --c-accent-mid:
rgba(20,20,25,.11), --c-accent-dim: #9a9aa2, --c-focus ring rgba(31,31,36,.35). Keep light
surfaces/text as-is. Z logo untouched (marketing accent). Verify selected sidebar rows/chips/send
button read grey-on-light, no lavender anywhere in the app shell.

13.3 **Active-chip contrast bug (dark)**: /models filter segments (e.g. "T0 · Default") render
light fill + white text — unreadable. Find the segmented-chip styles (models page + any sibling
using accent-filled active chips: catalog Chip, settings toggles) and set active ink to
var(--c-accent-contrast) (and border to transparent) so every accent/grey-filled chip pairs
fill+ink from the same token pair. Audit ALL `aria-pressed`/active chip patterns in the app for
the same mistake.

Constraints: V6 grey + V7 chrome + V8 responsive invariants stand; tokens only; tests/aria
preserved; reduced-motion; DO NOT COMMIT. Verify: typecheck/build/tests; screenshots /chat +
/models + /settings in Indigo dark AND Light at 1440 + 390; visually compare density against the
"before" (more rows visible per viewport).

## 6. Guardrails
- Branch `feat/web-dark-redesign` in worktree `~/Projects/zintus-wt-web` only. Never touch `apps/mobile`, `apps/desktop`, `packages/*`.
- Commit per slice with conventional messages. No push.
- Never mention "tokzen" in any user-facing copy (say "compression/saved").
- Don't use `.replace()` for URL manipulation (repo rule).
