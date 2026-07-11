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

## 6. Guardrails
- Branch `feat/web-dark-redesign` in worktree `~/Projects/zintus-wt-web` only. Never touch `apps/mobile`, `apps/desktop`, `packages/*`.
- Commit per slice with conventional messages. No push.
- Never mention "tokzen" in any user-facing copy (say "compression/saved").
- Don't use `.replace()` for URL manipulation (repo rule).
