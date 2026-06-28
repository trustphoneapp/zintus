# 04 — Cross-Platform Consistency + Honesty Audit (Final 10/10 gate)

Branch: `feat/zintus-10-10` (HEAD). Read-only. Benchmark rule (ROADMAP §4):
web + iOS + Android must feel like **one Zintus** — same surfaced truths
(provider, route-reason, tokens, quota, privacy, cost, tools, files/images,
catalog). **Desktop may use its own native idiom.** CLI surfaces the same truths
in text. Mobile = the serious app on `feat/mobile-serious-app` (read via `git
show`); the on-branch mobile app is a basic single-screen chat.

Method: read the actual surface code (not the docs' self-claims). Where the
shipped code now disagrees with `docs/FEATURE-MATRIX.md`, the code wins and the
divergence is noted.

---

## A. Per-surface truth matrix (verified against code)

Legend: ✅ surfaced/wired · 🟡 partial or divergent flavor · ❌ absent · `idiom`
= desktop's allowed native variant.

| Surfaced truth | Web | Desktop | iOS | Android | CLI |
|---|:--:|:--:|:--:|:--:|:--:|
| provider attribution | ✅ | ✅ | ✅ | ✅ | ✅ |
| **route-reason** (engine `buildRouteReason`) | ✅ | ❌ | 🟡 | 🟡 | ❌ |
| compression / savings | ✅ | ✅ | ✅ | ✅ | 🟡 |
| tokens (per-response) | ✅ | ✅ | ✅ | ✅ | ❌ |
| quota | ✅ | ✅ | ✅ | ✅ | 🟡 |
| privacy signal (Private Mode/consent) | ✅ | ✅ | ✅ | ✅ | 🟡 |
| cost estimate | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| **tools** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **image input** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **structured output (request UI)** | ❌ | ✅ | ❌ | ❌ | ❌ |
| **catalog** | ✅ | ❌ | ❌ | ❌ | ❌ |

### Evidence
- **route-reason** now exists in core: `packages/engine/src/engine.ts:757,878,996`
  (`buildRouteReason`) → gateway header `X-Zintus-Route-Reason` + SSE `route_reason`
  (`apps/gateway/src/handler.ts:185,1068`) → rendered **web-only** in
  `apps/web/app/_components/MessageBubble.tsx:171,188`. Desktop has **no**
  `route_reason` reference anywhere (`apps/desktop/**` grep = 0). CLI prints provider +
  trace + savings (`apps/cli/src/commands/chat.ts:182-211`) but **never** route-reason,
  per-response tokens, quota, or cost. Mobile `ResponseFooter` renders
  `routeOptions.reason` (`feat/mobile-serious-app:apps/mobile/components/ResponseFooter.tsx:153`)
  — but that is the **quota/route-options** reason (`/v1/route/options`), a *different*
  string from the new engine `buildRouteReason`. So the headline Phase-1 truth is
  effectively **web-only**, with a divergent older variant on mobile.
- **tools**: web `apps/web/lib/web-tools.ts`, desktop `apps/desktop/lib/web-tools.ts`,
  CLI `--tools` (`chat.ts:169` `loadTools`). Mobile `lib/chat.ts` has **zero** tool
  plumbing (grep tools/image/response_format = 0).
- **image**: web `apps/web/lib/image-attachments.ts`, desktop now imports
  `@zintus/media` + `@/lib/image-attachments` (`ChatPanel.tsx:13,21-27`) — **newer
  than `FEATURE-MATRIX.md`, which still lists desktop image ❌** — CLI `--image`
  (`chat.ts:168`). Mobile: absent.
- **structured output**: desktop has a real JSON toggle →
  `response_format: { type: "json_object" }` (`ChatPanel.tsx:135-136,245,674`,
  `gateway.ts:422`). Web chat (`apps/web/app/(app)/chat/page.tsx`) has **no**
  `response_format`/Structured request control (only capability *labels* in the
  models catalog). So desktop is *ahead* of web here. Mobile/CLI: none.
- **catalog**: web only — marketing `/catalog` (`apps/web/app/catalog/page.tsx`)
  + the in-app models catalog (`apps/web/app/(app)/models/*`). No catalog/`models`
  surface on desktop source, CLI (no `models` command), or mobile.
- CLI quota: `apps/cli/src/lib/router.ts:34` now uses `status.tokensLimit ??
  meta.quotaLimit`, but the hardcoded `1_000_000` fallback still lives at line 21
  (🟡 — softened from the old always-fabricated denominator, not removed).

---

## B. Consistency score: **5 / 10**

**What holds (the real win):** the *moat footer* layer is genuinely consistent
across web / desktop / iOS / Android — **provider, compression savings, tokens,
quota, privacy signal** all surface uniformly. Mobile's `ResponseFooter` is a
faithful sibling of the web/desktop footer. That base layer *does* feel like one
Zintus.

**Why not higher — divergences that break "one Zintus":**

1. **Route-reason is web-only.** The flagship Phase-1 P0 truth (engine
   `buildRouteReason`, the literal example in rule §4) reaches **only web**.
   Desktop ❌, CLI ❌, and mobile shows a *different* string (the quota-decision
   reason). The one truth the consistency rule names first is the least
   consistent. **[worst divergence]**
2. **Mobile lacks tools + image entirely.** iOS/Android — the two surfaces that
   MUST match web — have no tool UI and no image input, while web/desktop/CLI all
   do. The just-built flagship (multimodal image) and tool-calling never crossed
   to mobile, so mobile reads as an older, lesser app. **[worst divergence]**
3. **Catalog is web-exclusive.** A named surfaced truth ("catalog") exists on web
   only; desktop/mobile/CLI have no catalog surface.
4. **Structured-output is inverted.** Desktop (allowed its own idiom) is the *only*
   surface with a real structured-output request UI; web — which must match mobile
   — has none. Among the must-match trio it's at least *consistently absent*, but
   it signals the build order skipped the surfaces the rule prioritizes.
5. **CLI text parity gap.** CLI omits route-reason, per-response tokens, quota, and
   cost from its output — it surfaces provider + cumulative savings only, so it does
   not yet "surface the same truths in text."

Net: the moat/footer foundation is one Zintus (≈ the four base truths), but **3 of
the 8 named per-surface truths (route-reason, tools, images) plus catalog have not
propagated to mobile**, and route-reason/structured are scattered. The product is
consistent at the floor and divergent at the ceiling → **5/10**.

---

## C. Honesty findings (marketing / pricing / catalog / docs vs verified backend)

### MUST-FIX before launch
1. **Pricing page asserts a referral payout that does not exist.**
   `apps/web/app/pricing/page.tsx:459` — *"Paid out monthly via Stripe."* plus the
   specific reward table (`:150-155`, e.g. "20% recurring · $9.80/mo · $117.60/year")
   and the "Earn by sharing" CTA (`:505`). The codebase has
   `REFERRAL_PAYOUTS_LIVE = false` and **no disbursement path** (`apps/web/lib/billing.ts:28-46`);
   the dashboard itself says "*payouts are coming soon … can't be withdrawn yet*"
   (`apps/web/app/dashboard/page.tsx`). The pricing page directly contradicts the
   backend truth and its own dashboard. **Reframe as "coming soon" / remove the
   "Paid out monthly via Stripe" assertion.** (Violates ROADMAP §3 honesty bar +
   "referral payout absent" rule.)

2. **Hero install claim is Node-unsafe and version-wrong.**
   `apps/web/components/marketing/Hero.tsx:7,94,127` lead with `npm install -g zintus`
   (the copy button literally copies it) with **no Bun-runtime caveat**, and the
   terminal shows `✓ zintus@2.0.0 installed` (`:97`). Reality: the CLI requires the
   **Bun** runtime (`bun:sqlite`/`Bun.serve` still pervasive — engine
   `conversation-store.ts`, router `quota-ledger.ts`; `apps/cli/package.json`
   `engines.bun >=1.1.0`), and the real version is **0.2.0**, not 2.0.0. The CLI
   README (`apps/cli/README.md:13-16`) is honest about the Bun requirement; the Hero
   is not. This is the same "npm-without-bun" cardinal issue Phase 0 flagged, now on
   the marketing surface. **Add the Bun caveat (or change the lead command) and fix
   the version string.**

### WATCH / minor overstatement
3. **Catalog "the rest via your key" overstates BYOK reach.** The web `/catalog`
   lists **55 providers** (`apps/web/data/providers.ts`), of which only **11 are
   `integrated`** + OpenRouter = the **12** providers the engine actually wires
   (`packages/providers/src/factory.ts:17-30`). The other **43 `add-key`** rows
   (Anthropic, OpenAI, Together, AWS Bedrock, Azure OpenAI, NVIDIA NIM, Perplexity,
   …) are **not** in `MODEL_CAPABILITIES`, are not selectable in the key manager
   (ProviderId-constrained), and are reachable only *via OpenRouter* if at all — yet
   each carries an **"Add your key"** badge implying a direct BYOK route that does
   not exist. The honest hedge ("11 integrated today, the rest via your key",
   `catalog/page.tsx:163-166`) softens but does not resolve it. **Either wire those
   providers, relabel the badge (e.g. "via OpenRouter"), or scope the count.**
4. **"50+ providers / 100+ models" — backed but borderline.** `Stats.tsx:4-5` and
   `ProviderGrid.tsx:104` claim "50+" / "100+". The catalog data has **55 providers
   and exactly 100 models** (counted in `apps/web/data/providers.ts`; the catalog
   stat strip derives counts honestly via `catalog-stats.ts`). "50+" is fine; "100+"
   is technically *100, not 100+*. Tie this to caveat #3: the count is real as a
   catalog of *names*, but only ~12 are routable today.
5. **Hero "Managed keys from $15/mo →"** (`Hero.tsx:78`) presents a coming-soon,
   custody-gated product as an available price tier without a "coming soon" marker.
   The pricing page itself correctly disables those CTAs ("Coming soon", buttons
   `disabled`, `pricing/page.tsx:316-327`). Add the same marker on the Hero teaser.

### Honesty WINS (keep)
- **No competitor names** on the Hero or pricing page (uses "Most AI subscriptions",
  "Some AI products", "$20/$100/$200 subscription") — rule holds.
- Managed-key checkout is genuinely gated: only `createCheckout` call site is behind
  `if (!MANAGED_KEYS_AVAILABLE) return`; paid tiers render disabled "Coming soon".
- Catalog stat strip counts are **derived** from the data arrays (`catalog-stats.ts`),
  so the headline can't silently drift from the rows.
- Dashboard referral earnings honestly show "Coming soon" while gated
  (`formatReferralEarned`, `REFERRAL_PAYOUTS_LIVE=false`) — the pricing page is the
  one place that breaks this.
- Backend `MODEL_CATALOG` (`packages/providers/src/catalog.ts`) is explicitly labelled
  curated/best-effort and `catalog.test.ts` asserts its capability flags mirror
  `capabilities.ts` — it cannot over-claim a capability.

---

## D. Bottom line
Consistency **5/10**: a genuinely uniform moat-footer floor (provider/savings/
quota/privacy) undermined by a web-only ceiling — route-reason, tools, image, and
catalog never reached iOS/Android, and route-reason/structured are scattered across
surfaces. Two honesty items must be fixed before launch: the pricing page's
"Paid out monthly via Stripe" referral claim (no payout path exists) and the Hero's
Node-unsafe / `2.0.0` install claim. The catalog's 43 unwired "Add your key"
providers should be relabeled or scoped.
