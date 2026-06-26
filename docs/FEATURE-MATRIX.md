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
| 7 | markdown rendering | ✅ | ✅ | ✅ | 🟡 | desktop now uses dep-free `Markdown.tsx` (parity with mobile) |
| 8 | code block copy | ✅ | 🟡 | ✅ | 🚫 | desktop code blocks have Copy; verify web; CLI = terminal |
| 9 | response intelligence footer | ✅ | ✅ | 🟡 | 🟡 | web `meta`+`compression` in MessageBubble; desktop only `CompressionBadge` |
| 10 | compression % | ✅ | ✅ | ✅ | 🟡 | `X-Zintus-*` headers everywhere |
| 11 | tokens saved | ✅ | ✅ | 🟡 | 🟡 | |
| 12 | cost saved estimate | ✅ | 🟡 | ❌ | ❌ | mobile surfaces saved-vs-Claude; others partial |
| 13 | quota remaining | ✅ | ✅ | ✅ | ✅ | `QuotaBar` / `status` |
| 14 | route-options actions | ✅ | ✅ | ✅ | ❌ | `RouteOptionsPanel` on web+desktop; not in CLI |
| 15 | Deep Research | ✅ | ✅ | ✅ | ❌ | desktop `/research` (stages, sources, export); CLI still missing |
| 16 | history | ✅ | ✅ | 🟡 | ✅ | web threads/sidebar; desktop weak; CLI `history` |
| 17 | projects / workspaces | ✅ | ❌ | ✅ | ❌ | desktop store+screen, instructions→system msg; web still missing |
| 18 | Private Mode | ✅ | ✅ | ✅ | 🟡 | desktop toggle → settings.blockTrainingProviders → gateway block_training |
| 19 | provider key management | ✅ | ✅ | ✅ | ✅ | web `LocalKeyManager`, desktop `ProvidersScreen`, CLI `keys` |
| 20 | provider key test | ✅ | 🟡 | 🟡 | ❌ | mobile has explicit Test; CLI has no `keys test` |
| 21 | local runtime display | ✅ | 🟡 | ✅ | 🟡 | desktop `ProviderRail`; web partial |
| 22 | one-tap local runtime | ✅ | ❌ | ❌ | 🚫 | CLI = `--provider ollama` |
| 23 | file input | ✅ | ✅ | ❌ | 🟡 | web text+image picker (drag/paste); desktop none |
| 24 | image input | ❌ | ⚠️ | ❌ | 🚫 | **web UI sends base64 `images`, gateway DROPS them — no multimodal path. Silent no-op; fix or hide.** |
| 25 | voice input | 🟡 | ❌ | ❌ | 🚫 | mobile = unavailable fallback only |
| 26 | consent gate (pre-send) | ✅ | ✅ | ✅ | ❌ | mobile + desktop + web gate the first provider send; CLI n/a |
| 27 | report AI response | ✅ | 🟡 | ✅ | ❌ | mobile + desktop have the Gen-AI flag control; verify web |
| 28 | account / session / cloud remote | ✅ | ✅ | 🟡 | ✅ | web login/session; CLI `cloud`+`remote` |
| 29 | export / share | ✅ | ✅ | 🟡 | ❌ | web works; desktop uses Blob+`a.download` — **unverified in the Tauri webview** (may need an fs/dialog plugin), test on a packaged build; CLI none |

## Cross-surface issues to resolve (ranked)

1. **⚠️ Web image input is a silent no-op (#24).** `apps/web/app/(app)/chat/page.tsx`
   reads images and `chat-client.ts` sends `images:[{data,mimeType,name}]`, but the
   gateway has **no image request path** — `content` is `z.string()`
   (`packages/schemas/src/index.ts`) so the field is stripped; the model never sees
   the image. Confirmed by grep across gateway/engine/providers/types. **Action:**
   either hide web image attach until the multimodal backend exists
   (`docs/multimodal-image-plan.md`), or build that backend. Do **not** leave a
   silent broken feature — it violates the "no silent unsupported features" rule.
2. **Desktop parity — largely closed on this branch.** Added markdown+code-copy,
   regenerate, export, consent gate, Private Mode, Deep Research, report,
   projects, real multi-res app icons (were stubs), and Cmd+N/Cmd+,/Cmd+Shift+F
   shortcuts (all typecheck + `next build` green). Remaining desktop 🟡/gaps:
   full footer/route-reason+meta (#9, compression badge only), history
   search/rename UI (#16 — sidebar already lists recent threads), a routing-
   strategy chip (#6), onboarding, the Tauri **native menu** items (About/
   Preferences/New Research/etc., need the Rust menu in lib.rs — [HUMAN]/native),
   and file input (#23). Windows `bundle.windows.signCommand` missing + signing/
   notarization are [HUMAN] (see docs/RELEASE-CHECKLIST.md).
3. **Projects (#17) and consent gate (#26) exist only on mobile.** Port to
   web + desktop (consent is also a store-compliance item).
4. **CLI lacks `research`, `projects`, `keys test`, `--json` everywhere (#15,17,20).**

## Brutal audit fixes (desktop, post-review)

A read-only audit (no P0; security clean — no key/prompt/token in logs or to relay)
caught four runtime bugs that typecheck+build were blind to; all fixed:
- **Projects "New chat" now actually starts a fresh thread + applies provider/
  private defaults** — previously it only set the active id, so instructions
  silently never injected in a busy thread and the defaults were dead data.
- **Report now persists** the flag to localStorage (was an alert that stored
  nothing) — #27 ✅ is now honest.
- **Consent gate now also covers Deep Research** (was chat-only; a first research
  query could ship ungated).
- **Markdown is memoized** (was re-parsing the full cumulative string per token).

Known, documented (not silent): Private Mode is **best-effort** — the router
(`factory.ts:467`) keeps a training provider rather than fail when blocking would
strand the request; the "may reduce availability" copy hints at this, but there's
no per-response "not honored" badge yet. Export's Tauri runtime is unverified
(#29 🟡). The 3 s AppShell health poll and bundle-baked `NEXT_PUBLIC_GATEWAY_TOKEN`
are pre-existing.

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
