# Zintus Global-Launch War-Room — Verdict (2026-06-28)

*Branch `feat/multimodal-image-input` @ `6bcd097` (every commit already merged to
`origin/main`). 12 parallel agents — **6 independent re-verifications** of the
2026-06-26 scopes against current code + **6 forward designs** for the unbuilt
capabilities — plus an orchestrator cross-check that re-read the disputed files
rather than trusting any single agent. This is the **post-fix** verdict: it
measures what the session's work actually closed, in code, against the same 10/10
global-launch bar.*

**Ground truth (verified, not doc-trusted):** full `bun run test` exit **0**,
**0 failures**, ~**919 pass** (889 `bun test` + 30 vitest; the runner's batches
sum to the ~924 figure modulo how vitest vs bun batches are counted). The suite
now carries `capabilities.test.ts`, `media/images.test.ts`,
`image-attachments.test.ts`, `tauri.test.ts`, `billing.test.ts`,
`account-delete.test.ts`, and `focus-trap.test.ts` — consistent with the
post-fix state. Per-agent detail: `01-core-runtime.md` … `06-compliance-ops-billing.md`;
forward designs `07-…` … `12-…`.

---

## 1. Verdict: global launch ready? **NO — but materially closer to a credible beta.**

Not a 10/10 multi-surface product. What changed since 2026-06-26 is that **the
codeable P0/P1/P2 batch genuinely landed and survived independent re-verification**
— the remaining gaps are *capability* and *distribution*, not lurking bugs or
dishonest docs.

- **Strong, real, rare — now stronger.** The BYOK/local-first core re-verifies up:
  gateway/relay no-custody is now **proven against code** (~9.5/10, was ~8.5),
  Private-Mode honesty is real and typed, and **multimodal image input is
  genuinely built** (the 06-26 audit called it "vapor") — capability-honest, with
  a hard `unsupported_capability` error and real magic-byte + EXIF/GPS stripping.
- **Still sinks a 10/10 launch:** tool/function calling and structured/JSON
  output are **entirely absent** (the biggest gap vs every competitor); desktop
  and mobile need real device/Rust/EAS builds to certify (code-fixed ≠
  build-certified); legal/signing/stores are `[HUMAN]`; CSP-nonce needs a
  browser-verified reland.

**Honest path:** Web (BYOK) + CLI on the local path are now a credible **beta+**.
Desktop, mobile, stores, and paid/custody stay correctly gated.

## 2. 10/10 definition (unchanged)
Same flow on every surface (UI → local gateway → chosen provider) with no dead
buttons / fake renders / silent degradation; capability-honest routing (real
model→{vision,tools,json,context} registry; hard-error, never silent downgrade);
literal-truth privacy; competitive capabilities (tools+MCP, multimodal, structured
output); trustworthy distribution (signed/notarized desktop, store-submittable
mobile, live legal pages, backed-up + restore-drilled relay); docs true to the line.

## 3. Competitor benchmark (one capability gained)
Zintus still uniquely owns **multi-provider routing/failover**, **BYOK/local-first
no-custody**, and a **provable cost-savings ledger**. It now adds **honest
multimodal image input** (web + CLI) — a capability ChatGPT/Claude/Gemini have but
a Perplexity-style router doesn't pair with BYOK. It still loses on **tool/function
calling, structured output, agentic coding**, and self-contained mobile/desktop
polish.

## 4. Feature matrix (re-verified, this-line-honest)

| | Web | CLI | macOS/Win/Linux | iOS/Android |
|---|---|---|---|---|
| Chat + routing + savings | ✅ | ✅ | ✅ (unsigned) | basic on main / rich on `mobile-serious-app` |
| Multimodal image | ✅ proven | ✅ `--image` | ❌ no UI (actively rejects) | ❌ no UI |
| Tool calling / structured out | ❌ | ❌ | ❌ | ❌ |
| Provider-key entry | ✅ | ✅ | ✅ TS-fixed, Rust-cert pending | ⚠️ cloud-session-bound |
| Legal / signing / store | `[HUMAN]` | npm-pending (Bun-only) | unsigned `[HUMAN]` | `[HUMAN]` + EAS not configured |

## 5. P0 — what's LEFT (most original P0s verified FIXED)

**Verified FIXED this session (with the closing commit, re-checked in code):**
- Private-Mode silent leak — `2bfd0af`: `"unknown"`-training treated as may-train
  (`data-policies.ts:142-144`), router filters under privacy (`factory.ts:512-521`),
  typed `privacyHonored` signal (`route.ts:151-166`), web surfaces it
  (`TransparencyStrip.tsx:62-67`). Tested.
- Desktop key-entry defect — `d0d4e27`: frontend calls `invoke("keyring_*")`; Rust
  commands registered (`lib.rs:18-41,68-73`); **service name matches** (`"zintus"`
  both sides). *Code-correct; see P0-2 below for the residual.*
- Relay backup/restore — exists (`backup-relay.yml` daily + self-restore-drill,
  `DR-RUNBOOK.md`).
- Legal AI-output report control — shipped on web/desktop (`8137fd9`,
  `MessageBubble.tsx:48-59,195`).
- Doc/contract honesty — `FEATURE-MATRIX.md` has no remaining false ✅ in any scope.
- Multimodal capability — genuinely built end-to-end, capability-honest.

**Still open (the real launch-blocking set):**
1. **Tool calling + structured output absent** — the single biggest capability
   gap vs every competitor. Designs landed (`07-…`, `08-…`): the multimodal vision
   spine is the proven template; the registry already carries `tools`/`json` flags
   nothing consumes yet. New multi-PR build (9 PRs tools, 6 PRs structured).
2. **Desktop key entry — code-fixed, not build-certified.** Beyond "needs a Rust
   build," design `10-…` surfaced a **real cross-implementation risk**: desktop
   writes via Rust `keyring = "3"` (`Cargo.toml:17`) while the gateway reads via
   `@napi-rs/keyring ^1.3.0` — different libraries at different majors. Matching
   service/account strings do **not** guarantee byte-compatible credential records
   per-OS. Only a write→`zintus keys list`→chat round-trip on each OS certifies it.
3. **Mobile not shippable.** Corrected divergence: `feat/mobile-serious-app` is
   **80 behind / 7 ahead** of main (not "~47") and the gap grows daily. Streaming
   dies in release builds (`lib/chat.ts` uses RN `fetch` + `response.body.getReader()`,
   no polyfill — fix is `import { fetch } from "expo/fetch"`, already a dep);
   Android cleartext unset; EAS not configured (no `projectId`/submit). Its own track.
4. **Legal DRAFT + undeployed; desktop unsigned (Windows lacks `signCommand` even
   with all `AZURE_*` secrets set)** — `[HUMAN]` + a small config gap.

## 6. P1 — nearly cleared
**FIXED + re-verified:** capability registry exists; real markdown + per-block copy
+ favicon/manifest; gateway LAN-bind refusal (`auth.ts:77-87,202-210`);
account-delete force-disconnect + KV cleanup; `--image` CLI; memory honesty +
fact-extraction; CLI `cloud status/logout`; security headers moved to
`next.config.ts` (portability P2 resolved); image attach button + thumbnail.
**Left:** CLI Bun-only (Node/npm build); desktop native menu / real Find / verified
export; capability/quality routing is only **partially** addressed (relocated into
the registry but still static per-provider brand-rank, not per-model).

## 7. P2 — nearly cleared
**FIXED + re-verified:** Stripe constant-time + event-id dedup
(`billing.ts:125-132,207-211`); client-error redaction; **relay** UUID/JWT redaction
(`d4eb53b`); a11y focus rings + consent focus-trap; failed-request no longer debits
budget; OTel real timing; bundle-token removed; referral honesty; PNA + non-loopback
bind. **Left:** CSP nonce (reverted — see §8.4); desktop updater (inert); tokzen
ratio (owner-scoped-out); and two **newly-found** residuals below.

## 8. Roadmap by PR (designs delivered this run)
1. **Tool/function calling** — `07-design-tool-calling.md`: 9 PRs
   (types→capabilities→providers→router gate→engine→gateway→openapi→web→CLI). The
   one genuine contract break: every layer flattens to `AsyncIterable<string>`, so
   `StreamChunk` must gain a typed `toolCall` event; **the client owns the
   tool-execution loop** (local-first, no sandbox).
2. **Structured/JSON output** — `08-design-structured-output.md`: 6 PRs. Replace the
   `json: boolean` flag (which conflates strict-schema vs json-mode vs emulation)
   with a 3-state `structuredOutput` level; honest UX cost: a buffer→validate→repair
   loop **disables token streaming**; needs Ajv (draft-2020-12) alongside Zod.
3. **Multimodal polish + cross-surface** — `12-design-multimodal-polish.md`:
   make latest-image-focus visible + pin provenance; desktop image UI (low effort —
   Tauri webview has canvas); mobile image UI (hard — RN has no canvas/`node:fs`,
   needs `expo-image-manipulator` + the runtime-agnostic EXIF strip); land an
   `openai-compat` image mapper so a vision model beyond Gemini can be registered.
4. **CSP nonce reland** — `09-design-csp-nonce.md`: root cause was **`next dev
   --webpack` using `eval()` for HMR**, not the wiring — `next build && next start`
   would've been clean. Reland with a dev-only `'unsafe-eval'` carve-out, staged
   Report-Only→enforce, verified in real Chrome against a prod build.
5. **Desktop cert** — `10-design-desktop-cert.md`: per-OS runbook R1–R6, Windows
   `signCommand`, a `desktop-native` PR job (no Rust compiles on PRs today).
6. **Mobile** — `11-design-mobile.md`: rebase (not merge) `mobile-serious-app`;
   `expo/fetch` streaming; Android cleartext; EAS release; 7-PR M0→M6. Note the
   silent blocker: main's `ChatMessage.content: string → string | ContentBlock[]`
   breaks mobile TS with **no git conflict**.

## 9. Tests / builds / device checks
Web suite ✅ 0 failures. **Pending `[HUMAN]`/device:** desktop per-OS Rust build
(keyring round-trip incl. the cross-lib check, native menu, Find, export, PTY,
Tauri-origin/PNA, Gatekeeper/SmartScreen); mobile EAS **release** build (Android
cleartext, on-device streaming via `expo/fetch`, deep-link, iPad); Playwright web
flows + in-browser checks (canvas thumbnail/EXIF badge, focus-ring visibility,
installable manifest, real-Chrome PNA + CSP console); keyed multimodal smoke (owner
did this ✅; the new multi-turn focus test — verify turn-2 sends no image bytes —
is still owner-run).

## 10. Human-only blockers (unchanged)
Counsel (finalize+deploy privacy/terms, `ITSAppUsesNonExemptEncryption`,
provider-ToS/custody); Apple/Play/npm accounts + Developer ID/Authenticode certs;
deploy legal+deletion pages; keep `MANAGED_KEYS_AVAILABLE=false` until an audited
custody+ledger plane ships; Xcode + per-OS Rust builds to certify desktop/mobile.

## 11. Final launch gate
Tool calling + structured output shipped (or explicitly scoped out of "10/10
capability"); desktop signed+notarized on a clean machine with the keyring cross-lib
round-trip proven per OS; mobile store-submittable off a rebased branch; legal live
+ AI-report doc-state corrected; CSP nonce verified in-browser; every downloadable
surface works standalone. **Today: not there. Web + CLI BYOK: credible beta+.**

---

## Corrections applied (vs the founding 06-28 summary / the 06-26 audit)
1. **Mobile divergence is 80/7, not "~47 behind"** — this branch is 80 commits
   *ahead* of `mobile-serious-app`; the serious app holds 7 unmerged commits and is
   the real (diverged, not abandoned) app. The gap grows weekly. (Agents 04, 11.)
2. **Mobile consent gate + iOS ATS already exist** on `mobile-serious-app`
   (`lib/consent.ts` enforced at `app/index.tsx:374-388`; ATS +
   `ITSAppUsesNonExemptEncryption:false` correct) — the 06-26 "missing consent" was
   against the basic branch. (Agent 11.)
3. **Desktop keyring: a deeper risk than "needs a build."** Rust `keyring 3` vs
   gateway `@napi-rs/keyring ^1.3.0` — cross-library byte-compat is the real
   uncertified item, not the (now-matching) service name. (Design 10; orchestrator
   re-verified `Cargo.toml:17` + `package.json:16`.)
4. **UUID/JWT redaction is FIXED only in the relay copy, not the router copy.** The
   founding summary's "UUID redaction ✅" was relay-scoped; `packages/router/src/redact.ts`
   still matches only prefixed keys and explicitly cannot match generic/UUID tokens.
   The two "mirrored" redactors have drifted. (Agents 02, 06, 01; orchestrator
   re-read `redact.ts`.)
5. **New doc-honesty drift (a false *incomplete*):** `STORE-READINESS.md:69-71`
   still lists the AI-content report control as an open `[HUMAN] … wire it`
   checkbox, although it shipped on web/desktop (`8137fd9`). Inverse of a false ✅;
   should be checked off. (Agent 06; orchestrator re-read lines 69-71.)
6. **CSP-nonce root cause identified:** the reverted commit (`5e37241`) was
   structurally correct; it only *looked* dead because `next dev --webpack` injects
   `eval()`-based HMR that `'strict-dynamic'` (no `'unsafe-eval'`) blocks on
   localhost. A prod build would have been clean. (Design 09.)
7. **NEW low-severity finding:** `openai-compat.ts:75` serializes `messages`
   verbatim with no `ImageContentBlock` guard — it leans entirely on the router's
   vision filter, so a forced/direct call emits a malformed body rather than a clean
   rejection. Recommend a defensive guard. (Agent 01; design 12.)
8. **Capability/quality routing is only PARTIALLY fixed** — relocated into the
   registry but still static per-provider brand-rank, not per-model capability/quality.
   (Agent 01.)
