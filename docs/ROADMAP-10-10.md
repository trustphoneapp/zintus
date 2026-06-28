# Zintus 10/10 Roadmap — OpenRouter-grade, local-first AI router

**North star:** Zintus is the **user-owned AI router** — not another ChatGPT. Benchmark
against **OpenRouter** (catalog, routing, BYOK, pricing/usage transparency, developer API),
with Zintus's unique moat layered on top: **local-first / no-custody / BYOK** + **Tokzen
compression & a provable savings ledger** + **capability/quota/privacy intelligence**.

## Non-negotiable rules
1. **Core is free, forever.** Catalog, routing, BYOK, intelligence, per-response Tokzen
   savings, chat on every surface, local runtimes, key management — never paywalled.
   Paid = premium *coordination* only (sync, activity history, aggressive Tokzen tiers,
   advanced routing objectives, team).
2. **No custody.** Keys stay local. `MANAGED_KEYS_AVAILABLE=false` stays until a custodial
   plane is deliberately built with fraud/billing/legal. Pricing is **savings-funded**
   ("Pro saved you $X this month").
3. **Honesty bar.** No `✅` without code + test + a real UI/API path. No image claim unless
   it reaches a vision provider and non-vision hard-errors. No tool claim unless calls
   execute or are clearly exposed.
4. **Consistency.** Web + iOS + Android must feel like **one Zintus** (shared design
   language + the same surfaced truths: provider, route reason, tokens, quota, privacy,
   cost estimate, tools, files/images). **Desktop may use its own native idiom.** CLI
   surfaces the same truths in text.
5. **Gates per branch:** `bun run typecheck` + `bun run test` + web build + desktop/mobile
   typecheck. Device/cert work (mobile EAS/device, desktop native builds + signing, browser
   screenshots, CSP browser-verify) is a **parallel [HUMAN]/device track** — it does NOT
   gate codeable phases.

## What already exists (seed — verified)
- Capability registry (`packages/providers/capabilities.ts`) — **provider-keyed, one default
  model each** (must become model-keyed). Pricing catalog (`pricing.ts`). Gateway
  `/v1/models`, `/v1/status`, `/v1/route/options`, openapi. Tool calling + structured output
  + multimodal (web/CLI/gateway, desktop tools). Savings ledger. Stripe webhook + tiers +
  referral KV **gated off**. Providers page with capability badges.

## Phases (codeable-first; device/human track runs in parallel)

- **Phase 0 — Truth matrix (no code).** From-disk audit → verified 32×10 matrix (rows ×
  Core/Gateway/Web/Desktop/Android/iOS/CLI/Relay/Docs/Tests), `✅/🟡/❌/🔒` + file refs;
  false-claims list; P0–P3 priority. The source of truth no marketing may exceed.
- **Phase 1 — Model-keyed catalog DATA (prerequisite).** Evolve capabilities + pricing from
  provider-keyed → **per-model**; rich `/v1/models` metadata (price, context, vision, tools,
  json, privacy, local, quota). Decide data source (curate / ingest provider `/models` /
  mirror OpenRouter `/models`).
- **Phase 2 — Models Catalog UI** (web first): search/filter by capability·price·free·vision·
  tools·json·local·privacy·quota; model detail page; "Use this model" → set provider/model +
  open chat; "Compare". Value-add vs OpenRouter = privacy/quota/savings/local columns.
- **Phase 3 — Provider Control Center** (cockpit): connected/missing/cooldown/quota/reset,
  prioritized + fallback keys, per-provider validation, "why unavailable", "best next action"
  (compress/switch/local/wait), data-policy badge, local-runtime cards.
- **Phase 4 — Paid foundation (subscription, no custody):** tier→entitlements on the existing
  Stripe webhook; gate ONLY premium add-ons; savings-funded paywall; honest "coming soon".
- **Phase 5 — Activity/Usage + developer API:** `/v1/activity` (usage history), `/v1/key`
  (quota/key info), OpenAI-compatible docs + playground, error docs. Pro surface + dev platform.
- **Phase 6 — Chat UI hierarchy cleanup:** route-reason on top, export→header, compact mode
  menus, calm composer (attach/input/send simple; Search/Tools/Private/Presets/Project into
  menus; Incognito under New Chat).
- **Phase 7 — Cross-platform parity & consistency:** shared design language across web/iOS/
  Android (same Zintus); mobile chat parity (markdown, image picker/camera, voice, provider
  picker, route reason, compression footer, tool-call display); desktop native idiom +
  structured/image UI. (EAS/device + native builds = parallel [HUMAN] track.)
- **Phase 8 — Reliability & observability:** full gates, gateway load + failover tests,
  observability dashboard, backup/restore drills, status page, incident runbooks.

## Later / gated (not in the free-core push)
- **Custodial managed-keys + credits ledger** (opt-in, last) — fraud/billing/legal/ToS.
- **Referral / node / compute marketplace** — highest risk, much later.

## The 10/10 gate (final)
After implementation, a **competitor-benchmark debate** (red/blue, multi-agent) judges
**features + UI as 10/10** vs ChatGPT, Claude, Gemini, **OpenRouter**, Perplexity, Cursor —
per platform — and verifies the consistency rule. Only then is a surface called 10/10.

## Execution
Plan first (this doc + Phase 0 matrix), then implement in a continuous loop with agent fleets,
scoped PRs each with tests, cross-verified by red/blue debate. Honesty + free-core + no-custody
rules hold at every step.
