# Zintus Web+Chat Company — Org Charter (CEO: Fable)

Scope: apps/web ONLY — the marketing website and the /chat app (V2–V9 uncommitted stack on
feat/web-dark-redesign, served at http://127.0.0.1:3000). Mission: audit everything, prove what
works, find what doesn't, rank it, and report to the CEO. This round is READ-ONLY: no agent edits
files, commits, or starts/stops servers. Fix rounds are assigned by the CEO afterward.

## Global rules (every agent)
1. Evidence or it didn't happen: every finding carries a repro (URL + steps + viewport/mode) and
   evidence (exact text, measured px, screenshot path, or code line).
2. Severity scale: P0 = broken/unusable or dishonest to users; P1 = clearly wrong, users will hit
   it; P2 = quality gap vs the spec/benchmarks; P3 = polish nit.
3. The spec is law: docs/design/web-dark-redesign-spec.md (§1–13). Deviations from it are
   findings; disagreements with it are P3 "spec-challenge" notes, not bugs.
4. Standing product rules: never surface "tokzen"; chat interactions are neutral grey (chroma only
   on the Z mark); accent budget on marketing; no colored glows; honesty in all user-facing copy.
5. Do not edit, commit, install, or run servers. Screenshot via headless system Chrome against the
   running localhost:3000. If the server is down, report BLOCKED — do not start one.
6. Report your lane only; name files/selectors precisely; no duplicate-hunting outside your lane.

## Departments and lanes

### D1 Functional QA — Marketing (5 testers)
T1 home (hero, terminal loop, console demo, ledger section, stats, marquee, reveals)
T2 pricing (tiers, beam, checkout buttons render, cost table scroll, referral rows)
T3 download + docs + developers + catalog (copy buttons, filters, chips)
T4 changelog + legal pages + contact + account/delete (links, buttons, layout)
T5 navbar/footer/mode-switcher (3 modes switch everywhere, condense-on-scroll, hamburger ≤1023)

### D2 Functional QA — Chat app (6 testers)
T1 composer (typing, auto-grow, attach +, More menu contents, model chip dropdown, kbd hints)
T2 messages (user/assistant render, error cards incl. legacy, copy/regenerate/report, details)
T3 sidebar (new chat, workspace nav, recents groups, pin, search filter, account footer)
T4 header + banners (48px, search, share, theme toggle, incognito, offline/local strips)
T5 secondary app pages (/models, /settings, /usage, /compare, /projects — render + controls)
T6 mobile behaviors at 390px (drawer + scrim, composer fit, empty state chips, jump-to-latest)

### D3 Design Review (5 reviewers)
R1 Indigo dark full pass (marketing+chat) — machined depth present, accent budget respected
R2 Obsidian + Graphite passes — mode overrides complete, silver hero rule, teal-links-only rule
R3 Light mode pass — grey interactions everywhere, no lavender remnants, readable fills
R4 Typography/spacing system — fluid tokens applied, line lengths, density values per §13.1
R5 Interaction grammar — hover/press/focus on every control, beam/spotlight/magnetic working

### D4 Responsive & Devices (5 testers)
V1 360×740, V2 390×844, V3 768×1024 + 834×1112, V4 1024×768 + 1280×800, V5 1440×900 + 1920×1080
Each: marketing home+pricing AND /chat; no horizontal overflow, no window scroll on app pages,
correct shell per class (sidebar/rail/drawer), container-query behaviors.

### D5 Accessibility (4 auditors)
A1 keyboard-only walkthrough (marketing nav → CTA; chat composer → send → message actions)
A2 semantics/ARIA (radiogroups, menus, aria-pressed chips, alert roles, details/summary)
A3 contrast (WCAG AA) across all 4 modes on key pairs (muted-on-canvas, chips, badges, buttons)
A4 touch targets ≥24px (2.5.8) + coarse-pointer 40px floors actually applying

### D6 Performance (4 auditors)
P1 build output audit (page weights from next build, largest chunks, css size)
P2 animation cost (beam/marquee/spotlight/grain — layers, will-change, reduced-motion off states)
P3 render stability (CLS risks: reveals, tickers, fonts, content-visibility sections)
P4 runtime smoke (headless trace of / and /chat: console errors, failed requests, long tasks)

### D7 Code Quality (5 reviewers)
C1 globals.css audit (dead rules — e.g. legacy composer classes, duplication, ordering hazards)
C2 new marketing components review (InteractiveCard, TransparencyLedger, hooks — correctness)
C3 chat page diff review (composer/scroll/regenerate override paths — edge cases, leaks)
C4 Sidebar/AppShell/MessageBubble review (state, effects, store contracts)
C5 spec-vs-code drift (walk §1–13, verify each shipped claim actually exists in code)

### D8 Security & Honesty (3 auditors)
S1 rendering safety (Markdown/error payloads/attachment names — injection surfaces)
S2 storage/privacy (localStorage contents, incognito mode honesty, EXIF-strip claim)
S3 copy honesty (pricing claims vs relay tiers file, "free forever", roster counts, no "tokzen")

### D9 Integration Cell (2 engineers)
I1 full gates: typecheck, build, bun test — report exact outputs
I2 invariants: kill-list grep zero; no-window-scroll on app pages; 3-mode tokens complete;
   git status clean of unintended files (build artifacts, stray screenshots in tracked dirs)

### Leads (8, one per D1–D8)
Receive their department's raw findings; kill non-repro claims; dedupe; rank by severity;
return top findings + a one-paragraph department verdict (ship-ready? what blocks?).

### CEO (Fable)
Owns this charter, the workflow, and the executive report: overall verdict, P0/P1 list,
fix-round assignments (Opus complex / Sonnet light), and what is provably good.

## Communication contract
Workers → structured findings JSON (title, severity, area, file/selector, repro, evidence).
Leads → ranked digest JSON. Integration → gate results. CEO → exec report to the user.
