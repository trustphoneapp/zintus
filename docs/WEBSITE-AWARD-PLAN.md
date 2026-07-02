# Zintus Website — honest audit + award-winning plan

Date: 2026-07-02. Scope: `apps/web` marketing site (`app/page.tsx` + 19
sections, 6,034-line `globals.css`) and the product shell.

## 1. Honest verdict

**The site is genuinely good — top-tier production quality, not a template.**
Evidence: 19 hand-built marketing sections, a real design-token system
(`@zintus/ui/tokens.css`), 5 curated typefaces (Syne display / Plus Jakarta /
Lora serif / JetBrains Mono / Inter), a custom canvas GalaxyBackground,
framer-motion scroll reveals, light/dark themes, a command palette, a custom
icon set, and `prefers-reduced-motion` respected in 4 places. Call it a solid
**A− marketing site**.

**But "award-winning" (Awwwards SOTD, CSS Design Awards, Webby) is a different
bar, and it is NOT there yet.** Award juries reward one *singular concept +
signature interaction executed flawlessly*, not a well-made stack of
conventional SaaS sections (hero → trust bar → stats → features → FAQ → CTA).
Three things block an award today:

### Blocker 1 — the narrative contradicts the product (also just wrong)
The hero says **"One subscription. Exact tokens."** and *"Most AI
subscriptions hide their limits…"* — a SaaS framing for a product whose entire
identity is **local-first, BYOK, no SaaS bill, no hosted control plane**. The
terminal animation says **"routing across 12 providers"** (it is 22 since
2026-07-02). Stats say **"50+ providers / 100+ models"** while the router
reaches 22 (the catalog honestly splits routable vs planned — the marketing
number doesn't). A jury (and a savvy user) reads this as incoherent. Honesty is
Zintus's whole wedge; the homepage undercuts it.

### Blocker 2 — no signature concept
There is a mock chat demo and a typing terminal — nice, but conventional.
Nothing on the page is a *thing people screenshot and send to a friend*. Award
sites have one unforgettable interaction.

### Blocker 3 — craft unknowns that juries hard-gate on
Awwwards scores Design/Usability/Creativity/Content, and performance +
accessibility are now effate gates. Unmeasured here: Lighthouse/Core Web
Vitals with a canvas bg + framer-motion + a 6k-line CSS file; a11y beyond the
16 aria/role hits; keyboard/focus order across the marketing sections; the
GalaxyBackground and framer Reveals honoring reduced-motion.

## 2. The award-winning concept: "The Glass-Box Router"

Zintus's real, un-copyable differentiator is **radical transparency of
routing** — you can see exactly where every token goes, what it would have
cost, and how much quota is left. No competitor can show this because no
competitor is local-first BYOK. **Make that the hero, and make it live.**

The signature interaction: a full-viewport, physically-animated **routing
visualization**. The visitor types (or picks) a prompt; a token-packet visibly
travels from the composer through the router core and *fans out across the 22
providers*, each a node showing live-style quota bars, latency, and a running
"$ saved vs paid API" counter that ticks up as the response streams back. It is
the product's actual value made spatial and kinetic — the "glass box" you can
see inside. This is the screenshot-and-share moment, and it is TRUE (it mirrors
the real `/v1/route/options` + savings data), so it doubles as the honesty
proof instead of fighting it.

Why this wins where a generic redesign wouldn't: it is *concept-first*
(juries reward a singular idea), *unique to Zintus* (structurally
un-clonable), and *on-brand* (transparency, not hype).

## 3. Plan

### Phase W0 — Truth pass (0.5 day) — do first, ships alone
Fix the contradictions regardless of the redesign; they are bugs.
- Hero: replace the "subscription" framing with the real one — *"See exactly
  where every token goes. Your keys, 22 providers, zero platform fee."*
- Terminal + all copy: 12 → 22 providers; align the Stats numbers with the
  honest catalog split (or label them "catalog incl. planned" explicitly).
- Sweep every marketing string against `docs/FEATURE-MATRIX.md` +
  `README.md` for over-claims. Add a `marketing-honesty.test.ts` that asserts
  the provider count in copy equals `PROVIDER_IDS.length` so it can't drift
  again (mirrors the existing `catalog-honesty.test.ts` pattern).

### Phase W1 — Craft gates (2–3 days) — required for any submission
- Lighthouse/CWV budget in CI (perf ≥ 90 mobile, LCP < 2.5s, CLS < 0.1).
  Lazy-mount GalaxyBackground + defer framer sections below the fold; split
  the 6k-line CSS by route.
- A11y pass: full keyboard nav + visible focus on every marketing control,
  aria labels, color-contrast audit in both themes, and make the
  GalaxyBackground + every framer Reveal fully static under
  `prefers-reduced-motion` (Reveal.tsx currently animates regardless).
- Cross-browser + real-device pass (Safari canvas/backdrop-filter quirks).

### Phase W2 — Signature build (1–2 weeks) — the award piece
- Build the Glass-Box Router hero as a self-contained, deterministic
  animation (SVG/Canvas or lightweight WebGL) driven by REAL shapes: the 22
  providers from the manifest, `paidEquivalentUsdPerMTok` for the savings tick,
  the route-options quota model. Deterministic + reduced-motion fallback (a
  static, still-beautiful diagram).
- Interaction: type a prompt → watch it route. One "Try it live" button hands
  off to `/chat` (or the local gateway if running).
- Motion signature: one consistent easing/choreography language applied
  everywhere (the packet flow, reveals, hovers) so the whole site feels
  authored, not assembled.

### Phase W3 — Depth + polish (3–5 days)
- A genuinely interactive **savings calculator** (drag your monthly token
  volume → see $ saved vs Claude/GPT list price, from the real pricing table).
- Provider grid → live-feeling node cards (hover = that provider's real
  free-tier + data-policy from `DATA_POLICIES`/`PROVIDER_METADATA`).
- Case-for-honesty section that turns the FEATURE-MATRIX rigor into a selling
  point (the "we label what's not done" story is itself award-worthy content).
- OG image + `/r/[code]` share cards that render the glass-box frame.

### Phase W4 — Submit (1 day)
- Awwwards + CSS Design Awards + Webby. Submission needs: the signature hero,
  ≥90 perf, clean a11y, a 20-40s screen capture of the routing interaction,
  and a tight "why it exists" write-up (the honesty thesis).

## 4. Sequencing vs the master plan
- **W0 is independent and should ship this week** — it's a truth/bug fix, not a
  redesign, and it's the cheapest credibility win available.
- W1 craft gates are worth doing before the public v0.9 launch regardless of
  awards.
- W2/W3 (the actual award push) should follow the P0 ship gate
  (`docs/HUMAN-WORK.md` §A) — an award submission for a product you can't yet
  install is premature. Ship first, then submit.

## 5. What I would NOT do
- Don't chase a generic "make it flashier" redesign — award juries penalize
  motion-for-motion's-sake, and it would dilute the one concept.
- Don't fabricate live numbers to look impressive — the honesty is the moat;
  the glass box must show real/representative data or clearly-labelled demo data.
- Don't block the product launch on the award push; they're parallel tracks.

## [HUMAN] for the award track
- Final art direction / motion-designer review of the glass-box concept.
- A real Lighthouse run on deployed prod (needs the site live — ties to relay/
  Vercel deploy in `docs/HUMAN-WORK.md`).
- The award submissions themselves (accounts + fees + the capture video).
