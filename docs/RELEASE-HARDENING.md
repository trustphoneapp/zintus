# Release Hardening — Remaining Work Before Public GA

The short, honest list of what is **not yet done** and gates a confident public
release. Everything here is either a `[HUMAN]` decision/credential/sign-off, a
`[HUMAN-device]` step that needs real hardware, or a `[FOLLOW-UP]` code task that
is scoped but unbuilt. Status as of **2026-06-28** on `feat/desktop-parity`.

This file is a pointer/checklist, not a spec. Detail lives in
[`STORE-READINESS.md`](./STORE-READINESS.md), [`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md),
and [`FEATURE-MATRIX.md`](./FEATURE-MATRIX.md). Where those disagree with this
file, treat the source doc as authoritative and fix the drift.

> Convention: a box is checked **only** when the thing is literally true today.
> When unsure, leave it unchecked. Under-claim.

## 1. In-browser CSP verification `[HUMAN-device]`

The per-request CSP nonce was relanded in `apps/web/proxy.ts` (per-request nonce,
dev-only `'unsafe-eval'` fail-closed on `NODE_ENV === "development"`, Report-Only
toggle). It is **code-verified only — NOT browser-verified.**

- [ ] Run `next build && next start` (production `NODE_ENV`) and load the app in
      a real Chrome/Firefox/Safari; confirm **zero CSP violations** in the console
      on the chat/compare/research/terminal surfaces.
- [ ] Confirm `'unsafe-eval'` is **absent** from the production response header
      (only present under `next dev`).
- [ ] Confirm streamed responses, styled-jsx, and `next/font` still render under
      the enforcing (not Report-Only) header.

## 2. Desktop native builds + signing/notarization `[HUMAN]` / `[HUMAN-device]`

Tauri bundles build, but nothing is signed. See `STORE-READINESS.md §4`.

- [ ] **macOS:** Apple Developer Program + Developer ID Application cert; sign
      (Hardened Runtime) + notarize (`notarytool`) + staple; verify with
      `spctl --assess` and `stapler validate`. `[HUMAN]`
- [ ] **macOS clean-device:** install from a browser download on a clean Mac with
      **no Gatekeeper warning**. `[HUMAN-device]`
- [ ] **Windows:** add `bundle.windows.signCommand` to `tauri.conf.json` (env vars
      alone do **not** sign) + Authenticode cert; verify `signtool verify /pa`
      returns Valid. `[HUMAN]`
- [ ] **Windows clean-device:** install/uninstall on a clean VM; verify
      Credential-Manager keyring, high-DPI icons, SmartScreen first-run behavior.
      `[HUMAN-device]`
- [ ] **Linux clean-device:** launch on Ubuntu LTS + Fedora + one Arch/AppImage;
      `.deb`/`.rpm` install+remove; Secret Service keyring + PTY + Wayland/X11;
      document the WebKitGTK 4.1 runtime dependency. `[HUMAN-device]`
- [ ] Keep the Tauri **updater OFF** until a real signing keypair + a
      `plugins.updater` block exist (currently compiled-in but inert).
- [ ] Real **1024²-sourced icon set** (current icons are multi-res but
      placeholder-grade). `[HUMAN]`

## 3. Desktop tool-calling parity `[FOLLOW-UP]`

Tool calling is live on **gateway API + CLI + Web (built-in tools)**; desktop is
**❌ on this branch** (no Tools toggle in `apps/desktop/app/_components/ChatPanel.tsx`).

- [ ] Land the desktop Tools UI from the parallel branch and re-verify end-to-end
      (UI → gateway → provider), then flip Desktop in `FEATURE-MATRIX.md`.
- [ ] Desktop provider-key path: repoint the frontend to the shipped Rust
      `keyring_*` commands and add key→gateway sync (service-name mismatch
      `com.zintus.desktop` vs gateway `zintus`) — `FEATURE-MATRIX.md` #19 (⚠️).

## 4. Mobile rebase + EAS `[HUMAN]` / `[FOLLOW-UP]`

The rich mobile app lives on `feat/mobile-serious-app`, **not on this branch**;
the on-branch app is a basic single-screen text chat. Treat every Mobile ✅ in the
matrix as *that branch, not certified here*.

- [ ] Rebase/merge `feat/mobile-serious-app` and re-verify its feature claims
      against current shared packages. `[FOLLOW-UP]`
- [ ] EAS `projectId` + store credentials; build via EAS. `[HUMAN]`
- [ ] App Privacy (Apple) + Data safety (Google) forms filled with the BYOK +
      third-party-AI-provider disclosure. `[HUMAN]`
- [ ] Mobile image input is **deferred** (not in v1 scope) — do not claim it.

## 5. User-defined web tool UI `[FOLLOW-UP]`

Web tool calling ships **built-in tools only** (calculator, `current_datetime`,
`random_number` in `apps/web/lib/web-tools.ts`), executed locally in a bounded
5-round loop. The gateway API + CLI already accept **arbitrary** tool definitions.

- [ ] A web UI for **user-defined** tools (arbitrary schemas + executors) is
      unbuilt; scope the executor sandbox/CSP story before shipping it.

## 6. Structured-output UI — web ✅, CLI ✅ (landed)

Status corrected on `feat/zintus-10-10`:
- **Web structured output is now LIVE** — `chat/page.tsx` persists a `jsonEnabled`
  toggle and sends `response_format: { type: "json_object" }` through
  `chat-client.ts` → `gateway.ts` → the gateway handler. The old "no web surface
  requests one" claim is stale.
- **CLI structured output is now LANDED** — `zintus chat --json` sends a real
  model `response_format: { type: "json_object" }`, and `--json-schema
  <file|inline>` (with `--strict` to demand a guaranteeing provider) sends
  `{ type: "json_schema", schema, strict }`. The flag is built in
  `apps/cli/src/commands/chat-content.ts` (`buildResponseFormat`) and threaded
  through `engine.routeAndStream` in `apps/cli/src/commands/chat.ts` — a true
  model structured-output request, distinct from the older `--json`
  *output-formatting* flags on `research`/`keys list`/`mcp list`/`cloud`. The
  validated JSON is pretty-printed to stdout; a non-conforming result is surfaced
  as a **non-fatal warning** with the validation issues, never a crash. Honesty
  caveat is carried in help text + output. Unit-tested in
  `apps/cli/src/commands/chat-content.test.ts`.

- [x] CLI `response_format` request landed (a `--json-schema`/`--json`/`--strict`
      model flag, distinct from output formatting) for true cross-surface parity;
      `FEATURE-MATRIX.md` updated.
- Honesty caveat held: only **Gemini** guarantees `json_schema`; all other
  providers are `json_object`/prompt-level (**best-effort, not guaranteed**),
  validated locally.

## 7. Legal / store / deploy `[HUMAN]`

- [ ] Privacy policy **live** at `https://www.zintus.ai/privacy` (currently DRAFT).
- [ ] Account-deletion page live at `https://www.zintus.ai/account/delete`
      (built; needs prod deploy).
- [ ] `/download` copy honest: **"beta — unsigned"** until signing/notarization
      land.
- [ ] Counsel sign-off on the **x25519 encryption-export** determination before
      relying on `ITSAppUsesNonExemptEncryption = false` (`STORE-READINESS.md §1.4`).
- [ ] Third-party-AI **consent disclosure** product/legal sign-off (the in-app
      data-flow + keyring copy exist; the destination/retention policy for the
      AI-content report needs final sign-off).
- [ ] (Stores only) Demo gateway + demo account stood up and kept live for the
      review window.

## 8. Known follow-ups (documented, not blockers) `[FOLLOW-UP]`

These are tracked elsewhere and are explicitly **not** silent gaps:

- [ ] Multimodal image input is **🟡 pending a keyed end-to-end smoke**
      (browser canvas → Gemini); code + tests + web build are green, but the live
      keyed run is the `[HUMAN]` gate. `docs/multimodal-image-input.md`.
- [ ] Private Mode is **best-effort**: `"unknown"`-training providers ARE now
      conservatively filtered (`mayTrainOnUserData`), and a stranded request carries
      `privacyHonored: false`; the remaining gap is a per-response "not honored"
      badge on every surface.
- [ ] Web CSP still allows `script-src 'unsafe-inline'`; Stripe webhook not
      itself flag-gated; bundle-baked `NEXT_PUBLIC_GATEWAY_TOKEN`.
- [ ] CLI `research` is faithful but **never executed** (key-gated); no
      idle-watchdog yet. Broader `--json` across status/doctor TUIs is the only
      remaining CLI surface item.
- [ ] Desktop export/share uses `Blob`+`a.download` — **unverified in the Tauri
      webview**; test on a packaged build.
- [ ] Re-confirm the `MANAGED_KEYS_AVAILABLE = false` gate (no paid tiers / no
      referral payouts) before any release.
