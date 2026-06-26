# Reviewer Notes (App Review / Play Review)

Paste the relevant version of this into **App Store Connect → App Review
Information → Notes** and **Play Console → App content / review notes**. Its job
is to prevent rejection of a BYOK app whose core feature needs an external
gateway the reviewer must be able to reach.

> This is the single most rejection-prone aspect of Zintus: chat does nothing
> without a reachable gateway, and the most attractive features (managed keys /
> paid tiers) are intentionally **disabled**. Tell the reviewer this up front.

---

## What Zintus is (one paragraph for the reviewer)

> Zintus is a **bring-your-own-key (BYOK)** AI client. The user supplies their
> own free-tier AI provider API keys, which are stored only on the device's
> secure storage (`expo-secure-store` on iOS/Android; OS keychain on desktop)
> and are **never transmitted to Zintus servers in plaintext**. To chat, the app
> connects to a **Zintus gateway** — a small server the user runs on their own
> computer with `zintus serve`. The app finds the gateway automatically on the
> local network, or the user enters its URL under Settings → Gateway URL. With
> no reachable gateway, the app intentionally shows **"Gateway offline — run
> `zintus serve`"** — this is expected behavior, not a bug.

---

## How a reviewer can actually test it

Pick ONE of the two options and fill in the `[HUMAN]` values before submitting.

### Option A — Demo gateway URL (recommended, lowest-friction)
1. Open the app. Go to **Settings → Gateway URL**.
2. Enter the demo gateway URL: `[HUMAN: https://demo-gateway.zintus.ai or a
   temporary reviewer endpoint]` and save.
   - This is a Zintus-hosted gateway pre-loaded with a working free-tier
     provider key, provided **solely for review** (Apple Guideline 2.1 / Play
     review: backend services must be live and accessible during review).
3. Go to the **Chat** tab and send a message — you'll get a real AI response
   routed through the demo gateway.
4. The **Providers** screen shows BYOK setup; you do not need to add a key to
   test Chat because the demo gateway already has one.

> `[HUMAN]` keep the demo gateway up for the entire review window and re-supply a
> fresh URL/key on resubmission. If a demo account is also needed for the
> **Remote / Zintus Cloud** tab, provide demo credentials in the App Review
> "Sign-in required" fields (Apple) / review notes (Play):
> `email: [HUMAN]  password: [HUMAN]`.

### Option B — Run the gateway locally (if the reviewer has a machine)
1. Install the CLI: `npx zintus serve` (or per `https://www.zintus.ai/download`).
2. The gateway prints a LAN URL; the app on the same Wi-Fi auto-detects it, or
   enter the URL under Settings → Gateway URL.
3. Add a free provider key on the **Providers** screen, then chat.

Option A is preferred because it removes any setup burden from the reviewer.

> **Apple 2.1 fallback — built-in demo mode.** If a live demo gateway can't be
> guaranteed for the whole review window, Apple allows (with **prior approval**)
> a **built-in demo mode** that "exhibits the app's full features and
> functionality" in lieu of a demo account/backend. `[HUMAN]` decide between
> (a) keeping the demo gateway up reliably, or (b) shipping a demo mode and
> requesting Apple's approval. Either way the reviewer must be able to send a
> message and get a real response — an app that only shows "Gateway offline"
> will be rejected under 4.2 (minimum functionality) / 2.1 (completeness).

---

## Third-party AI data-sharing consent (Apple Guideline 5.1.2(i)) — what the reviewer will see

> Apple's Guideline **5.1.2(i)** (revised 2025-11-13) requires explicit
> disclosure + consent before any personal data is shared with third-party AI.
> Zintus handles this with an **in-app consent step shown before the first time a
> prompt/image/file is sent** to an AI provider: it states that the message and
> any attachment will be sent to the AI provider the user selected (e.g. OpenAI,
> Anthropic, Google, Groq), names the data types, and requires the user to
> proceed. The same disclosure is available in **Settings**, and the **privacy
> policy** lists the providers, purpose, and retention. This consent UI is
> intentional and expected — please do not flag it as a blocker. (Data goes
> device → the user's own gateway → the user-chosen provider; Zintus does not
> retain prompt content.)

## AI-generated content reporting (Apple 1.2 / Google Play Gen-AI policy)

> Chat and Deep Research surface output from third-party LLMs. Per Apple 1.2 and
> Google Play's AI-Generated Content policy, each AI response includes a
> **"report / flag"** control (long-press or overflow menu on an assistant
> message) that lets users report offensive content **without leaving the app**;
> reports route to support and inform moderation. Prompts are user-driven (BYOK),
> and provider-side safety also applies.

---

## Why there are no paid / in-app-purchase features to test

- **Managed-key (hosted) inference and all paid tiers are disabled in this
  build** ("coming soon"). There is **no in-app purchase, no subscription, and
  no hidden paywall** in this version (relevant to Apple 3.1.1 IAP and 2.3.x
  accurate-metadata; Play monetization policy).
- The only network "account" is the optional **Zintus Cloud** sign-in used by
  the **Remote** tab to relay to the user's own home gateway — it does not
  unlock paid inference. Sign-in is optional; pure BYOK works without an account.
- Because hosted inference is off, there are no managed credentials a reviewer
  would otherwise need.

---

## Local network usage (iOS specifically)

- The app requests **local network** access to auto-detect the gateway on the
  user's Wi-Fi. `app.json` declares:
  - `NSLocalNetworkUsageDescription`: "Zintus connects to a gateway running on
    your local network to route AI requests."
  - `NSAppTransportSecurity.NSAllowsLocalNetworking: true` (to reach a
    `http://<lan-ip>:<port>` gateway on the LAN).
- This is **legitimate, disclosed local-network use** (Apple privacy /
  local-network guidance), not analytics or tracking. If the reviewer is on a
  network where the gateway isn't present, use **Option A (demo gateway URL)**
  so no LAN discovery is needed.

---

## Privacy summary for the reviewer

- Provider **API keys**: stored only on-device (`expo-secure-store`); pushed to
  the user's gateway as **opaque x25519 ciphertext** via the relay
  (`apps/mobile/lib/gateway-key-push.ts`). The relay forwards ciphertext and
  **cannot read keys**.
- **Prompts / chat content, image input, file input, voice transcript**: on the
  BYOK/LAN path these go device → gateway → the provider the user chose; they do
  **not** touch Zintus servers and Zintus does **not** retain them. They ARE
  shared with the third-party AI provider, which is disclosed and consented per
  Apple 5.1.2(i) and declared in the Play Data safety form.
- **Relay logs**: only auth + routing + quota metadata (and optional Sentry).
  **No prompt bodies, no plaintext keys.** See `docs/agents/OPS.md`.
- Matches the App Privacy labels + 5.1.2(i) consent (`ios-listing.md`) and Data
  safety form (`play-listing.md`).

---

## Encryption / export (iOS)

- The app uses only **standard/exempt encryption** (TLS/HTTPS + NaCl/x25519 for
  the BYOK key push). `ITSAppUsesNonExemptEncryption = false` in `app.json`.
  No proprietary cryptography. (See `ios-listing.md` §4.)

---

## Permission prompts the reviewer will see (all expected & disclosed)

- **Local network** (iOS) — to auto-detect the gateway on the LAN.
- **Camera** — only when the user taps "take a photo" to attach image input.
- **Photo library** — only when the user attaches an existing image/file.
- **Microphone** (+ Speech Recognition on iOS) — only when the user starts voice
  dictation; a recording indicator is shown while capturing (Apple 2.5.14).
- Each is requested **at point of use**, not on launch, with a feature-specific
  purpose string. None are used for tracking or analytics.

## Known-good "negative" behaviors (so the reviewer doesn't file them as bugs)

- "Gateway offline — run `zintus serve`" when no gateway is reachable — expected.
  (Use **Option A demo gateway** so chat returns a real response during review.)
- Empty/locked features tied to managed keys / paid tiers — expected (disabled).
- Local-network permission prompt on first launch (iOS) — expected and disclosed.
- The **third-party-AI consent step** before the first send — intentional
  (Guideline 5.1.2(i)), not a bug.

---

## Sources (accessed 2026-06-26)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — 5.1.2(i) (third-party AI consent), 4.2 (minimum functionality), 2.1 (demo account / live backend / built-in demo mode), 1.2 (UGC reporting), 2.5.14 (recording indication), 3.1.1.
- [Apple's new App Review Guidelines clamp down on apps sharing personal data with 'third-party AI' — TechCrunch (2025-11-13)](https://techcrunch.com/2025/11/13/apples-new-app-review-guidelines-clamp-down-on-apps-sharing-personal-data-with-third-party-ai/)
- [Understanding Google Play's AI-Generated Content policy (in-app reporting/flagging)](https://support.google.com/googleplay/android-developer/answer/14094294)
- [Google Play Developer Program Policy](https://support.google.com/googleplay/android-developer/answer/16810878)
