# Store & Distribution Readiness — Zintus Desktop

Compliance + readiness state for shipping the **Zintus desktop** app
(`apps/desktop/`, Tauri v2). Companion to the build runbook
[`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md).

> **Zintus is BYOK / local-first.** Users supply their own provider API keys,
> stored only in the **OS keyring** (macOS Keychain / Windows Credential Manager
> / Linux Secret Service). The **relay** (`relay.zintus.ai`) handles
> auth/session/quota only — **no managed keys, no server-side key custody**. The
> **gateway** (`zintus serve`, on the user's machine) is the execution plane.
> Prompts on the BYOK/LAN path go device → gateway → the provider the user
> chose; they do **not** touch Zintus servers. This shapes every privacy answer
> below.

## Readiness at a glance (2026-06-26)

| Surface | Channel | State |
|---|---|---|
| macOS | Direct download (GitHub Releases) | 🟡 Builds OK, **unsigned/un-notarized** → Gatekeeper warns. Not GA-ready. |
| Windows | Direct download (GitHub Releases) | 🔴 Builds OK but **unsigned** *and* no `bundle.windows.signCommand` → cannot sign even with the wired Azure secrets. |
| Linux | Direct download (GitHub Releases) | 🟡 Builds OK (deb/rpm/AppImage); no signing concept; needs clean-distro install verification. |
| Mac App Store | — | ⚪ **Out of scope (Phase 2)** — Tauri not sandbox/MAS-configured (`store/mac-distribution.md`). |
| Microsoft Store | — | ⚪ **Deferred** — tracked as the path that fully avoids SmartScreen warnings. |

Mobile store listings (App Store / Play) are tracked separately in
[`store/ios-listing.md`](./store/ios-listing.md),
[`store/play-listing.md`](./store/play-listing.md), and
[`store/review-notes.md`](./store/review-notes.md). The privacy posture there is
the same BYOK model and the pointers below apply to any future MAS/Store push.

---

## 1. Privacy & data-use compliance

### 1.1 Apple App Privacy ("nutrition label") — for any future App Store / MAS push
Apple requires every developer to declare, in App Store Connect, what data the
app **and its third-party SDKs** collect and how it's used — required to submit
any new app or update. Ground the answers in the BYOK reality:

- Provider **API keys**: stored on-device only (OS keyring); on **mobile**,
  pushed to the user's own gateway as opaque **x25519 ciphertext** via the relay
  — the relay **cannot read them**. (Audit 2026-06-26: this x25519 push is the
  *mobile* path; the **desktop** has no key→gateway push yet, and its keyring
  write path is currently broken — see §3.1.) Not "collected" by Zintus.
- **Prompts / chat content**: device → gateway → chosen provider; not collected
  by Zintus servers on the BYOK/LAN path.
- **Relay**: auth + routing + quota metadata only (+ optional Sentry). No prompt
  bodies, no plaintext keys.
- Pointer for the actual label values: [`store/ios-listing.md`](./store/ios-listing.md).
- Note: the **"third-party AI provider"** is a key disclosure — the user's
  prompt leaves the device to *their chosen provider* (Groq, Google, Mistral,
  etc.). That third party's handling is governed by the user's own provider
  account, but it must be **disclosed** (see §1.3).

### 1.2 Google Play Data safety — for any future Play push
Play's **Data safety** form (mandatory) declares collection/sharing across 14
data categories incl. third-party libraries. Same BYOK answers as above; pointer
for the filled form: [`store/play-listing.md`](./store/play-listing.md).

### 1.3 Third-party-AI consent + AI-content reporting (in-app controls)
Because prompts are sent to a **third-party AI provider the user selects**, the
app must make that explicit and give the user control:
- [ ] **Consent / disclosure**: the data-flow explainer in-app
      (`ChatPanel.tsx` "Here's exactly where data travels") + the keyring consent
      copy (`lib/consent.ts`: "Stored in your OS keyring. Never sent to the
      relay.") establish disclosure. Confirm it states prompts go to the chosen
      third-party provider before first send. 🔑 [HUMAN] product/legal sign-off.
- [x] **AI-content report control** — **SHIPPED** (commit `8137fd9`): a user-facing
      report/flag action on AI output landed on web + desktop (`MessageBubble`), per
      app-store UGC/AI expectations. The mechanism (in-app report → support address)
      is decided and wired. 🔑 [HUMAN] final product/legal sign-off on the
      destination/retention policy still recommended before store submission.

### 1.4 Encryption export — **counsel-gated, NOT auto-exempt** 🔑 [HUMAN]
Zintus uses TLS/HTTPS (OS-provided, exempt) **and** **x25519 / NaCl** for the
BYOK key push. Apple/US-BIS rules: encryption *built into the OS* (e.g. HTTPS via
URLSession) is exempt from export-documentation upload; **proprietary or
non-exempt cryptography is not automatically exempt** and may require BIS
registration / a CCATS classification. The mobile build currently declares
`ITSAppUsesNonExemptEncryption = false` (treating x25519-over-standard-primitives
as exempt) — **this is a legal determination, not a self-evident fact.**
- [ ] 🔑 Have **counsel confirm** the exemption status of the x25519 key-push
      before relying on `ITSAppUsesNonExemptEncryption = false` (and before any
      EU/US distribution that triggers export rules). Do **not** treat it as
      auto-exempt just because the primitives are standard.

### 1.5 Privacy policy — live URL required 🔑 [HUMAN]
App stores (and good practice for direct download) require a **publicly
reachable** privacy-policy URL at submission time.
- [ ] `https://www.zintus.ai/privacy` is **live and finalized with counsel**
      (currently DRAFT per `store/SECRETS.md`).
- [ ] `https://www.zintus.ai/account/delete` deletion page live (built; needs
      prod deploy — `store/SECRETS.md`).
- [ ] `/download` page copy honest: **"beta — unsigned"** until signing/
      notarization land (`store/mac-distribution.md`).

---

## 2. Reviewer / evaluator access (if/when submitting to a store)

A BYOK app does nothing without a reachable gateway — the #1 rejection risk.
Full reviewer script is in [`store/review-notes.md`](./store/review-notes.md).
- [ ] 🔑 **Demo gateway** URL stood up and pre-loaded with a working free-tier
      key, kept live for the whole review window (Apple 2.1 / Play: backend must
      be reachable during review).
- [ ] 🔑 **Demo account** (email/password) supplied **only if** the optional
      *Remote / Zintus Cloud* sign-in path is being reviewed; pure BYOK needs no
      account.
- [ ] State plainly to the reviewer: managed-keys/paid tiers are **disabled**
      ("coming soon"); **no IAP/subscription/paywall** in this build.

---

## 3. Data-flow & permission tables

### 3.1 Where data goes
| Data | Stored / sent where | Touches Zintus servers? |
|---|---|---|
| Provider API keys | OS keyring (service `com.zintus.desktop`) on-device. **Audit 2026-06-26:** the desktop has **no** key→gateway push — the "x25519 ciphertext via relay" flow is the *mobile* model, **not implemented on desktop**; and the desktop keyring write path is currently broken (frontend calls an uninitialized `tauri-plugin-keyring-api` plugin instead of the shipped Rust `keyring_*` commands). The gateway reads keys from its own keychain (service `zintus`), set via the CLI. | Keys never leave device; **relay not involved on the desktop key path** |
| Prompts / chat | device → local/own gateway → user-chosen provider | **No** (BYOK/LAN path) |
| Auth / session | relay (Google sign-in, cookie) — optional, only for Remote/Cloud | Yes (auth metadata only) |
| Quota / usage counts | gateway owns the ledger; relay counts quota | Metadata only — no prompt bodies |
| Crash / telemetry | optional Sentry (relay) | Only if enabled; no prompts/keys |

### 3.2 OS permissions / capabilities the desktop app uses
Grounded in `src-tauri/capabilities/default.json` + `Cargo.toml` + `lib.rs`:
| Capability | Mechanism | Why |
|---|---|---|
| Keyring read/write/delete | `keyring` crate: `apple-native` (Keychain) / `windows-native` (Credential Manager) / `sync-secret-service` (Secret Service) | Store BYOK keys at rest, on-device only |
| Embedded terminal (PTY) | `tauri-plugin-pty` (`pty:default`) + `default_shell` cmd | In-app terminal pane (`$SHELL`/`COMSPEC` resolution) |
| Local-network HTTP to gateway | CSP `connect-src localhost:8787`, `localhost:8788` | Reach the user's local gateway |
| Direct provider HTTPS | CSP `connect-src` provider hosts (groq/googleapis/cohere/mistral/deepseek/openrouter/cerebras/fireworks/x.ai) | Provider status/health where applicable |
| Updater (`updater:default`) | `tauri-plugin-updater` compiled + granted | **Inert** — no `plugins.updater` block, `createUpdaterArtifacts:false` |

> The updater capability is granted and the plugin is compiled in, but with no
> endpoints/pubkey it does nothing. Keep it OFF until a real signing keypair +
> `plugins.updater` block exist (`DESKTOP.md`); shipping an active updater with
> an empty key is a foot-gun.

---

## 4. NOT production-ready until… (blunt gate list)

Direct-download GA is blocked until **all** of these clear. Each is marked by
who can do it.

**macOS**
- [ ] 🔑 [HUMAN] Apple Developer Program membership + **Developer ID
      Application** cert obtained, secrets added.
- [ ] 🔑 [HUMAN] `.app`/`.dmg` **signed (Hardened Runtime) + notarized
      (`notarytool`) + stapled**, verified by `spctl --assess` + `stapler
      validate`.
- [ ] 🖥️ [HUMAN-device] **Installed on a clean Mac** from a browser download
      with **no Gatekeeper warning**.

**Windows**
- [ ] 🔑 [HUMAN] **`bundle.windows.signCommand` added** to `tauri.conf.json`
      (env alone does **not** sign) + Authenticode cert (Azure Trusted Signing or
      OV `.pfx`).
- [ ] 🔑 [HUMAN] `.msi`/`.exe` Authenticode signature **Valid**
      (`signtool verify /pa`).
- [ ] 🖥️ [HUMAN-device] **Installed on a clean Windows VM**; install/uninstall,
      Credential-Manager keyring, and high-DPI icons verified; SmartScreen
      first-run expectation documented (signing ≠ instant trust).

**Linux**
- [ ] 🖥️ [HUMAN-device] **Launches on Ubuntu LTS + Fedora + one Arch/AppImage**
      host; `.deb`/`.rpm` install+remove cleanly; Secret Service keyring + PTY +
      Wayland/X11 verified; WebKitGTK 4.1 runtime dependency documented.

**All surfaces**
- [ ] 🔑 [HUMAN] Real **1024² icon set** generated (current icons are placeholder
      stubs) — `RELEASE-CHECKLIST.md` §1.
- [ ] 🔑 [HUMAN] **Privacy policy live** (`/privacy`) + deletion page live;
      `/download` copy honest about beta/unsigned state.
- [ ] 🔑 [HUMAN] **Counsel sign-off** on the x25519 encryption-export
      determination (§1.4).
- [ ] 🔑 [HUMAN] Third-party-AI **consent disclosure** + **AI-content report**
      control decided/wired (§1.3).
- [ ] ✅ Automatable / already true: cross-OS bundles build in CI; versions in
      lockstep; updater intentionally OFF; typecheck clean.
- [ ] 🔑 [HUMAN] (only if pursuing stores) Demo gateway/account live for review;
      App Privacy + Data safety forms filled (§1–2).

> **Today's honest status: direct-download _beta_ — unsigned (all OS),
> un-notarized (macOS), Windows literally cannot sign yet (missing
> `signCommand`).** Everything that produces bundles is automatable; everything
> that makes them trustworthy + store-eligible is [HUMAN] and gated on
> certs/accounts/clean devices/counsel.

---

## Sources (accessed 2026-06-26)

- Apple — App Privacy Details (nutrition labels; declare app + third-party SDK data): https://developer.apple.com/app-store/app-privacy-details/
- Apple — User Privacy and Data Use: https://developer.apple.com/app-store/user-privacy-and-data-use/
- Apple — Complying with Encryption Export Regulations (OS HTTPS exempt; proprietary not auto-exempt): https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations
- Apple — `ITSAppUsesNonExemptEncryption`: https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption
- Apple — Overview of export compliance (App Store Connect): https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/
- Apple — App Store Review Guidelines (2.1 demo account/live backend; 3.1.1 IAP): https://developer.apple.com/app-store/review/guidelines/
- Google Play — Provide information for the Data safety section: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play — Developer Program Policy: https://support.google.com/googleplay/android-developer/answer/16810878
- Microsoft — SmartScreen reputation for Windows app developers (updated 2026-05-04): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Tauri v2 — macOS code signing & notarization: https://v2.tauri.app/distribute/sign/macos/
- Tauri v2 — Windows code signing (`signCommand`): https://v2.tauri.app/distribute/sign/windows/
- Tauri v2 — Updater plugin: https://v2.tauri.app/plugin/updater/
- Internal: [`store/mac-distribution.md`](./store/mac-distribution.md), [`store/SECRETS.md`](./store/SECRETS.md), [`store/review-notes.md`](./store/review-notes.md), [`store/ios-listing.md`](./store/ios-listing.md), [`store/play-listing.md`](./store/play-listing.md), [`agents/DESKTOP.md`](./agents/DESKTOP.md), [`agents/OPS.md`](./agents/OPS.md)
</content>
