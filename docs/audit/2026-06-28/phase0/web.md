# Phase 0 — From-disk audit: **Web** (`apps/web`)

Branch `feat/zintus-10-10`. Benchmark = **OpenRouter** web product (model catalog,
provider/pricing pages, activity/usage, BYOK key UI). Read actual code only.
Legend: ✅ real + wired · 🟡 partial/weak · ❌ absent · 🔒 gated-off (honest).

## Capability matrix

| Row | Status | Evidence (file:line) | Notes |
|---|---|---|---|
| chat | ✅ | `app/(app)/chat/page.tsx:112` | Streaming, threads, regenerate, stop, incognito, export. |
| markdown | ✅ | `app/_components/Markdown.tsx`; `MessageBubble.tsx:175` | Full markdown + code blocks; JSON auto-rendered as code. |
| image input | ✅ | `chat/page.tsx:263,558`; `lib/image-attachments.ts` | Real `processImage` (resize+EXIF strip), 4-image cap, vision guard pre-send + post-send "analyzed by X". |
| file input | 🟡 | `chat/page.tsx:55,314` | Text files only (extracted + folded into prompt). No PDF/binary/doc parsing. |
| voice input | ❌ | — | No mic / SpeechRecognition / getUserMedia anywhere. |
| tool calling | ✅ | `chat/page.tsx:386,446`; `lib/web-tools.ts` | Built-in browser tools (calc/datetime/random), bounded 5-round loop, rendered as cards. |
| structured output | 🟡 | `MessageBubble.tsx:38,172`; `lib/chat-client.ts:117` | Display-only: auto-detects JSON answers. UI cannot **request** json_schema/response_format (chat-client sends `tools` but no `response_format`). |
| deep research | ✅ | `app/(app)/research/page.tsx:44`; `lib/gateway.ts:374` | Quick/Standard/Deep, live stepper, cited sources, export, continue-in-chat. |
| compare | ✅ | `app/(app)/compare/page.tsx:45` | 2–4 providers side-by-side, fastest/longest winner, use-this-answer. |
| projects | ✅ | `app/(app)/projects/page.tsx:35`; `lib/projects.ts` | localStorage workspaces: instructions + provider + strategy + private default. |
| provider keys | ✅ | `app/(app)/providers/page.tsx:114` | Per-provider validate/save/remove, get-free-key links, cap badges, policy badges. |
| BYOK vault | 🟡 | `providers/page.tsx:226`; `lib/crypto.ts`; `LocalKeyManager.tsx` | AES-256-GCM single-passphrase vault. No prioritized/fallback keys, no per-key quota, no "why unavailable". |
| local runtime | 🟡 | `ProviderPicker.tsx:58`; `providers/page.tsx:191` | ollama/lmstudio treated as providers (status "local"). No detection cards / runtime cockpit on web. |
| routing strategies | ✅ | `ProviderPicker.tsx:29`; `settings/page.tsx:203`; `lib/settings.ts` | fastest/economy/capability/quality/balanced wired → gateway `strategy`. |
| route reason | 🟡 | `TransparencyStrip.tsx:57,111`; `usage/page.tsx:267` | Shows strategy + failover waterfall + privacy-honored. No prominent per-message "why this provider" reason string. |
| quota display | ✅ | `app/_components/QuotaBar.tsx`; `providers/page.tsx:319`; `usage/page.tsx:200` | Per-provider % + token counts (gateway-held keys only; vault keys show "—" honestly). |
| compression savings | ✅ | `app/_components/CompressionBadge.tsx`; `TransparencyStrip.tsx:78`; `usage/page.tsx:222` | Per-response saved-$ + savings ledger by provider. |
| usage/activity | 🟡 | `app/(app)/usage/page.tsx:27` | Quota + savings + **last 5 traces** only; JSON/CSV export. Not a paginated activity history. (30-day token chart lives in gated `dashboard/billing`.) |
| model catalog | ❌ | — | **No catalog page.** Only provider cards, one default model each (`MODEL_CAPABILITIES[providerId]`). `fetchGatewayModels` returns bare id strings, used only in `terminal/page.tsx:143`. |
| pricing catalog | 🟡 | `app/pricing/page.tsx` | Marketing subscription tiers only. No per-model token-price browse (pricing data exists in `packages/providers/pricing.ts` but no web catalog UI). |
| API docs | ✅ | `app/docs/page.tsx:48`; `app/developers/page.tsx` | Endpoint table + curl + SDK snippets. 🟡 no interactive playground. |
| OpenAI-compatible API | ✅ | `app/developers/page.tsx:10`; `docs/page.tsx:227` | Documented `POST /v1/chat/completions`; served by gateway, not web app. |
| account/auth | ✅ | `lib/auth.ts:49` (magic-link/better-auth); `app/login`; `app/account/delete/` | Magic-link sign-in, sign-out, account deletion widget. |
| security | ✅ | `app/security/page.tsx`; `public/.well-known/security.txt`; `ConsentDialog.tsx`; EXIF strip | Send-consent gate before first 3P send; keys never leave device. |
| observability | 🟡 | `app/(app)/terminal/page.tsx`; `lib/gateway.ts:294` (traces) | Terminal log + trace feed. No dashboard/status page in web. |
| billing/paid overflow | 🔒 | `app/pricing/page.tsx:17` (`MANAGED_KEYS_AVAILABLE=false`); `dashboard/billing/page.tsx`; `RouteOptionsPanel.tsx:14` | Checkout disabled, honest "Coming soon". Route-options never returns a paid/overflow action (BYOK-only) — honest. |
| referral/node marketplace | 🔒 | `lib/billing.ts:34` (`REFERRAL_PAYOUTS_LIVE=false`); `dashboard/billing/page.tsx:419` | Accrues server-side, payouts gated, renders "Coming soon" not a $ figure — honest. No node/compute marketplace. |

## OpenRouter-grade gap analysis

**(1) Real models catalog?** ❌ No. There is a **providers** page (`providers/page.tsx`)
with capability/policy/quota badges, but it is provider-keyed with exactly one default
model each (`MODEL_CAPABILITIES[providerId]`). No browse/filter/search, no model detail
page, no "use this model → chat", no compare-from-catalog. This is the single biggest gap
vs OpenRouter.

**(2) Usage/activity history page?** 🟡 Partial. `usage/page.tsx` shows live quota,
savings-by-provider, and only the **last 5** routing traces — not a paginated, filterable
activity log. A real 30-day token chart exists but is buried in the **gated** relay-backed
`dashboard/billing` page. No per-request cost/token/model history browser.

**(3) BYOK an OpenRouter-grade cockpit?** 🟡 Basic. Single-passphrase AES vault with
validate/save/remove and live quota for gateway-held keys. Missing: prioritized + fallback
keys per provider, per-key quota/limits, "why unavailable" diagnostics, key-level data-policy.
`RouteOptionsPanel` (compress/switch/local/wait) is the closest thing to "best next action"
but only renders under a low-quota provider card, not as a control center.

**(4) Chat UI hierarchy.** Composer is **cluttered**. `chat/page.tsx:868-997` packs into one
wrapping toolbar row: ProviderPicker, preset `<select>`, Search toggle, Tools toggle,
Incognito toggle, Vision chip, Privacy chip, Project chip(+×), and Export. Route-reason lives
*below* each message (TransparencyStrip), not on top. Export sits in the composer toolbar
(should be header). Tools/Search/Private/Presets should collapse into menus; Incognito belongs
under New Chat. Attach + textarea + send (`:1057`) are clean; the top bar is the problem.

**(5) False / overstated UI claims.**
- **Structured output**: providers page shows a "JSON" capability chip (`providers/page.tsx:63`)
  implying schema-guaranteed output, but the web chat UI provides **no way to request** json_schema/
  response_format — it only auto-renders JSON the model happens to emit. Capability implied, not reachable from Web.
- **Pricing page** lists managed-key tier features ("Zintus manages your keys", "5M tokens/mo",
  "Usage dashboard", "API access") behind "Coming soon" — acceptable since gated + disabled, but the
  comparison table presents unbuilt tiers as concrete products.
- **"Local model" / local runtime**: surfaced as a route option and provider status with no actual
  on-web detection of a running Ollama/LM Studio — relies entirely on the gateway.
- Otherwise honesty bar is well held: vault-only quota shows "—" not 0%; referral renders "Coming
  soon" not $; image route hard-errors via `UnsupportedCapabilityError`.

## Brutal priorities (Web → OpenRouter-grade 10/10)

**P0**
1. **Models Catalog UI** (`app/(app)/models`): search/filter by vision·tools·json·price·free·local·
   privacy·quota; model detail page; "Use this model → chat"; "Compare". Requires Phase-1 model-keyed
   data. This is the defining missing surface.
2. **Activity/Usage page**: promote a real paginated request history (model, tokens, cost, latency,
   route, failover) into `usage` for the free/local path — not just last-5 traces, not gated behind billing.
3. **Chat composer hierarchy cleanup**: collapse Search/Tools/Private/Presets into menus; move Export to
   header; surface route-reason at message top; Incognito under New Chat.

**P1**
4. **Provider Control Center / BYOK cockpit**: prioritized + fallback keys, per-key quota/limit, "why
   unavailable" + "best next action" always-on (not only on low quota), data-policy per key, local-runtime cards.
5. **Structured-output request UI** (or remove the JSON capability implication from chat): expose
   response_format/json_schema so the advertised capability is reachable.

**P2**
6. **Pricing catalog** (per-model token pricing browse) distinct from subscription pricing.
7. **API playground** on `/docs` (live request against local gateway).

**P3**
8. Observability/status surface in-app; PDF/binary file input; consolidate the gated relay billing
   history with the local usage page once paid foundation lands.
