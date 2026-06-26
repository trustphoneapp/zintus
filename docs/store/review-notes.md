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
- **Prompts / chat content**: on the BYOK/LAN path, prompts go device → gateway
  → the provider the user chose; they do **not** touch Zintus servers.
- **Relay logs**: only auth + routing + quota metadata (and optional Sentry).
  **No prompt bodies, no plaintext keys.** See `docs/agents/OPS.md`.
- Matches the App Privacy labels (`ios-listing.md`) and Data safety form
  (`play-listing.md`).

---

## Encryption / export (iOS)

- The app uses only **standard/exempt encryption** (TLS/HTTPS + NaCl/x25519 for
  the BYOK key push). `ITSAppUsesNonExemptEncryption = false` in `app.json`.
  No proprietary cryptography. (See `ios-listing.md` §4.)

---

## Known-good "negative" behaviors (so the reviewer doesn't file them as bugs)

- "Gateway offline — run `zintus serve`" when no gateway is reachable — expected.
- Empty/locked features tied to managed keys / paid tiers — expected (disabled).
- Local-network permission prompt on first launch (iOS) — expected and disclosed.

---

## Sources (2026)
- [App Store Review Guidelines — 2.1 (provide demo account / live backend), 2.3.x, 3.1.1](https://developer.apple.com/app-store/review/guidelines/)
- [Google Play Developer Program Policy](https://support.google.com/googleplay/android-developer/answer/16810878)
