# DESKTOP + CLI — re-verification audit (2026-06-28)

Re-verifier: independent auditor. Branch `feat/multimodal-image-input` @ HEAD
`6bcd097` (all merged to main). Re-verifies the prior report
`docs/audit/2026-06-26/05-desktop-cli.md` against ACTUAL CODE. Bar: signed +
notarized standalone desktop, and an npm-installable CLI.

Method: read the real source on both sides of every claimed fix (frontend +
Rust + gateway/CLI keychain + relay auth), confirmed the two named commits touch
the exact files, and ran the scoped suite. Everything that can only be certified
by a per-OS Rust/Tauri runtime build is flagged **[NEEDS RUST BUILD]**.

## Suite run (this branch)

```
bun test apps/desktop/lib/tauri.test.ts apps/cli/src/commands/keys.test.ts \
         apps/cli/src/commands/cloud.test.ts apps/cli/src/commands/chat-content.test.ts
→ 39 pass, 0 fail, 119 expect() calls, 4 files
```

`6bcd097` adds `apps/desktop/lib/tauri.test.ts` into the root `test` glob in
`package.json` (verified in the diff) — the desktop keyring test is now part of
CI, not an orphan file.

---

## KEY CLAIM — keyring repointed to real `invoke(keyring_*)` + service match

**VERDICT: FIXED at the code level. CANNOT be certified without a per-OS Tauri/
Rust build.** [NEEDS RUST BUILD]

Commit `d0d4e27` ("keyring calls the real invoke(keyring_*) commands…") touches
exactly: `apps/desktop/lib/tauri.ts` (+37/−9), `src-tauri/src/lib.rs` (+9),
`app/_components/ProvidersScreen.tsx` (+4/−), and adds `lib/tauri.test.ts` (+117).

Independently confirmed against the actual files:

1. **Frontend now calls the shipped Rust commands, not the uninitialized plugin.**
   `apps/desktop/lib/tauri.ts` — `getKey` → `invoke("keyring_get", { providerId })`
   (`tauri.ts:38`), `setKey` → `invoke("keyring_set", { providerId, key })`
   (`tauri.ts:52`), `deleteKey` → `invoke("keyring_delete", { providerId })`
   (`tauri.ts:61`). The `invoke` itself is a lazy `import("@tauri-apps/api/core")`
   (`tauri.ts:28`). The prior `tauri-plugin-keyring-api` (`plugin:keyring|*`) path
   is GONE. No `tauri-plugin-keyring` import remains anywhere.

2. **The shipped Rust commands exist and are registered.** `src-tauri/src/lib.rs`
   defines `keyring_get`/`keyring_set`/`keyring_delete` (`lib.rs:18-41`) and lists
   all three in `generate_handler!` (`lib.rs:68-73`). `Cargo.toml:17` pulls the
   real `keyring = "3"` crate (apple-native / windows-native / sync-secret-service)
   — not a tauri plugin — so no capability grant is required for these custom
   commands (Tauri 2 gates plugin/core commands via capabilities, not app
   commands registered in the invoke handler). `capabilities/default.json:6`
   grants `core:default`, `pty:default`, `updater:default` — sufficient for IPC.

3. **Service-name mismatch is RESOLVED — verified on BOTH sides, file:line.**
   - Desktop Rust: `const SERVICE: &str = "zintus";` (`src-tauri/src/lib.rs:12`),
     entries keyed by `Entry::new(SERVICE, provider_id)` (`lib.rs:14-16`).
   - Gateway/CLI keychain: `const SERVICE = "zintus";`
     (`packages/keychain/src/storage.ts:6`), entries `new Ctor(SERVICE, account)`
     where `account` is the provider id (`storage.ts:91/99/107`).
   - They MATCH exactly (`"zintus"` == `"zintus"`), and both key entries by
     provider id. The prior `"com.zintus.desktop"` is gone. A key entered in the
     desktop app now lands in the SAME OS-keychain entry the local gateway reads
     for the chat path. (`com.zintus.desktop` still appears in
     `capabilities/default.json:3` and `tauri.conf.json` as the **bundle
     identifier** — correct and unrelated to the keychain service.)

4. **The UI is wired to the fixed path.** `ProvidersScreen.tsx:6` imports
   `{ deleteKey, getKey, isTauri, setKey }` from `@/lib/tauri`; "Save to keyring"
   → `setKey(selected, keyInput.trim())` (`ProvidersScreen.tsx:28`). So the
   button that previously threw now drives the real `keyring_set` invoke.

5. **Test coverage is real but mocks the boundary.** `lib/tauri.test.ts` mocks
   `@tauri-apps/api/core`'s `invoke` and asserts the exact command name + arg
   shape (`{ providerId }`, `{ providerId, key }`), the non-Tauri no-ops, and the
   swallow-on-error semantics (39 assertions across the file). It does NOT — and
   cannot, in `bun test` — exercise: the JS-camelCase → Rust-snake_case serde
   boundary (`providerId` → `provider_id`), the real OS keychain round-trip, or
   the actual gateway read-back of a desktop-written entry.

**Residual risk that only a Rust build certifies** [NEEDS RUST BUILD]:
the camelCase→snake_case argument mapping is Tauri-2 default behavior and looks
correct, but it is asserted by neither test nor compiler; a packaged
`save-key → restart → chat` round-trip on each OS (macOS Keychain, Windows
Credential Manager, Linux Secret Service) is the only proof the entry written by
the desktop app is the entry the gateway reads. The code is right; the runtime is
unproven here.

---

## Prior P0 / P1 / P2 — reclassified

### DESKTOP

| # | Prior finding | Status | Evidence |
|---|---|---|---|
| P0-1 | Keyring 100% non-functional (uninitialized plugin) + service mismatch | **FIXED (code)** [NEEDS RUST BUILD] | `d0d4e27`; `tauri.ts:38/52/61`, `lib.rs:12/18-41/68-73`, `storage.ts:6` |
| P0-2 | Unsigned all-OS; no Windows `signCommand`; macOS un-notarized | **STILL-OPEN [HUMAN]** | `tauri.conf.json` has NO `signCommand`/`signingIdentity`/`certificateThumbprint`/`hardenedRuntime`/notarize keys (grep empty) |
| — | "key→gateway sync via x25519 ciphertext" doc fiction | **FIXED-by-design** | No such code exists; the fix is the SHARED OS keychain (no relay push needed). Confirm STORE-READINESS doc no longer claims x25519 push (cross-ref agent 06). |
| P1 | No native menu (no `MenuBuilder` in `lib.rs`) | **STILL-OPEN** | `lib.rs` has no `Menu`/`MenuBuilder`; only `keyring_*` + `default_shell` + pty/updater plugins. Menu is JS keydown only. |
| P1 | Fake Find — ⌘⇧F just `router.push("/chat")` | **STILL-OPEN** | `app/_components/AppShell.tsx:78` ⌘⇧F → `router.push("/chat")`; no search UI |
| P1 | Export unverified (Blob+`a.download` likely no-op in WKWebView) | **STILL-OPEN** [NEEDS RUST BUILD] | `ChatPanel.tsx:226-231`, `research/page.tsx:104-109` still `Blob`+`a.click()`; no fs/dialog plugin |
| P1 | Placeholder-grade icons | **STILL-OPEN (unverified here)** | not re-measured this pass; was placeholder-grade per prior correction |
| P2 | Updater inert (registered, no `endpoints`/`pubkey`, no JS caller) | **STILL-OPEN** | `tauri-plugin-updater` registered (`lib.rs:67`) but `tauri.conf.json` has no `updater`/`endpoints`/`pubkey` block (grep empty); no JS caller |
| P2 | No UI to set gateway token (build-time `NEXT_PUBLIC_GATEWAY_TOKEN`) | **STILL-OPEN (not re-checked in depth)** | out of this pass's verified scope |

### CLI

| # | Prior finding | Status | Evidence |
|---|---|---|---|
| P1 | Bun-only — `npm i -g zintus` breaks for Node users | **STILL-OPEN** | shebang `#!/usr/bin/env bun` (`index.ts:1`); `build` is `bun build --target=bun` (`package.json`); `engines.bun >=1.1.0`, no `node`. A Node-only machine still hits `env: bun: not found`. No runtime preflight / Node target added. |
| P1 | `cloud status`/`logout` misreport (relay ignored Bearer; logout never revoked) | **FIXED (code, both sides)** | `cloud.ts` + relay. See below. |
| P2 | `--json` thin (only research + keys list) | **PARTIALLY-FIXED** | `cloud status`/`cloud logout` now emit structured `--json` (`cloud.ts:178/210-221/240-250/284-291/324-332`). `status`/`doctor`/`projects`/`history`/`trace` still no `--json`. |
| — | npm secret-safety / exit codes | **STILL-CORRECT (no regression)** | `files: ["dist/cli.js","README.md","LICENSE"]` allowlist; build externalizes native deps + `--minify`, no `--sourcemap`; ships only the bundle (no `src`/`*.test.ts`/`.map`/`.env`). |

---

## CLI cloud status / logout — re-verified (FIXED, both sides)

Prior P1: relay route was cookie-auth and ignored Bearer, so `status` always read
"offline"; `logout` never revoked the server session. Both are now genuinely
correct — verified on the CLI side AND the relay side:

- **CLI status** (`apps/cli/src/commands/cloud.ts:194-197`) GETs
  `/api/sessions/:id/status` with `Authorization: Bearer <gateway_secret>`, and
  is honestly tri-state: `online`/`offline` only when the relay answered, else
  `unknown` with a reason and **exit code 1** (`cloud.ts:203-231`) — no more
  confident-but-wrong "offline".
- **CLI logout** (`cloud.ts:307-310`) DELETEs `/api/sessions/:id` with the same
  Bearer, reports `revoked` only on a 2xx, ALWAYS clears local creds, and exits
  non-zero if the server session may be orphaned (`cloud.ts:312-322`).
- **Relay backs both.** `authorizeSessionScoped(c, id, allowGatewaySecret)`
  accepts a `Bearer` whose SHA-256 matches THAT row's `gateway_secret_hash`,
  scoped to `:id` only (`workers/relay/src/index.ts:250-267`). The status route
  opts in (`index.ts:944-948`, `allowGatewaySecret=true`) and the DELETE route
  opts in and force-disconnects + deletes the row
  (`index.ts:790-814`). Locked by `workers/relay/tests/cloud-auth-bearer.test.ts`
  (file present). So the CLI's cookie-less auth is real, not aspirational.

This depends on the relay being deployed with that code; the CLI behavior is
correct against it.

---

## CLI `--image` multimodal flag — re-verified (PRESENT + correct, local-only)

This is NEW since the prior report's scope (the branch is named for it). Verified:

- **Flag wired on both chat entry points** — explicit `chat` command
  (`apps/cli/src/index.ts:62-67`) and the bare-prompt shorthand
  (`index.ts:104-109`), each `--image <path>` repeatable via the `collectImage`
  commander collector (`index.ts:34-36`), mapped to `ChatOptions.images`
  (`index.ts:49`).
- **Processed locally before routing, fail-fast.** `runChat` calls
  `loadImages(options.images)` (`chat.ts:67`) which runs `@zintus/media`'s
  `processImage({ path })` per file (`chat-content.ts:90`), capped at
  `MAX_IMAGES = 4` (`chat-content.ts:16,81-86`). Magic-byte mime + EXIF strip,
  no network.
- **Secret/PII hygiene is real.** Image bytes/base64 never enter a log/throw:
  `describeImageError` echoes only the file PATH and typed `MediaError` codes
  (`chat-content.ts:39-70`); no synthetic `[Image: …]` text marker is injected —
  the image rides as a structured `ImageContentBlock` (`chat-content.ts:24-31`).
- **Honest capability error.** A router `unsupported_capability` is mapped to a
  clear "needs a vision-capable provider" message with actionable suggestions,
  not a silent downgrade (`chat-content.ts:106-118`, used at `chat.ts:69,156`).
- **Deliberate context trade-off** is documented and correct: with images the
  chat path skips git-diff/codebase context so the structured blocks survive
  (the compile path only re-reads text) (`chat.ts:88-107`). Reasonable.
- Covered by `chat-content.test.ts` (part of the 39 passing). Note these are unit
  tests of the pure helpers; an end-to-end vision round-trip needs a real
  vision-capable key (out of band).

No leak, no fake render, exit(1) on failure. This path is launch-credible on the
local CLI surface.

---

## Per-OS certification still required [NEEDS RUST BUILD — all of these]

Only a clean-machine, per-OS Tauri/Rust build can certify (none provable here):
keyring write→read→gateway round-trip (macOS Keychain / Windows Credential
Manager / Linux Secret Service); the camelCase→snake_case invoke arg mapping;
PTY `default_shell`; Blob export actually writing a file in WKWebView/WebView2;
Tauri origin/PNA (`tauri://localhost` vs gateway CORS); Gatekeeper/SmartScreen on
the signed artifact (and signing/notarization don't exist yet).

---

## VERDICT

The headline fix is **real and correctly done at the code level**: the desktop
frontend now calls the shipped Rust `invoke("keyring_get"/"keyring_set"/
"keyring_delete")` commands (`tauri.ts:38/52/61`), the orphaned plugin path is
gone, and the keychain service name matches on both sides — desktop
`SERVICE="zintus"` (`lib.rs:12`) == gateway/CLI `SERVICE="zintus"`
(`storage.ts:6`) — so a desktop-entered key is no longer invisible to the chat
path; `d0d4e27` touches exactly the right files and `6bcd097` wires the new test
into the suite (39/39 green). On the CLI, `cloud status`/`logout` are now
genuinely honest and backed by real relay session-scoped Bearer auth, and the new
`--image` multimodal flag is present, local-only, secret-safe, and capability-
honest. BUT the bar is unmet: the keyring fix is **code-certified, not runtime-
certified** — only a per-OS Tauri/Rust build can prove the keychain round-trip
and the invoke arg-name mapping, so I classify it FIXED-pending-build, not
shippable. And the standalone/signed bar is still blocked by STILL-OPEN items
the prior audit flagged and that did NOT change this pass: no signing/notarization
(`tauri.conf.json` has no `signCommand`), no native menu, a still-fake ⌘⇧F Find,
unverified Blob export, an inert updater, and a CLI that remains **Bun-only**
(`#!/usr/bin/env bun` + `--target=bun`) so `npm i -g zintus` still breaks for Node
users. Net: the specific P0 keyring/service defect is fixed in code; desktop is
not yet a signed, self-contained, build-certified app, and the CLI is not yet
npm-installable for Node — both remain gated.
