# 04 — Cross-Platform Consistency + Honesty + [HUMAN] Launch-Gate Ledger

Agent 4 verdict. Branch `feat/zintus-10-10` (HEAD). Read-only, **verified in
code** — the prior audit docs (`04-consistency-honesty.md`, `FINAL-SCORECARD.md`,
`FEATURE-MATRIX.md`, `RELEASE-HARDENING.md`) are PARTIALLY STALE and were treated
as claims, not truth. Where code disagrees with a doc, the code wins and the
drift is named.

Benchmark rule (ROADMAP §4): web + iOS + Android must feel like **one Zintus**
(same surfaced truths: provider, route-reason, tokens, quota, privacy, cost,
tools, MCP, files/images, catalog). Desktop may use its own native idiom. CLI
surfaces the same truths in text. Core free; no key custody; managed keys gated.

---

## A. Per-surface truth matrix — VERIFIED against current code

Legend: ✅ wired+rendered · 🟡 partial/divergent · ❌ absent · 🚫 N/A · `idiom`
= desktop's allowed native variant.

| Surfaced truth | Web | Desktop | iOS/Android | CLI | Evidence |
|---|:--:|:--:|:--:|:--:|---|
| provider / savings / quota / privacy footer | ✅ | ✅ | ✅ | 🟡 | moat-footer floor uniform; CLI text-partial |
| **route-reason** | ✅ | ✅ | ✅ | ✅ | web/desktop `MessageBubble.tsx`+`gateway.ts`; mobile `lib/messages.ts:136`+`app/index.tsx`; CLI `chat-content.ts` |
| tokens (per-response) | ✅ | ✅ | ✅ | ✅ | uniform |
| **tools** (built-in loop) | ✅ | ✅ | ✅ | ✅ | web/desktop `web-tools`, mobile `lib/builtin-tools.ts`, CLI `builtin-tools.ts`+`agent-tools.ts` |
| **MCP** (connected tools) | ✅ | ✅ | ✅ | ✅ | web/desktop `/settings/mcp`+`activeMcpForChat`, mobile `app/mcp.tsx`+`lib/chat.ts:160`, CLI `agent-mcp.ts`; gateway `handler.ts:872 gatherMcpTools` |
| **structured output** (model JSON request) | ✅ | ✅ | ✅ | ❌ | web `chat/page.tsx`, desktop `ChatPanel.tsx`, mobile `app/index.tsx:224 jsonMode→responseFormat`; **CLI has no `response_format` request** (`--json` is *output* formatting only) |
| **image input** | ✅ | ✅ | ❌ | ✅ | web/desktop `lib/image-attachments.ts`, CLI `chat.ts:307 loadImages`; **mobile = none** (no picker/camera/attach) |
| **voice / dictation** | ✅ | ❌`idiom` | ❌ | 🚫 | web `lib/use-speech-recognition.ts`; desktop none (idiom-allowed); **mobile none** (no expo-speech/av) |
| **artifacts / canvas** | ✅ | ✅ | ❌ | ❌ | web/desktop `_components/ArtifactPanel.tsx`+`lib/artifacts.ts`(+tests); **mobile none**, CLI none |
| **catalog / models browse** | ✅ | 🟡`idiom` | ✅ | 🟡 | web `(app)/models/*`, mobile `app/catalog.tsx`+`lib/catalog-filter.ts`; desktop onboarding-only; CLI `config` text |

**This is a dramatic correction to the original `04-consistency-honesty.md`
(which scored 5/10).** On the current branch: route-reason, tools, MCP, and
structured output now genuinely span web+desktop+mobile (MCP everywhere is NEW;
mobile catalog and artifacts are NEW), and desktop's keyring write path is FIXED
(`apps/desktop/lib/tauri.ts:38,52` now invoke the Rust `keyring_get/set/delete`,
not the dead `tauri-plugin-keyring-api`). The old audit's two worst divergences
(route-reason web-only; mobile lacking tools) are RESOLVED.

---

## B. Consistency score: **8 / 10**

**The win (real "one Zintus"):** the floor (provider/savings/quota/privacy) AND
the ceiling (route-reason, tools, MCP, structured output) now span web + desktop
+ iOS/Android + CLI. MCP — the newest cross-surface feature — is wired into chat
*requests* on all four surfaces (gateway server-side loop for web/desktop/mobile,
client-side dispatch for CLI), not just settings UI. This is a category-leading
level of cross-surface parity.

**Why not 10 — the residual web↔mobile breaks (the trio the rule says MUST match):**

1. **Mobile lacks image input.** Web/desktop/CLI ship EXIF-stripped image blocks
   to vision models; iOS/Android have **no** picker/camera path. The named
   "files/images" truth does not reach mobile. **[worst residual divergence]**
2. **Mobile lacks voice/dictation.** Web has `use-speech-recognition`; mobile has
   nothing. (Desktop's absence is idiom-permitted; mobile's is a parity break.)
3. **Mobile lacks artifacts/canvas.** Web+desktop render an `ArtifactPanel`;
   mobile has none.
4. **CLI lacks a structured-output request.** Structured output spans
   web/desktop/mobile but CLI never sends `response_format` — it "surfaces the
   same truths in text" *except* this one. (`RELEASE-HARDENING.md §6`'s claim that
   structured output is "live on CLI" is doc drift — only the gateway API accepts
   it; the CLI chat command does not request it.)
5. **Catalog browse is web+mobile only.** Desktop (idiom-allowed) and CLI (text)
   have no rich catalog surface — acceptable under the rule but not uniform.

Net: parity at both floor and most of the ceiling → a strong **8**. The literal
10 bar requires iOS/Android to fully mirror web; image+voice+artifacts are the
three web truths still missing on mobile, all **device-gated** (native modules).

---

## C. Honesty score: **9 / 10**

Honesty discipline is excellent. Both prior MUST-FIX items LANDED and verified:

- **Pricing referral payout** — `apps/web/app/pricing/page.tsx:459` now reads
  *"Payouts are coming soon … disbursement (monthly via Stripe) goes live with
  paid plans."* The fabricated "Paid out monthly via Stripe" assertion is gone.
  `REFERRAL_PAYOUTS_LIVE = false` (`apps/web/lib/billing.ts:34`), test-asserted.
- **Hero install** — `Hero.tsx:9 INSTALL_CMD = "bun install -g zintus"`, terminal
  shows `zintus@0.2.0` (`:99`). Node-unsafe `npm` claim and `2.0.0` are fixed.
- **Quota fabrication clean** — no live `1_000_000` denominator in CLI/mobile/
  desktop source (only number-formatters + a comment documenting the removal,
  `cli/src/lib/router.ts:13`).
- **Gating correct** — managed-key checkout disabled "Checkout coming soon"
  (`pricing/page.tsx:322`); `MANAGED_KEYS_AVAILABLE`/`REFERRAL_PAYOUTS_LIVE` both
  false; no key custody anywhere.
- **Privacy page honestly labelled DRAFT** (`apps/web/app/privacy/page.tsx:24,257`).
- **FEATURE-MATRIX under-claims** (the honest direction): it still lists desktop
  tools/JSON/image as ❌ and desktop keyring as ⚠️-broken — all now SHIPPED/FIXED
  on this branch. No over-claim found in the matrix.

**Why not 10 — three unresolved nits (all minor, none fabricate a core truth):**

1. **47 unwired "Add your key" catalog rows.** `apps/web/data/providers.ts` =
   ~60 providers, **13 `integrated` + 47 `add-key`**, but the engine wires only
   **12** (`packages/providers/src/factory.ts:18-29`: cerebras, groq, gemini,
   openrouter, cohere, mistral, deepseek, fireworks, xai, huggingface, lmstudio,
   ollama). The 47 "Add your key" badges (Anthropic, OpenAI, Together, Bedrock,
   Azure, Perplexity…) imply a direct BYOK route that does not exist (reachable
   only via OpenRouter, if at all). The hedge *"13 integrated today, the rest via
   [your key]"* (`catalog/page.tsx:164`) softens but does not resolve it. Carryover
   WATCH from the prior audit — still open.
2. **Hero managed-keys teaser un-marked.** `Hero.tsx:80` "Managed keys from
   $15/mo →" presents a coming-soon, custody-gated tier as an available price
   with no "coming soon" marker on the Hero itself (the linked pricing page does
   gate it). Minor.
3. **Doc drift** — `FEATURE-MATRIX.md` and `RELEASE-HARDENING.md` predate this
   branch (desktop tools/JSON/image/keyring, MCP-everywhere, mobile catalog,
   artifacts) and are now materially inaccurate. Drift is in the under-claim
   direction (honest), but stale "authoritative" docs are themselves a hygiene
   risk and the CLI-structured-output claim (§6) is an over-claim.

---

## D. [HUMAN] / DEVICE / LEGAL LAUNCH-GATE LEDGER (the deliverable)

These BLOCK a confident public GA and **cannot be settled in code or CI**. Each
is tagged by owner type. Cross-checked against current code; drift from
`RELEASE-HARDENING.md` / `STORE-READINESS.md` is noted.

### CSP / browser
- **[HUMAN-device]** Browser-verify the production CSP: `next build && next start`
  (prod `NODE_ENV`), load chat/compare/research/terminal in real Chrome/Firefox/
  Safari → **zero CSP violations**; confirm `'unsafe-eval'` ABSENT from the prod
  header; confirm the PDF-extract + voice-dictation paths run clean under the
  ENFORCING (not Report-Only) header. (RELEASE-HARDENING §1 — code-verified only.)

### Desktop signing / notarization / device
- **[HUMAN]** macOS: Apple Developer Program + Developer ID Application cert; sign
  (Hardened Runtime) + notarize (`notarytool`) + staple; `spctl --assess` +
  `stapler validate` pass.
- **[HUMAN-device]** macOS clean-Mac install from a browser download, **no
  Gatekeeper warning**.
- **[HUMAN]** Windows: add `bundle.windows.signCommand` to `tauri.conf.json` (env
  vars alone do NOT sign) + Authenticode cert; `signtool verify /pa` = Valid.
  (STORE-READINESS marks Windows 🔴 — *cannot sign yet*.)
- **[HUMAN-device]** Windows clean-VM install/uninstall; Credential-Manager
  keyring; high-DPI icons; SmartScreen first-run behavior.
- **[HUMAN-device]** Linux clean-device: Ubuntu LTS + Fedora + one Arch/AppImage;
  `.deb`/`.rpm` install+remove; Secret Service keyring + PTY + Wayland/X11;
  WebKitGTK 4.1 runtime dep documented.
- **[HUMAN]** Real 1024²-sourced icon set (current icons placeholder-grade).
- **[HUMAN]** Keep the Tauri updater OFF until a real signing keypair +
  `plugins.updater` block exist (compiled-in but inert today).
- **[HUMAN-device]** Desktop export/share (`Blob`+`a.download`) unverified in the
  Tauri webview — test on a packaged build.
- **[HUMAN-device]** Desktop key→gateway sync: keyring WRITE path is now fixed in
  code, but the service-name mismatch (`com.zintus.desktop` vs gateway `zintus`)
  means keys set in the desktop UI may not reach the gateway — verify on a
  packaged build.

### Mobile EAS / device builds + native modules
- **[HUMAN]** EAS `projectId` + store credentials; build via EAS.
- **[HUMAN-device]** On-device iOS + Android build run: confirm streaming, tools,
  MCP, structured output, and route-reason render on real hardware.
- **[HUMAN-device]** Mobile **image-input** native module — UNBUILT; required for
  web parity (Consistency gap C-1).
- **[HUMAN-device]** Mobile **voice/dictation** native module — UNBUILT; required
  for web parity (Consistency gap C-2).
- **[HUMAN]** App Privacy (Apple) + Data safety (Google) forms with the BYOK +
  third-party-AI-provider disclosure.

### Legal
- **[HUMAN]** Privacy policy LIVE + counsel-finalized at `/privacy` (currently
  DRAFT in code).
- **[HUMAN]** Account-deletion page live in prod (`app/account/delete` is BUILT —
  `DeleteAccountWidget.tsx` + tests — needs deploy).
- **[HUMAN]** Counsel sign-off on the **x25519 encryption-export** determination
  before relying on `ITSAppUsesNonExemptEncryption = false` (STORE-READINESS §1.4
  — a legal determination, not auto-exempt).
- **[HUMAN]** Third-party-AI **consent disclosure** final product/legal sign-off
  (in-app copy + AI-content report control exist; destination/retention policy
  needs sign-off).

### App-store submission
- **[HUMAN]** Demo gateway + demo account stood up and kept LIVE for the entire
  review window (a BYOK app with no reachable gateway is the #1 rejection risk).
- **[HUMAN]** iOS App Store + Google Play submission and review; desktop
  direct-download `/download` copy honest as **"beta — unsigned"** until signing
  lands.

### Billing / payouts
- **[HUMAN]** Live managed-key Stripe checkout wiring (gated
  `MANAGED_KEYS_AVAILABLE = false`, "coming soon" today — correct).
- **[HUMAN]** Referral-payout disbursement path (gated `REFERRAL_PAYOUTS_LIVE =
  false`, "coming soon" today — correct).

### Live keyed verification (codeable feature, [HUMAN] run to confirm)
- **[HUMAN]** Keyed end-to-end multimodal image smoke (browser canvas → Gemini) —
  code/tests/build green; the live run is the gate (`docs/multimodal-image-input.md`).
- **[HUMAN]** Keyed live run to confirm agent/research depth scores (scorecard
  addendum lists these as pending a live LLM/web run).

> **These [HUMAN]/[HUMAN-device] gates are REAL launch blockers.** No amount of
> code lands a Developer ID cert, a notarization staple, a clean-device Gatekeeper
> pass, an EAS device build, a live privacy-policy URL, counsel's export sign-off,
> or a Stripe disbursement. A literal 10/10 *shipped* product cannot be declared
> until they clear — they are simply not codeable.

---

## E. Bottom line

**Consistency 8/10 · Honesty 9/10.** Cross-surface parity is now genuinely
"one Zintus" at floor AND ceiling — route-reason, tools, MCP, and structured
output span web+desktop+mobile+CLI, a major correction to the stale 5/10 audit.
The residual breaks are the three web truths still off iOS/Android (image, voice,
artifacts) plus CLI structured-output — image/voice are device-gated. Honesty
discipline is near-exemplary: both old MUST-FIX items landed, gating is correct,
fabrication is clean, and the only open items are minor (47 unwired catalog
badges, an un-marked Hero teaser, stale docs). **Neither axis is a 10**, and even
if every codeable gap closed, the product cannot be a *shipped* 10/10 until the
[HUMAN]/device/legal ledger in §D clears — those gates are real and outside code.
