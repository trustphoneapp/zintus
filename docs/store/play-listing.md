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

## 2. Build / technical requirements (verified 2026-06-26)

- **App Bundle (AAB)** required — Play does not accept APKs for new app
  publishing. EAS produces an `.aab` for the production profile.
- **Target API level — VERIFIED against the official Play page:**
  - **Now:** new apps and app updates must target **API 35 (Android 15) or
    higher** (in force since **Aug 31, 2025**).
  - **From Aug 31, 2026:** the minimum rises to **API 36 (Android 16) or
    higher** for all new apps and app updates. (Wear OS / Android TV stay one
    behind: API 34 now → API 35 from Aug 31, 2026.) An extension window is
    normally offered for the prior year's bar; do not rely on it.
  - **Action for THIS app:** Zintus is a brand-new submission. If you submit
    **on/after Aug 31, 2026 you MUST ship targetSdk 36.** Expo SDK ~56 supports
    API 36; confirm the production AAB's `targetSdkVersion` before upload.
  - **API 36 build gotchas to verify in the EAS build:** native libs must be
    **16 KB page-size aligned**; the system **photo picker** replaces legacy
    `READ_EXTERNAL_STORAGE` flows (relevant to image/file input — see §8);
    full-screen-intent use now needs `USE_FULL_SCREEN_INTENT` (Zintus does not
    use it). 
- App signing by Google Play (Play App Signing) enabled — `[HUMAN]` upload key
  via EAS managed credentials or service account (see `SECRETS.md`).

---

## 3. Data safety form (ready-to-paste answers)

Play Console **blocks submission** until the Data safety form is complete, and
Play actively **enforces mismatches** between the declaration and observed app
behavior (a common takedown/rejection vector). Definitions that drive the
answers below (from the official Data safety help page, accessed 2026-06-26):

- **"Collected"** = the app transmits data **off the device**. (Data processed
  only on-device, or sent to a server and discarded after servicing the request
  in real time, is **not** "collected.")
- **"Shared"** = the app transfers collected data **to a third party** — "any
  organization other than the first party or its service providers." **A
  user-selected AI provider (OpenAI / Anthropic / Groq / Gemini / OpenRouter)
  is a third party**, not Zintus's service provider.

> **Decision for THIS app (the task's core data flow):** because chat
> prompts, **images, and files are transmitted off the device to third-party AI
> providers**, the honest and store-consistent posture is to **declare that
> sharing** rather than rely on the "ephemeral / user-initiated transfer"
> exceptions. This also keeps Play consistent with Apple's mandatory
> third-party-AI disclosure (Guideline 5.1.2(i), see `ios-listing.md`). Note in
> the form's free-text/notes that **Zintus itself does not retain this content**
> (it passes device → the user's own gateway → the user-chosen provider; on the
> pure BYOK/LAN path it never reaches Zintus servers), and that the provider's
> own retention is governed by the user's account with that provider.

### App-wide answer: **Yes, this app collects and shares user data.**

| Data type (Play category) | Collected | Shared | Purpose | Encrypted in transit | Required / Optional | Notes |
|---|---|---|---|---|---|---|
| **Messages** → "Other in-app messages" (chat prompt text) | Yes | **Yes — to the user-selected AI provider** | App functionality | Yes (HTTPS/TLS) | Required (core chat) | Not retained by Zintus; routed via the user's own gateway. |
| **Photos and videos** (image input — gallery/camera) | Yes | **Yes — to the AI provider** | App functionality | Yes | Optional (only if user attaches an image) | Same pass-through; Zintus does not store. |
| **Files and docs** (PDF/doc input) | Yes | **Yes — to the AI provider** | App functionality | Yes | Optional (only if user attaches a file) | Same pass-through; Zintus does not store. |
| **Audio** → voice/STT — *declare ONLY if dictation audio leaves the device.* If speech-to-text runs **on-device**, declare **Not collected**. | Conditional | Conditional (to STT/AI provider, if server-side) | App functionality | Yes | Optional | Prefer on-device STT to keep this "Not collected." `[HUMAN]` confirm the STT path. |
| **Personal info → Email address** (Zintus Cloud sign-in) | Yes | No | App functionality / Account management | Yes | **Optional** (only if user signs in to Zintus Cloud) | Better Auth + Google sign-in. Not sold. |
| **Device or other IDs → User ID** (relay session/quota) | Yes | No | App functionality | Yes | Optional (Cloud only) | Relay session + quota id. |
| **App info and performance → Crash logs / Diagnostics** | Yes | No | App functionality / Analytics | Yes | Optional | Relay operational logs + optional Sentry (`SENTRY_DSN`). **No prompt bodies, no provider keys logged.** |
| **API keys / provider credentials** | **No** | **No** | — | — | — | Stored on-device in `expo-secure-store`; pushed to the user's gateway as opaque **x25519 ciphertext** via the relay (relay cannot read them). **Do NOT declare as collected.** |

- **Is all collected data encrypted in transit?** **Yes** (HTTPS/TLS everywhere;
  x25519 for the BYOK key push).
- **Do you provide a way to request data deletion?** **Yes** — account + data
  deletion in-app and via a public web URL (see §5). Local chat history is
  cleared on-device; content sent to a provider is governed by the user's own
  provider account.
- **Tracking / advertising:** **None.** No ad SDKs, no advertising IDs, data not
  sold, not used for ads, no cross-app tracking.

> **Why Play declares this "shared" but the Apple nutrition label does not (not a
> contradiction):** the two stores define terms differently. Apple's "collect"
> requires *retaining* data off-device beyond real-time — Zintus doesn't retain
> it, so the Apple **label** says not-collected, and Apple instead governs the
> third-party-AI flow through the **separate 5.1.2(i) consent** requirement.
> Play's "shared" is simply *transfer to a third party*, which the flow plainly
> is. Net result is the **same disclosure to users** on both stores. Play also
> runs automated checks against the AAB; declared SDKs and permissions must match
> what ships.

---

## 4. Generative AI content policy compliance (REQUIRED — 2026)

Zintus surfaces AI-generated chat output (and Deep Research output), so Google
Play's **AI-Generated Content policy** applies. Verified 2026-06-26:

- **In-app reporting/flagging is mandatory.** Apps that generate content using
  AI **must include an in-app feature to report or flag offensive content to the
  developer without leaving the app.** Zintus must add a **"Report / flag this
  response"** affordance on AI messages (long-press or overflow menu on each
  assistant message; also on Deep Research results). **`[HUMAN]`/engineering:
  confirm this control exists in the chat UI before submit — this is a hard Play
  requirement, not optional.**
- **Use the reports.** Developers are expected to act on user reports to inform
  content filtering/moderation. Route flags to the support inbox.
- **Prohibited AI output** (must not be generatable / must be filtered):
  CSAE/child-exploitation, non-consensual deepfake sexual material, voice/video
  recordings facilitating scams, content enabling dishonest/deceptive behavior
  (e.g. fake official documents), malicious code, demonstrably deceptive
  election content. Because models are user-supplied (BYOK), state in review
  notes that prompts are user-driven and the reporting control + provider-side
  safety apply.
- **Play "AI-generated content" declaration / questionnaire:** answer truthfully
  in Play Console **App content** that the app produces AI-generated content and
  that it includes the in-app reporting mechanism. `[HUMAN]` complete the live
  form.

## 4b. Content rating (IARC)

- Complete the **IARC content rating questionnaire** (required; unrated apps can
  be removed).
- Expected low rating from the app itself, but disclose **user-controlled
  unrestricted AI output** (responses come from third-party LLMs via
  user-supplied keys), **unrestricted web access** (Deep Research), and the
  presence of **AI-generated content**. `[HUMAN]` answer the live questionnaire
  honestly; don't hardcode a final rating here.

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

## 7. Permissions justification & manifest hygiene (Android)

Play's **Permissions and APIs that Access Sensitive Information** policy requires
each permission to have a clear, disclosed user-facing purpose, and that you
request the **minimum** set. Declare a Permissions Declaration in Play Console
only for the high-risk permissions if prompted. The new mobile features add
camera/mic/photo access — justify each:

| Permission (Android) | Why Zintus needs it | Feature | Notes |
|---|---|---|---|
| `CAMERA` | Take a photo to attach to a chat as image input | Image input (camera) | Added by `expo-camera` / `expo-image-picker`. Only request at point of use. |
| `RECORD_AUDIO` | Voice dictation (speech-to-text) for composing messages | Voice input | Request at point of use; show a recording indicator. **If voice ships on-device STT and you do NOT capture audio elsewhere, keep this; otherwise block it (see below).** |
| Photo access — **API 33+ uses the system Photo Picker (no permission)**; legacy `READ_MEDIA_IMAGES` only if you bypass the picker | Pick an existing image/file to attach | Image/file input (gallery) | Prefer the **Android Photo Picker** (no runtime permission, required pattern on API 36) over broad media permissions. |
| `INTERNET` (normal) | Reach the gateway / relay | Core | Auto-added; no declaration needed. |
| Local network access | Auto-detect the gateway on the LAN | Gateway discovery | Android reaches a LAN IP over `INTERNET`; the **cleartext-to-LAN** concern is handled by network-security-config, not a permission (see below). |

### Block permissions Expo auto-adds that Zintus does NOT use

Expo config plugins inject permissions into the merged `AndroidManifest.xml`.
**`expo-image-picker` adds `RECORD_AUDIO` on Android by default**, and
image/camera plugins can pull in `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`.
A stray `RECORD_AUDIO` you don't use will draw Play scrutiny. Remove what you
don't need:

- For `expo-image-picker`, set `microphonePermission: false` in the plugin
  config (stops it adding `RECORD_AUDIO`).
- Belt-and-suspenders: list unwanted permissions in **`android.blockedPermissions`**
  in `app.json` (the only way to strip permissions added by a package's manifest):
  e.g. block `android.permission.RECORD_AUDIO` **if voice dictation is NOT in
  this build**, and block legacy `READ_EXTERNAL_STORAGE` /
  `WRITE_EXTERNAL_STORAGE` if you use the system Photo Picker.
- `[HUMAN]`/engineering: audit the final merged manifest (`npx expo prebuild`
  then inspect `android/app/src/main/AndroidManifest.xml`) so declared
  permissions exactly match the Data safety form (§3) and shipped features.

### Cleartext traffic to the LAN gateway

To reach a `http://<lan-ip>:<port>` gateway, Android 9+ (API 28+) blocks
cleartext by default. Do **not** set a blanket `usesCleartextTraffic: true`
(Play/security frowns on it). Instead ship a **network security config** that
permits cleartext **only** to local/private ranges (e.g. domain-config entries
for the LAN), keeping all public traffic HTTPS-only. Remote-tab traffic to the
relay/home gateway stays TLS. `[HUMAN]`/engineering: confirm the
`networkSecurityConfig` is scoped to LAN ranges, not global.

---

## 8. Pre-submission gate

- [ ] AAB built; **targetSdk ≥ 35 now, ≥ 36 if submitting on/after Aug 31 2026.**
- [ ] Data safety form complete + consistent with iOS labels, **including the
      third-party-AI sharing of Messages/Photos/Files (§3).**
- [ ] **In-app "report/flag AI response" control present** (Gen-AI policy, §4)
      and Play Console AI-generated-content declaration answered.
- [ ] IARC content rating completed (discloses AI output + web access).
- [ ] Permissions audited: merged manifest matches §3/§7; **`RECORD_AUDIO`
      blocked if voice not shipped**; cleartext scoped to LAN only.
- [ ] Account-deletion web URL live (page BUILT at `/account/delete` + relay
      `DELETE /api/account`; needs prod deploy) + in-app flow wired to it.
- [ ] Privacy Policy URL live (not draft), **and it names the AI providers data
      is shared with, the purpose, and retention** (matches Apple 5.1.2(i)) —
      `[HUMAN]` + counsel.
- [ ] No live paid/managed-key claims in description.
- [ ] Demo gateway / steps ready for review — see `review-notes.md`.
- [ ] `[HUMAN]` Google Play Developer account ($25 one-time) — see `SECRETS.md`.

---

## Sources (accessed 2026-06-26)
- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469) — defines "collected" (off-device) vs "shared" (transfer to a third party = any org other than you or your service providers).
- [Target API level requirements for Google Play apps](https://support.google.com/googleplay/android-developer/answer/11926878) — **API 35 now; API 36 (Android 16) for new apps + updates from Aug 31, 2026** (Wear OS/TV: API 34 → API 35).
- [Google Play's Target API Level Policy](https://support.google.com/googleplay/android-developer/answer/16561298) — "within one year of the latest major Android release."
- [Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)
- [Understanding Google Play's AI-Generated Content policy](https://support.google.com/googleplay/android-developer/answer/14094294) — in-app reporting/flagging requirement + prohibited AI content.
- [AI-Generated Content (Play Console Help)](https://support.google.com/googleplay/android-developer/answer/13985936)
- [Permissions and APIs that Access Sensitive Information](https://support.google.com/googleplay/android-developer/answer/9888170)
- [Expo Permissions guide — `android.blockedPermissions`, `expo-image-picker` adds `RECORD_AUDIO`](https://docs.expo.dev/guides/permissions/)
- [Understanding Google Play's app account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Google Play Developer Program Policy](https://support.google.com/googleplay/android-developer/answer/16810878)
