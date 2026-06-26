# Zintus Cross-Surface Feature Matrix

The single shared product contract. Every surface declares each capability so no
surface **silently claims an unsupported feature**. Verified against code on
`feat/cross-surface-parity` (off `main`), 2026-06-26.

Legend: ✅ done · 🟡 partial · ❌ missing · 🚫 intentionally unsupported ·
⚠️ **present but broken/misleading** (must fix or remove).

> Mobile reflects the unmerged `feat/mobile-serious-app` branch (see
> `apps/mobile/BUILD-STATUS.md`); it is not on `main` yet.

| # | Feature | Mobile | Web | Desktop | CLI | Notes / source |
|---|---------|:---:|:---:|:---:|:---:|----------------|
| 1 | chat | ✅ | ✅ | ✅ | ✅ | all 4 stream via the gateway |
| 2 | streaming | ✅ | ✅ | ✅ | ✅ | SSE `/v1/chat/completions` |
| 3 | stop generation | ✅ | ✅ | ✅ | 🟡 | web Esc/stop; desktop ChatPanel; CLI = Ctrl-C |
| 4 | provider override | ✅ | ✅ | ✅ | ✅ | web `ProviderPicker`, desktop `ProviderRail` |
| 5 | auto routing | ✅ | ✅ | ✅ | ✅ | omit provider → gateway strategy |
| 6 | routing strategy | ✅ | ✅ | 🟡 | ✅ | web presets+settings; desktop has the value, no chip |
| 7 | markdown rendering | ✅ | ✅ | ❌ | 🟡 | **desktop renders plain text** (`MessageBubble` 42 lines, no md) |
| 8 | code block copy | ✅ | 🟡 | ❌ | 🚫 | verify web; desktop none; CLI = terminal |
| 9 | response intelligence footer | ✅ | ✅ | 🟡 | 🟡 | web `meta`+`compression` in MessageBubble; desktop only `CompressionBadge` |
| 10 | compression % | ✅ | ✅ | ✅ | 🟡 | `X-Zintus-*` headers everywhere |
| 11 | tokens saved | ✅ | ✅ | 🟡 | 🟡 | |
| 12 | cost saved estimate | ✅ | 🟡 | ❌ | ❌ | mobile surfaces saved-vs-Claude; others partial |
| 13 | quota remaining | ✅ | ✅ | ✅ | ✅ | `QuotaBar` / `status` |
| 14 | route-options actions | ✅ | ✅ | ✅ | ❌ | `RouteOptionsPanel` on web+desktop; not in CLI |
| 15 | Deep Research | ✅ | ✅ | ❌ | ❌ | web `(app)/research`; **desktop+CLI missing** |
| 16 | history | ✅ | ✅ | 🟡 | ✅ | web threads/sidebar; desktop weak; CLI `history` |
| 17 | projects / workspaces | ✅ | ❌ | ❌ | ❌ | **only mobile** |
| 18 | Private Mode | ✅ | ✅ | ❌ | 🟡 | web = incognito + privacy chip (`blockTrainingProviders`) |
| 19 | provider key management | ✅ | ✅ | ✅ | ✅ | web `LocalKeyManager`, desktop `ProvidersScreen`, CLI `keys` |
| 20 | provider key test | ✅ | 🟡 | 🟡 | ❌ | mobile has explicit Test; CLI has no `keys test` |
| 21 | local runtime display | ✅ | 🟡 | ✅ | 🟡 | desktop `ProviderRail`; web partial |
| 22 | one-tap local runtime | ✅ | ❌ | ❌ | 🚫 | CLI = `--provider ollama` |
| 23 | file input | ✅ | ✅ | ❌ | 🟡 | web text+image picker (drag/paste); desktop none |
| 24 | image input | ❌ | ⚠️ | ❌ | 🚫 | **web UI sends base64 `images`, gateway DROPS them — no multimodal path. Silent no-op; fix or hide.** |
| 25 | voice input | 🟡 | ❌ | ❌ | 🚫 | mobile = unavailable fallback only |
| 26 | consent gate (pre-send) | ✅ | ❌ | ❌ | ❌ | **only mobile** (Apple 5.1.2(i)); web incognito is opt-in, not a gate |
| 27 | report AI response | ✅ | 🟡 | ❌ | ❌ | mobile = Gen-AI report; verify web |
| 28 | account / session / cloud remote | ✅ | ✅ | 🟡 | ✅ | web login/session; CLI `cloud`+`remote` |
| 29 | export / share | ✅ | ✅ | ❌ | ❌ | web `exportThread`→md; desktop+CLI none |

## Cross-surface issues to resolve (ranked)

1. **⚠️ Web image input is a silent no-op (#24).** `apps/web/app/(app)/chat/page.tsx`
   reads images and `chat-client.ts` sends `images:[{data,mimeType,name}]`, but the
   gateway has **no image request path** — `content` is `z.string()`
   (`packages/schemas/src/index.ts`) so the field is stripped; the model never sees
   the image. Confirmed by grep across gateway/engine/providers/types. **Action:**
   either hide web image attach until the multimodal backend exists
   (`docs/multimodal-image-plan.md`), or build that backend. Do **not** leave a
   silent broken feature — it violates the "no silent unsupported features" rule.
2. **Desktop is the parity laggard (#7,15,16,17,18,23,26,27,29).** No markdown,
   Deep Research, projects, Private Mode, consent, export; weak history; footer is
   only a compression badge. This branch's primary build target.
3. **Projects (#17) and consent gate (#26) exist only on mobile.** Port to
   web + desktop (consent is also a store-compliance item).
4. **CLI lacks `research`, `projects`, `keys test`, `--json` everywhere (#15,17,20).**

## Hard-rule audit (this branch)

- `MANAGED_KEYS_AVAILABLE = false` holds: the only `createCheckout` call site
  (`apps/web/app/pricing/page.tsx`) is guarded by `if (!MANAGED_KEYS_AVAILABLE) return`
  before the call; paid tiers render "Coming soon".
- Gated-but-present (kept per decision, audit-only): `apps/web/lib/billing.ts`
  (`createCheckout`/`openBillingPortal`), `dashboard/billing`, `pricing`,
  **referral payouts** (`fetchReferralStats.earned_cents`, `app/r/[code]`). These
  contradict the literal "no referral payouts / no paid overflow" rule but are
  disabled by the gate. Decision on this branch: **keep gated, document as future,
  do not expand.** Re-confirm the gate before any release.
- No server-side provider-key custody, no prompts/files to relay: unchanged
  (relay = auth/session only).

## How to keep this honest

Update the relevant row in the same PR whenever a surface gains/loses a feature.
A surface may only show ✅ when the feature is wired end-to-end (UI → gateway →
provider), not when the UI merely exists. The web image row (⚠️) is the cautionary
example.
