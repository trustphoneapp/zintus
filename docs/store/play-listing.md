# Android — Google Play Console Listing Checklist

Play Console listing for the **Zintus** Android app (`apps/mobile/`, Expo SDK ~56).
Package `com.zintus.app`, version `0.2.0` (from `apps/mobile/app.json`).

> Product truth (Play review tests this too — see `review-notes.md`):
> **BYOK.** User keys stored on-device in `expo-secure-store`. Chat **requires a
> reachable Zintus gateway** (LAN auto-detect / Settings → Gateway URL; else
> "Gateway offline — run `zintus serve`"). Remote tab = Zintus Cloud sign-in →
> relay → user's HOME gateway. **Managed-key paid tiers are NOT available
> (coming soon).** Keys never leave the device / home machine.

---

## 1. Store listing metadata

| Field | Value / guidance |
|---|---|
| **App title** (30 char max) | `Zintus` |
| **Short description** (80 char max) | `Bring your own AI keys. Your own gateway. Keys stay on your device.` |
| **Full description** (4000 char max) | See block below — keep BYOK-honest, no live paid-tier claims. |
| **App category** | Productivity (alt: Tools) |
| **Tags** | AI, productivity, developer tools |
| **Contact email** (required) | a monitored support inbox `[HUMAN]` |
| **Website** | `https://www.zintus.ai` |
| **Privacy Policy URL** (required) | `https://www.zintus.ai/privacy` — **DRAFT, pending counsel.** Must be a live, public, non-placeholder HTTPS URL before submission. |

### Full description (draft)

```
Zintus is a bring-your-own-key (BYOK) AI client. Connect your own free-tier
provider keys (Groq, Google AI Studio, OpenRouter, and more) and chat through a
gateway you run yourself. Your API keys are stored only in your device's secure
storage and are never sent to our servers in plaintext.

HOW IT WORKS
- Run the Zintus gateway on your computer (zintus serve). The app auto-detects
  it on your local network, or set the Gateway URL in Settings.
- Add your provider keys on the Providers screen — they stay on your device.
- Chat. Requests route through your gateway to the providers you chose.

REMOTE ACCESS
- Sign in to Zintus Cloud to reach the gateway on your home machine from
  anywhere, relayed end-to-end. Your keys never leave home.

NOTE
- Zintus requires a reachable Zintus gateway to chat. Without one, the app
  shows "Gateway offline — run zintus serve".
- Managed (hosted) keys and paid plans are coming soon and are not available
  in this version.
```

---

## 2. Build / technical requirements (2026)

- **App Bundle (AAB)** required — Play does not accept APKs for new app
  publishing. EAS produces an `.aab` for the production profile.
- **Target API level: API 35 (Android 15) or higher** is the current minimum
  for new apps and updates (enforced since Aug 31, 2025). Note: from
  **Aug 31, 2026** the bar rises to **API 36 (Android 16)** — plan the bump.
  Verify the Expo SDK ~56 build's `targetSdkVersion` meets this before submit.
- App signing by Google Play (Play App Signing) enabled — `[HUMAN]` upload key
  via EAS managed credentials or service account (see `SECRETS.md`).

---

## 3. Data safety form

Play Console **blocks submission** until the Data safety form is complete. Map
to the real flows (mirrors the iOS App Privacy mapping in `ios-listing.md`).

- **Does your app collect or share user data?**
  - On the **BYOK / LAN-only** path: prompts and provider keys are NOT collected
    or shared by Zintus (keys live in `expo-secure-store`; control messages are
    opaque x25519 ciphertext through the relay).
  - On the **Zintus Cloud (Remote tab)** path the relay collects, so the
    app-wide answer is **Yes, collects**:
    - **Personal info → Email address:** account/auth. Collected, not shared,
      not sold. Purpose: App functionality / Account management.
    - **App activity / Device or other IDs → User ID:** relay session + quota.
      Collected, not shared. Purpose: App functionality.
    - **App info and performance → Crash logs / Diagnostics:** relay operational
      logs + optional Sentry (`SENTRY_DSN`). Collected. Purpose: App
      functionality / Analytics. **No prompt bodies, no provider keys logged.**
- **Is data encrypted in transit?** Yes (HTTPS/TLS; x25519 for key push).
- **Data deletion:** Yes — users can request account + data deletion (see §5).
- **Is any data collected required vs optional?** Cloud sign-in is optional;
  email/user-id only collected if the user opts into Zintus Cloud.
- **Tracking / advertising:** None. No ad SDKs, no third-party ad IDs, data not
  sold, not used for ads.

> Play also runs automated checks against the AAB before submission; declared
> SDKs must match. Keep the data-safety declaration consistent with the iOS App
> Privacy labels.

---

## 4. Content rating

- Complete the **IARC content rating questionnaire** (required; unrated apps can
  be removed).
- Expected low rating from the app itself, but disclose **user-controlled
  unrestricted AI output** (responses come from third-party LLMs via
  user-supplied keys) and any web access. `[HUMAN]` answer the live
  questionnaire honestly; don't hardcode a final rating here.

---

## 5. Account deletion (required)

Play requires a way to request **account + data deletion** both in-app and via a
**public web URL** (reachable without login, HTTPS, links directly to the
deletion page — not a buried homepage link; must state what is deleted, what is
retained and why, and processing time).

- **Account deletion URL:** `https://www.zintus.ai/account/delete` — **BUILT**
  (was a blocker). Public, login-free page (`apps/web/app/account/delete/page.tsx`,
  in `PUBLIC_ROUTES` + sitemap) describing the deletion scope; signed-in users
  confirm in-page and it calls the relay. `[HUMAN]` only remaining: deploy to
  prod (Vercel auto-deploys on merge to `main`) so the URL is live before submit.
- **Relay endpoint:** `DELETE /api/account` (`workers/relay/src/index.ts`) —
  cookie-authenticated, deletes ONLY the signed-in user's data (id from session,
  never from input), rate-limited, best-effort Stripe-cancel, idempotent.
- **In-app flow:** Settings → Account → Delete account (for Zintus Cloud
  accounts) should call the same `DELETE /api/account`. `[HUMAN]` confirm the
  mobile-app entry exists and is wired to it (relay side is done).
- Note: applies because the app supports account creation (Zintus Cloud /
  Remote tab). Pure BYOK users have no Zintus account to delete.

---

## 6. Screenshots & graphics

| Asset | Requirement |
|---|---|
| Phone screenshots | Min 2, max 8. 16:9 or 9:16; each side 320–3840 px. PNG/JPEG. |
| Tablet screenshots | Recommended if tablet-supported (`supportsTablet` applies to iPad; provide 7"/10" Android tablet shots if targeting tablets). |
| **Feature graphic** (required) | 1024 × 500 px, PNG/JPEG, no alpha. |
| **App icon** (Play listing) | 512 × 512 px, 32-bit PNG with alpha. |

- Suggested shots: Chat, Providers (BYOK), Gateway URL settings, Remote sign-in,
  "Gateway offline" state.

---

## 7. Pre-submission gate

- [ ] AAB built; targetSdk ≥ 35 (≥ 36 after Aug 31 2026).
- [ ] Data safety form complete + consistent with iOS labels.
- [ ] IARC content rating completed.
- [ ] Account-deletion web URL live (page BUILT at `/account/delete` + relay
      `DELETE /api/account`; needs prod deploy) + in-app flow wired to it.
- [ ] Privacy Policy URL live (not draft) — `[HUMAN]` + counsel.
- [ ] No live paid/managed-key claims in description.
- [ ] Demo gateway / steps ready for review — see `review-notes.md`.
- [ ] `[HUMAN]` Google Play Developer account ($25 one-time) — see `SECRETS.md`.

---

## Sources (2026)
- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Target API level requirements for Google Play apps (API 35 now; API 36 from Aug 31 2026)](https://support.google.com/googleplay/android-developer/answer/11926878)
- [Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)
- [Understanding Google Play's app account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Google Play Developer Program Policy](https://support.google.com/googleplay/android-developer/answer/16810878)
