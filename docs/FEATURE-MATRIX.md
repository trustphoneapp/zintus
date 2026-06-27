# Zintus Cross-Surface Feature Matrix

The single shared product contract. Every surface declares each capability so no
surface **silently claims an unsupported feature**. Verified against code on
`feat/cross-surface-parity` (off `main`), 2026-06-26.

Legend: ✅ done · 🟡 partial · ❌ missing · 🚫 intentionally unsupported ·
⚠️ **present but broken/misleading** (must fix or remove).

> Mobile reflects the unmerged `feat/mobile-serious-app` branch and is
> **UNVERIFIABLE from this branch** — its cited `apps/mobile/BUILD-STATUS.md` lives
> on that branch, not here. Treat the mobile column as *claimed, not certified*
> until that branch is checked out or merged.

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
| 9 | response intelligence footer | ✅ | ✅ | ✅ | 🟡 | desktop now parses the `metadata` SSE frame (latency/saved-vs-Claude/out-tokens/strategy) + compression badge; route-options live in a side panel. CLI partial |
| 10 | compression % | ✅ | ✅ | ✅ | 🟡 | `X-Zintus-*` headers everywhere |
| 11 | tokens saved | ✅ | ✅ | 🟡 | 🟡 | |
| 12 | cost saved estimate | ✅ | 🟡 | ❌ | ❌ | mobile surfaces saved-vs-Claude; others partial |
| 13 | quota remaining | ✅ | ✅ | ✅ | ✅ | `QuotaBar` / `status` |
| 14 | route-options actions | ✅ | ✅ | ✅ | ❌ | `RouteOptionsPanel` on web+desktop; not in CLI |
| 15 | Deep Research | ✅ | ✅ | ✅ | ❌ | desktop `/research` (stages, sources, export); CLI still missing |
| 16 | history | ✅ | ✅ | 🟡 | ✅ | web threads/sidebar; desktop weak; CLI `history` |
| 17 | projects / workspaces | ✅ | ✅ | ✅ | ❌ | mobile+desktop+web (store+screen, instructions→leading system msg, defaults applied); CLI missing |
| 18 | Private Mode | ✅ | ✅ | ✅ | 🟡 | desktop toggle → settings.blockTrainingProviders → gateway block_training |
| 19 | provider key management | ✅ | ✅ | ✅ | ✅ | web `LocalKeyManager`, desktop `ProvidersScreen`, CLI `keys` |
| 20 | provider key test | ✅ | 🟡 | 🟡 | ✅ | mobile explicit Test; CLI now has `zintus keys test <provider>`; web/desktop validate-on-save only |
| 21 | local runtime display | ✅ | 🟡 | ✅ | 🟡 | desktop `ProviderRail`; web partial |
| 22 | one-tap local runtime | ✅ | ❌ | ❌ | 🚫 | CLI = `--provider ollama` |
| 23 | file input | ✅ | ✅ | ✅ | 🟡 | mobile+web+desktop on-device text extraction (images refused honestly — no multimodal path); CLI partial |
| 24 | image input | ❌ | 🚫 | ❌ | 🚫 | web image attach **removed** (was a silent no-op that injected a fake "[Image: …]" note); now text-only + an honest "images unsupported" notice. Multimodal = `docs/multimodal-image-plan.md` |
| 25 | voice input | 🟡 | ❌ | ❌ | 🚫 | mobile = unavailable fallback only |
| 26 | consent gate (pre-send) | ✅ | ✅ | ✅ | ❌ | mobile + desktop + web gate the first provider send; CLI n/a |
| 27 | report AI response | ✅ | 🟡 | ✅ | ❌ | mobile + desktop have the Gen-AI flag control; verify web |
| 28 | account / session / cloud remote | ✅ | ✅ | 🟡 | ✅ | web login/session; CLI `cloud`+`remote` |
| 29 | export / share | ✅ | ✅ | 🟡 | ❌ | web works; desktop uses Blob+`a.download` — **unverified in the Tauri webview** (may need an fs/dialog plugin), test on a packaged build; CLI none |

## Cross-surface issues to resolve (ranked)

1. **✅ FIXED — web image no-op.** Was the cardinal sin: the UI injected a fake
   "[Image: … see attached]" note AND sent base64 the gateway strips, so the model
   was told an image was attached and got none. Now web attach is **text-only**
   (images refused with an honest notice); no fake notes. Full multimodal stays a
   separate PR (`docs/multimodal-image-plan.md`).
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
3. **(Resolved) Projects (#17) + consent gate (#26) now on mobile + desktop + web.**
   CLI projects (#17) remains.
4. **CLI lacks `research`, `projects`, and a broad `--json` mode (#15,17).**
   (`keys test` / #20 is now done.)

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

## Brutal audit fixes (web, post-review)

A web audit confirmed projects-injection genuinely fires (not the desktop reset
bug) and the image refusal is honest end-to-end, but caught two P1s — both fixed:
- **Consent gate now covers every send surface.** It previously guarded only the
  chat composer; `/compare`, `/research`, and `/terminal` sent to providers
  ungated. Extracted a shared `ConsentDialog` and gated all four (5.1.2(i)).
- **Active project is no longer sticky+invisible.** It used to clear only on
  deleting the project, silently injecting its instructions into every later
  first-send with no indicator. Added a 📁 project chip on the chat page with a ×
  off-switch. Also made the project `strategy` field actually applied + corrected
  the lib comment (was a dead field / false claim).

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

### Whole-platform readiness audit (independent, brutal)
- **All three hard rules HOLD, server-enforced.** Paid tiers hit a relay 503
  `managed_keys_unavailable` BEFORE any Stripe call (tested); **no payout/credit-
  ledger/transfer code exists** (referral `commission_cents` is tracked but nothing
  moves money, and no referral row can be created while checkout is gated).
  web/desktop/cli POST prompts straight to the gateway; BYOK keys go only to a
  loopback gateway (`isLoopbackGateway` guard) or E2E-encrypted; relay logs are
  redacted. Single execution plane (`@zintus/engine`).
- **Security baseline strong** (redacted logs, OS keychain, web vault AES-GCM +
  PBKDF2-600k, Stripe HMAC + replay window, scoped account deletion).
- **✅ FIXED — open tokenless gateway (was P1; two layers).** A brutal cross-check
  confirmed the CORS change alone closed only the *read* hole — a `no-cors`
  `text/plain` POST could still execute and burn quota. Both layers now in:
  (1) tokenless gateways default to a **`loopback` CORS policy** (`auth.ts`:
  reflects only localhost any-port, the desktop Tauri webview, `*.zintus.ai`) so
  other sites can't READ responses; (2) the route guard (`handler.ts`) **rejects
  (403) any request carrying a disallowed `Origin`** so a cross-site POST can't
  EXECUTE / burn BYOK quota. Token-set keeps `*`; `GATEWAY_CORS_ORIGIN` overrides.
  Verified: new `auth.test.ts` + handler origin-rejection tests + 90+ gateway
  tests. The cross-check also confirmed **no shipped client is broken** (Tauri
  `tauri://localhost`/`http://tauri.localhost`, dev `localhost:3001`, web
  `www.zintus.ai` all covered; CLI sends no Origin). **[HUMAN] smoke:** confirm the
  Tauri webview emits `Origin: tauri://localhost` (not `null`) on a real macOS/
  Windows build, and that HTTPS web→`http://localhost:8788` still works on current
  Chrome (Private-Network-Access) — both pre-existing.
- **P2 remaining (careful follow-up):** web CSP `script-src 'unsafe-inline'`;
  Stripe webhook not itself flag-gated (defense-in-depth); Private Mode passes
  `"unknown"`-training providers; bundle-baked `NEXT_PUBLIC_GATEWAY_TOKEN`.

## How to keep this honest

Update the relevant row in the same PR whenever a surface gains/loses a feature.
A surface may only show ✅ when the feature is wired end-to-end (UI → gateway →
provider), not when the UI merely exists. The web image row (⚠️) is the cautionary
example.
