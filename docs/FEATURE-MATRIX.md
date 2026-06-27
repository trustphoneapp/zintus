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
>
> **Audit 2026-06-26:** a re-audit confirmed the rich mobile features (markdown,
> projects, research, consent gate, history, file/voice, report) are **ABSENT on
> `feat/cross-surface-parity`** and exist only on `feat/mobile-serious-app`
> (+4497 lines / 18 files). Every Mobile ✅ below is *that branch*, not this one;
> the on-branch app is a basic single-screen text chat. See "Audit corrections"
> below.

| # | Feature | Mobile | Web | Desktop | CLI | Notes / source |
|---|---------|:---:|:---:|:---:|:---:|----------------|
| 1 | chat | ✅ | ✅ | ✅ | ✅ | all 4 stream via the gateway |
| 2 | streaming | ✅ | ✅ | ✅ | ✅ | SSE `/v1/chat/completions` |
| 3 | stop generation | ✅ | ✅ | ✅ | 🟡 | web Esc/stop; desktop ChatPanel; CLI = Ctrl-C |
| 4 | provider override | ✅ | ✅ | ✅ | ✅ | web `ProviderPicker`, desktop `ProviderRail` |
| 5 | auto routing | ✅ | ✅ | ✅ | ✅ | omit provider → gateway strategy |
| 6 | routing strategy | ✅ | ✅ | ✅ | ✅ | all 4; desktop now has a Fastest/Capability/Cheapest select in the composer |
| 7 | markdown rendering | ✅ | ✅ | ✅ | 🟡 | all UIs use the dep-free `Markdown.tsx` (web ported it 2026-06-26 — headings/lists/tables/inline + fenced code); CLI = terminal |
| 8 | code block copy | ✅ | ✅ | ✅ | 🚫 | web + desktop fenced blocks have a per-block Copy (`Markdown.tsx` CodeBlock); CLI = terminal |
| 9 | response intelligence footer | ✅ | ✅ | ✅ | 🟡 | desktop now parses the `metadata` SSE frame (latency/saved-vs-Claude/out-tokens/strategy) + compression badge; route-options live in a side panel. CLI partial |
| 10 | compression % | ✅ | ✅ | ✅ | 🟡 | `X-Zintus-*` headers everywhere |
| 11 | tokens saved | ✅ | ✅ | 🟡 | 🟡 | |
| 12 | cost saved estimate | ✅ | 🟡 | ❌ | ❌ | mobile surfaces saved-vs-Claude; others partial |
| 13 | quota remaining | ✅ | ✅ | ✅ | ✅ | `QuotaBar` / `status` |
| 14 | route-options actions | ✅ | ✅ | ✅ | ❌ | `RouteOptionsPanel` on web+desktop; not in CLI |
| 15 | Deep Research | ✅ | ✅ | ✅ | 🟡 | CLI `zintus research <q>` rebuilds the engine deps in-process (`--depth`,`--json`); a brutal audit confirmed the deps are line-by-line faithful to the gateway (+ bundle), but it's **never been executed** (key-gated) — 🟡 until one keyed run. No idle watchdog yet (stalled upstream → Ctrl-C) |
| 16 | history | ✅ | ✅ | 🟡 | ✅ | web threads/sidebar; desktop weak; CLI `history` |
| 17 | projects / workspaces | ✅ | ✅ | ✅ | ✅ | all 4; CLI `projects list/create/use/clear/delete` (CRUD live-verified) + `chat` injects the active project's instructions + default provider |
| 18 | Private Mode | ✅ | ✅ | ✅ | 🟡 | desktop toggle → settings.blockTrainingProviders → gateway block_training |
| 19 | provider key management | ✅ | ✅ | ⚠️ | ✅ | web `LocalKeyManager`, CLI `keys` work; **desktop `ProvidersScreen` is broken** — frontend (`lib/tauri.ts`) calls the uninitialized `tauri-plugin-keyring-api` plugin instead of the shipped Rust `keyring_*` cmds (`lib.rs:11-34`), so "Save key" fails; also no key→gateway sync (gateway reads service `zintus`, desktop writes `com.zintus.desktop`). See Audit corrections. |
| 20 | provider key test | ✅ | 🟡 | 🟡 | ✅ | mobile explicit Test; CLI now has `zintus keys test <provider>`; web/desktop validate-on-save only |
| 21 | local runtime display | ✅ | 🟡 | ✅ | 🟡 | desktop `ProviderRail`; web partial |
| 22 | one-tap local runtime | ✅ | ❌ | ❌ | 🚫 | CLI = `--provider ollama` |
| 23 | file input | ✅ | ✅ | ✅ | 🟡 | mobile+web+desktop on-device text extraction (images refused honestly — no multimodal path); CLI partial |
| 24 | image input | ❌ | 🟡 | ❌ | 🟡 | **shipped** (`feat/multimodal-image-input`): web picker/drag-drop/paste + CLI `--image` send real **EXIF-stripped** image blocks to a **vision-capable** model (Gemini). Router hard-errors (`unsupported_capability` + provider suggestions) when none is available — **never** a silent text-only fallback or `[Image:]` fake. Image bytes never touch the relay and are never logged. **🟡 = code + tests + web build green, but the keyed end-to-end run (browser canvas → Gemini) is the [HUMAN] smoke gate** (§ final gate). Mobile/desktop image UI deferred. See `docs/multimodal-image-input.md` |
| 25 | voice input | 🟡 | ❌ | ❌ | 🚫 | mobile = unavailable fallback only |
| 26 | consent gate (pre-send) | ✅ | ✅ | ✅ | ❌ | mobile + desktop + web gate the first provider send; CLI n/a |
| 27 | report AI response | ✅ | ❌ | ✅ | ❌ | desktop has the Gen-AI flag control; **web has none** (no report UI in `MessageBubble.tsx`); CLI n/a |
| 28 | account / session / cloud remote | ✅ | ✅ | 🟡 | ✅ | web login/session; CLI `cloud`+`remote` |
| 29 | export / share | ✅ | ✅ | 🟡 | ❌ | web works; desktop uses Blob+`a.download` — **unverified in the Tauri webview** (may need an fs/dialog plugin), test on a packaged build; CLI none |

## ⚠️ Audit corrections (2026-06-26 war-room re-audit + human cross-check)

Several rows above were stale/optimistic. Corrected inline; recorded here with cites:

- **Web markdown (#7) is not real, and web code-copy (#8) is absent.**
  `apps/web/app/_components/MessageBubble.tsx:11-34` strips ```` ``` ```` fences and
  renders only `- ` bullets (no headers/bold/tables/inline-code); the only
  whole-message copy is at line 52. Web never got the `Markdown.tsx` desktop/mobile
  use. (#7 web ✅→⚠️, #8 web 🟡→❌.) **RESOLVED 2026-06-26** — web now ports
  `Markdown.tsx` (real markdown + per-code-block copy); both rows back to ✅.
- **Desktop provider-key management (#19) is broken — but the keyring *backend*
  exists.** `apps/desktop/lib/tauri.ts:13,28,36` imports `tauri-plugin-keyring-api`
  (→ `plugin:keyring|*`), but that plugin is **not initialized** — `src-tauri/src/lib.rs:58-60`
  registers only pty+updater. The app *does* ship working Rust keyring commands
  (`lib.rs:11-34` `keyring_get/set/delete`, wired into the invoke handler), so the fix
  is to **repoint the frontend to `invoke("keyring_*")`** — *not* "no keyring backend."
  Separately there is **no key→gateway sync**: desktop uses service `com.zintus.desktop`
  while the gateway reads `zintus` (`packages/keychain/src/storage.ts:6`), so desktop
  keys aren't visible to the chat path even once stored. (#19 desktop ✅→⚠️.)
- **Web report-AI (#27) is absent**, not partial — no report control in
  `MessageBubble.tsx`. (#27 web 🟡→❌.)
- **Desktop icons:** the prior "real multi-res icons" wording (here) and the
  "299 B/321 B stubs" note (`RELEASE-CHECKLIST.md §1`) were *both* stale. Current truth:
  icons were regenerated to **multi-resolution** (`icon.ico` = 6 sizes incl. 16/32 px,
  ~2 KB; `icon.icns` ~12.6 KB) — no longer single-size stubs — but still **small /
  low-fidelity placeholders**, not a release-quality 1024²-sourced set. [HUMAN] art
  still required.
- **Desktop shortcuts/menu:** ⌘N/⌘,/⌘⇧F exist as **frontend keydown handlers**
  (`apps/desktop/src/AppShell.tsx:64-83`), but there is **no native Tauri menu** and
  ⌘⇧F "Find" is a stub that just navigates to `/chat` (no search). `RELEASE-CHECKLIST.md`'s
  "not present" is wrong; "present as JS, no native menu, Find is fake" is right.
- **`docs/multimodal-image-plan.md`** (referenced in row #24 + the issues list below)
  is **absent on this branch**; it exists on `feat/mobile-serious-app`. Branch drift,
  not a missing-forever plan.
- **Project `strategy`:** the apply-path works *if* a strategy is set, but the **web
  project form exposes no strategy control** (`apps/web/app/projects/page.tsx`), so
  web-created projects are always `strategy: null`. The "made strategy actually applied"
  note (web fixes, below) was overstated for web.
- **Private Mode** is best-effort and **not fully honest**: `"unknown"`-training
  providers aren't filtered (`packages/providers/src/data-policies.ts:131`) and there's
  no per-response "not honored" signal — tracked as a P0 honesty fix (separate PR).
- **Whole Mobile column = `feat/mobile-serious-app`, not this branch** (see caveat at
  top): the rich features are confirmed **absent** here; the on-branch app is a basic
  single-screen text chat.

Verified green at audit time: `bun run typecheck` exit 0; full `bun run test` exit 0
(**0 failures**; exact test count not asserted here — capture from CI). Capability gaps
confirmed absent stack-wide: **tool/function calling, multimodal image input,
structured/JSON output.**

## Cross-surface issues to resolve (ranked)

1. **✅ FIXED, then ✅ SHIPPED — web image input.** The cardinal sin was a fake
   "[Image: …]" note + base64 the gateway stripped (model told an image was
   attached, got none). First fixed to honest text-only refusal; **now real
   multimodal is shipped** (`feat/multimodal-image-input`, PR1–7): web + CLI send
   EXIF-stripped image blocks to a vision-capable model, hard-erroring instead of
   any silent text-only fallback. 🟡 pending the keyed end-to-end smoke. See
   `docs/multimodal-image-input.md`.
2. **Desktop parity — essentially closed on this branch.** Shipped markdown+
   code-copy, regenerate, export, consent gate, Private Mode, Deep Research,
   report, projects, **file input (#23)**, **response footer (#9)**, **first-run
   onboarding overlay**, multi-res app icons (regenerated from single-size stubs but
   still placeholder-grade — see Audit corrections), and Cmd+N/Cmd+,/
   Cmd+Shift+F shortcuts (all typecheck + `next build` green). Remaining desktop:
   history search/rename UI (#16 — sidebar already lists recent threads), a
   routing-strategy chip (#6), and the Tauri **native menu** items (About/
   Preferences/New Research/…, need the Rust menu in lib.rs — [HUMAN]/native).
   Windows `bundle.windows.signCommand` missing + signing/notarization are
   [HUMAN] (see docs/RELEASE-CHECKLIST.md).
3. **(Resolved) Projects (#17) + consent gate (#26) now on mobile + desktop + web.**
   CLI projects (#17) remains.
4. **CLI: `research` (#15) + `projects` (#17) + `keys test` (#20) done; `--json`
   on `research` + `keys list`.** A broader `--json` across status/doctor (ink
   TUIs) is the only CLI item left.

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

## Brutal audit fixes (CLI, post-review)

A CLI audit (line-by-line deps diff + a real bundle, not just typecheck) confirmed
`research`'s in-process deps are faithful to the gateway and `keys list --json`
leaks no raw key — but caught a P1 + P2, both fixed:
- **P1 — project instructions were silently dropped on the default chat path.**
  `chat` injected them as a system message, but the git-diff context (on by
  default) compiles a thread → the engine rebuilds messages + only re-reads the
  last user message, dropping the system message. Now folded into the user turn
  (survives both paths).
- **P2 — a keyless pinned provider killed failover** (forced route → every chat
  fails). `chat` now only pins the project's provider when it's keyed (or local),
  else falls back to auto with a warning.
- Honesty: CLI `research` (#15) downgraded ✅→🟡 — faithful but never run.
- Known: research has no idle-watchdog/abort yet (gateway does) — a stalled
  upstream hangs until Ctrl-C.

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
