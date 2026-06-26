# iOS — App Store Connect Listing Checklist

App Store Connect metadata for the **Zintus** iOS app (`apps/mobile/`, Expo SDK ~56).
Bundle id `com.zintus.app`, version `0.2.0` (from `apps/mobile/app.json`).

> Product truth (App Review WILL test this — see `review-notes.md`):
> Zintus is **BYOK** (Bring Your Own Key). Users supply their own free-tier
> provider keys, stored on-device in `expo-secure-store`. Chat **requires a
> reachable Zintus gateway** (LAN auto-detect or Settings → Gateway URL;
> otherwise the app shows "Gateway offline — run `zintus serve`"). The Remote
> tab signs in to Zintus Cloud → relay → controls the user's HOME gateway.
> **Managed-key paid tiers are NOT available yet** ("coming soon"). Keys never
> leave the device / home machine. The listing copy MUST stay honest about this.

---

## 1. App metadata

| Field | Value / guidance |
|---|---|
| **App name** (30 char max) | `Zintus` |
| **Subtitle** (30 char max) | `Your keys, your AI gateway` |
| **Category — primary** | Productivity (alt: Developer Tools / Utilities) |
| **Category — secondary** | Developer Tools |
| **Support URL** (required) | `https://www.zintus.ai` |
| **Marketing URL** (optional) | `https://www.zintus.ai` |
| **Privacy Policy URL** (required) | `https://www.zintus.ai/privacy` — **DRAFT, pending counsel review.** Must be live, public, and non-placeholder before submission. Apple Guideline 5.1.1 requires a working privacy-policy link. |
| **Copyright** | `2026 YS Ventures LLC` |

### Description (BYOK-honest copy — draft)

```
Zintus is a bring-your-own-key AI client. Connect your own free-tier provider
keys (Groq, Google AI Studio, OpenRouter, and more) and chat through a gateway
you run yourself. Your API keys are stored only on your device's secure
keychain and are never sent to our servers in plaintext.

HOW IT WORKS
- Run the Zintus gateway on your computer (`zintus serve`). The app auto-detects
  it on your local network, or you can set the Gateway URL in Settings.
- Add your provider keys on the Providers screen — they stay on your device.
- Chat. Requests route through your gateway to the providers you chose.

REMOTE ACCESS
- Sign in to Zintus Cloud to securely reach the gateway running on your home
  machine from anywhere, relayed end-to-end. Your keys never leave home.

IMPORTANT
- Zintus requires a reachable Zintus gateway to chat. With no gateway, the app
  shows "Gateway offline — run zintus serve".
- Managed (hosted) keys and paid plans are coming soon and are not available in
  this version.
```

> Do **not** describe hosted/managed inference or paid tiers as available —
> they are disabled. Advertising features that don't function is a 2.3.x
> (accurate metadata) rejection.

### Keywords (100 char max, comma-separated, no spaces)

```
ai,llm,chat,byok,gateway,groq,openrouter,gemini,ollama,assistant,developer,privacy,self-host
```

### Promotional text (170 char, updatable without review)

```
Bring your own AI keys. Run your own gateway. Your keys stay on your device.
```

---

## 2. Screenshots — current (2026) required sizes

Apple requires at least one screenshot for the largest iPhone display class you
support, and (since the iPhone you support is universal/`supportsTablet: true`
in `app.json`) an iPad set as well. Sizes below are the 2026 spec.

| Device class | Required pixel size (portrait) | Notes |
|---|---|---|
| **iPhone 6.9"** (iPhone 17 Pro Max / 16 Pro Max) | **1320 × 2868** (also accepted: 1290 × 2796, 1260 × 2736) | Required. Lead with the 6.9" native asset. |
| **iPad 13"** (required because `supportsTablet: true`) | **2064 × 2752** | Required for iPad-enabled apps. Set `supportsTablet: false` in `app.json` if you do NOT want to ship/maintain iPad — that removes this requirement. |

- Format: PNG or JPEG, RGB, **no alpha channel**, exact pixel dimensions
  (Apple rejects off-by-one).
- Min 1, max 10 per device class.
- Suggested shots: Chat screen, Providers (BYOK) screen, Gateway URL settings,
  Remote tab sign-in, "Gateway offline" state (shows the honest UX).

---

## 3. Age rating

- Expected: **4+ / no objectionable content** from the app itself.
- **Caveat:** Zintus surfaces output from third-party LLMs (user-supplied keys).
  Answer the questionnaire honestly re: "Unrestricted Web Access" and
  user-generated/AI-generated content. If the rating questionnaire asks about
  AI-generated content moderation, disclose that responses come from external
  providers chosen by the user. A 12+ rating is plausible once Apple's
  questionnaire factors in unrestricted AI output. `[HUMAN]` complete the
  live questionnaire — do not guess the final rating here.

---

## 4. Encryption / export compliance — needs a real call, do not assume `false`

- `app.json` currently sets `ios.infoPlist.ITSAppUsesNonExemptEncryption = false`.
- **What's clearly exempt:** all the **HTTPS/TLS** traffic (to providers, relay,
  gateway) is OS-provided encryption via the URL loading system → fully exempt,
  no filing.
- **The wrinkle (be honest):** Zintus does **not** rely on OS TLS alone. It runs
  its **own key exchange in app code** — x25519 via `@noble` to encrypt the BYOK
  key push (`apps/mobile/lib/gateway-key-push.ts`). Apple/BIS guidance treats
  "ships its own key exchange / implements its own asymmetric crypto" as the
  exact case where a blanket `false` is **no longer automatically correct**, even
  when the algorithm (Curve25519/NaCl) is a *standard, published* one. The prior
  draft overstated this as "clearly exempt → false"; it is **not** clear-cut.
- **Two defensible paths — `[HUMAN]`/counsel must pick one before submit:**
  1. **Keep `false`** *if* counsel concludes the x25519 use qualifies as exempt
     because it is a standard published algorithm used solely to protect the
     app's own credentials (not the app's primary purpose, no proprietary
     crypto). Document this rationale. Lowest friction; some audit risk now that
     Apple cross-checks export answers against build/metadata.
  2. **Set `ITSAppUsesNonExemptEncryption = true`**, then in App Store Connect
     answer the export questions to claim the **standard/mass-market exemption**
     (EAR §740.17(b)(1), Category 5 Part 2). This path typically requires a
     **one-time/annual self-classification report to BIS + the ENC encryption
     registration** (a filing, **not** a CCATS). Most audit-proof.
- **Not required either way:** a CCATS classification request (the app uses only
  standard algorithms), and there is no separate French import declaration unless
  distributing specifically into regulated regions — confirm with counsel.
- **Recommendation:** because the x25519 key-push is genuinely app-controlled
  crypto, treat the `false` flag as **`[HUMAN]`/counsel-gated**, not a given. If
  in doubt, path 2 is the safe answer.

---

## 5. App Privacy "nutrition labels" — mapped to what is actually collected

Set in App Store Connect → App Privacy. Map each to the **real** data flow.
Apple's definition (accessed 2026-06-26): **"Collect"** = transmitting data off
the device **and storing it in readable form for longer than needed to service
the request in real time.** Data processed only on-device, or sent to a server
and **immediately discarded after servicing the request, is NOT "collected."**
"Third-party partners" whose collection you must also declare = "analytics
tools, advertising networks, third-party SDKs, or other external vendors whose
code you've added to your app."

> **Two separate obligations — don't conflate them:**
> 1. **App Privacy nutrition label (this §5)** — what *Zintus* (and embedded
>    SDKs) collect. Under Apple's "collect" definition, Zintus does **not**
>    collect chat content or keys (it doesn't retain them; the AI providers are
>    **not** SDKs embedded by Zintus — they're user-chosen endpoints).
> 2. **Guideline 5.1.2(i) third-party-AI consent (new §5b below)** — a
>    **separate, mandatory** requirement that applies *because* prompts/images/
>    files are sent to third-party AI. It is **not** satisfied by the nutrition
>    label; it needs an explicit in-app consent disclosure + privacy-policy
>    disclosure. **This is the #1 new compliance gap for Zintus.**

### From the app on iOS (BYOK path)
- **API keys:** stored on-device in `expo-secure-store` only; pushed to the
  user's gateway as opaque x25519 ciphertext via relay. **Not collected by us**,
  not readable by the relay. → Do **not** list keys as collected.
- **Prompts / chat content, image input, file input:** routed device → gateway →
  chosen provider; **Zintus does not retain them** (real-time pass-through), and
  on the pure-LAN/BYOK path they never touch Zintus servers. → **Not "collected"
  by Zintus** for nutrition-label purposes. **BUT they ARE shared with a
  third-party AI provider → handle via Guideline 5.1.2(i) (§5b), and disclose in
  the privacy policy.**

### From the relay (Remote tab / Zintus Cloud sign-in)
The relay (`workers/relay`) collects only what's needed for auth + routing +
quota (see `docs/agents/OPS.md`). When the user signs in to Zintus Cloud:
- **Contact Info → Email Address:** collected for account/auth (Better Auth +
  Google sign-in). Linked to user. Purpose: App Functionality.
- **Identifiers → User ID:** account id for relay session/quota. Linked to user.
  Purpose: App Functionality.
- **Diagnostics → Crash/Performance/Other diagnostic data:** relay operational
  logs (request metadata for routing/quota; optional Sentry if `SENTRY_DSN`
  set). Purpose: App Functionality / Analytics. **No prompt bodies and no
  provider keys are logged.**

> The relay forwards **opaque ciphertext** for control messages and does not log
> prompt content or plaintext keys. State this in App Privacy and in
> `review-notes.md`.

### NOT collected (declare absent)
- No **tracking** across apps/websites (no ATT prompt; no ad SDKs).
- No location, contacts, photos, health, financials.
- No third-party advertising; no data sold.

> If the only Zintus-server data collection is the relay/Cloud sign-in path
> (Remote tab), and a user who never signs in / only uses LAN BYOK, then for the
> default flow the honest answer is "Data Not Collected" for chat content and
> keys, with the Contact/Identifier/Diagnostics items applying **only** to users
> who opt into Zintus Cloud. App Store Connect labels are app-wide, so declare
> the union (email + user id + diagnostics collected, since the Cloud feature
> exists in the binary).

### App Privacy nutrition-label summary (ready to enter)
| Apple data type | Collected? | Linked to user? | Used to track? | Purpose |
|---|---|---|---|---|
| Contact Info → **Email Address** | Yes (Cloud sign-in only) | Yes | No | App Functionality |
| Identifiers → **User ID** | Yes (Cloud only) | Yes | No | App Functionality |
| Diagnostics → **Crash/Performance/Other** | Yes | Yes | No | App Functionality / Analytics |
| User Content → **Other User Content / Photos or Videos / Audio** (prompts, images, files, dictation) | **No** (not retained by Zintus) | — | No | n/a for label — but **see §5b**: shared with third-party AI, needs 5.1.2(i) consent |
| **API keys / credentials** | No | — | No | Stored on-device only |

> No **Data Used to Track You** at all (no ATT prompt, no ad SDKs, no data
> brokers). Most of the binary's collection exists only for the optional Zintus
> Cloud feature.

---

## 5b. Guideline 5.1.2(i) — third-party-AI data sharing (NEW, MANDATORY)

**This is the single biggest 2026 compliance change for an app like Zintus and a
top rejection risk.** On **2025-11-13** Apple revised Guideline **5.1.2(i)** (and
reaffirmed it in the **2026-06-08** guidelines update) to read (verbatim):

> "You must clearly disclose where personal data will be shared with third
> parties, **including with third-party AI**, and obtain explicit permission
> before doing so."

Zintus sends **prompts, images, and files to third-party AI providers**
(OpenAI / Anthropic / Google Gemini / Groq / OpenRouter, etc.) — exactly the flow
this rule governs. Reviewers actively reject for: no consent before first send, a
single vague consent screen, vague privacy-policy wording, or any mismatch
between the consent text and actual behavior.

**What Zintus MUST implement (`[HUMAN]`/engineering — not just a doc change):**
- **Explicit consent BEFORE the first time data leaves the device to a provider.**
  Show a clear modal/onboarding step stating that the prompt (and any attached
  image/file/voice transcript) **will be sent to the AI provider the user
  selected**, and require an affirmative action to proceed.
- **Name the recipient.** Because providers are user-chosen, the consent can be
  generalized ("…to the AI provider you select, e.g. OpenAI, Anthropic, Google,
  Groq") and ideally surface the **active provider's name** at send time.
- **State the data types** shared: message text, attached images, attached
  files/documents, and (if dictation is server-side) audio/transcript.
- **Repeat it in Settings** (a persistent disclosure the user can revisit), and
  allow opting back out (the BYOK/offline reality already supports "don't send").
- **Privacy policy must list:** the provider(s), the purpose (AI inference /
  research), and **retention** ("retention is governed by your own account with
  that provider; Zintus does not retain prompt content"). Keep wording identical
  in app + policy to avoid a behavior/disclosure mismatch rejection.
- Mention the consent flow in **review notes** so the reviewer sees it is present
  and intentional (see `review-notes.md`).

> Architecture nuance to state, but which does **not** exempt you: data goes
> device → the user's own gateway → the user-chosen provider, and Zintus never
> custodies it. 5.1.2(i) still applies because personal data ultimately reaches a
> third-party AI; disclose + consent regardless.

---

## 5c. Permission purpose strings (Info.plist) — required wording

Guideline **5.1.1** requires every accessed sensitive API to have a purpose
string that **names the feature, the benefit, and the data type** — generic
strings like "App needs access" pass the automated upload check but are
**rejected by human reviewers**. A missing key for a symbol present in the binary
is a hard **ITMS-90683** upload failure. Set these in `app.json` →
`ios.infoPlist` (only ship the keys for features actually in the build):

| Info.plist key | Triggered by | Suggested string |
|---|---|---|
| `NSCameraUsageDescription` | Take a photo to attach to chat | "Zintus uses the camera so you can take a photo and attach it to your chat as image input for the AI." |
| `NSMicrophoneUsageDescription` | Voice dictation (speech-to-text) | "Zintus uses the microphone for voice dictation, converting your speech to text when you compose a message." |
| `NSPhotoLibraryUsageDescription` | Attach an existing image/file from the library | "Zintus accesses your photo library so you can attach an existing image to your chat as input for the AI." |
| `NSPhotoLibraryAddUsageDescription` | **Only if** the app saves images back to the library (e.g. saving a generated/annotated image) | "Zintus saves images you choose to export back to your photo library." (Omit if Zintus never writes to the library.) |
| `NSLocalNetworkUsageDescription` | Auto-detect the LAN gateway | *(already set)* "Zintus connects to a gateway running on your local network to route AI requests." |
| `NSSpeechRecognitionUsageDescription` | **Only if** using Apple's on-device `Speech` framework for dictation | "Zintus uses speech recognition to turn your dictation into text on-device." |

Notes:
- Prefer **`NSPhotoLibraryUsageDescription`** (read) for image input; only add
  **`NSPhotoLibraryAddUsageDescription`** if you actually write to the library.
- Guideline **2.5.14** (recording): for camera/microphone capture you must get
  explicit consent **and** show a clear visual/audible indication while
  recording — add a recording indicator to the voice-dictation UI.
- Request each permission **at point of use**, not on launch (5.1.1 best
  practice; avoids "requests data it doesn't need yet" rejections).

---

## 5d. Other guidelines that bite this app

- **4.2 Minimum Functionality:** an app that does nothing without an external
  gateway + a provider key is a 4.2 / 2.1 risk. Mitigations: ship enough working
  UX (history, projects, settings render offline), and **give reviewers a live
  demo path** (demo gateway URL or a built-in demo mode) — see `review-notes.md`.
- **2.1 App Completeness:** the backend (demo gateway / relay) **must be live
  during review**; if you can't provide a demo account, Apple allows a **built-in
  demo mode with prior approval** that "exhibits the app's full features."
- **1.2 User-Generated / AI content:** chat surfaces model output. Provide a way
  to **report/flag** an objectionable AI response, the ability to not see it, and
  published contact info; act on reports. (Mirrors Play's Gen-AI requirement.)
- **5.1.1(v) Account deletion:** because the app supports account creation
  (Zintus Cloud), it must offer **in-app account deletion** (not just a website).
  Relay `DELETE /api/account` exists; `[HUMAN]` confirm the in-app entry
  (Settings → Account → Delete account) is wired.
- **3.1.1 / 2.3.x:** no IAP/subscriptions ship in this build (managed keys
  disabled); don't advertise them. See `review-notes.md`.

---

## 6. Pre-submission gate

- [ ] **5.1.2(i) consent UI shipped** (explicit pre-send disclosure naming
      third-party AI) + repeated in Settings + matching privacy-policy wording
      (§5b). **Top rejection risk — verify in the binary.**
- [ ] Permission purpose strings set with feature-specific wording (§5c); only
      the keys for shipped features present; request at point of use.
- [ ] In-app **report/flag AI response** control present (1.2 / §5d).
- [ ] In-app **account deletion** wired (5.1.1(v)) — `[HUMAN]` confirm.
- [ ] **Encryption export answer decided** (`ITSAppUsesNonExemptEncryption`
      path 1 or 2) — `[HUMAN]`/counsel, §4.
- [ ] Privacy Policy URL live (not draft); **lists AI providers + purpose +
      retention** — `[HUMAN]` + counsel.
- [ ] Demo gateway reachable for review, or built-in demo mode (Apple-approved) — see `review-notes.md`.
- [ ] Screenshots at exact 2026 sizes (§2).
- [ ] No paid/managed-key copy in description (feature is disabled).
- [ ] `[HUMAN]` Apple Developer Program enrollment ($99/yr) — see `SECRETS.md`.
- [ ] `[HUMAN]` `eas init` run (writes `extra.eas.projectId`) per `docs/agents/MOBILE.md`.

---

## Sources (accessed 2026-06-26)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — **5.1.2(i)** (third-party AI consent), 4.2 (minimum functionality), 2.1 (completeness/demo, live backend, built-in demo mode), 1.2 (UGC moderation), 2.5.14 (recording indication), 5.1.1 + 5.1.1(v) (privacy policy + in-app account deletion), 2.3.x (accurate metadata).
- [Apple News: Updated App Review Guidelines (2026-06-08)](https://developer.apple.com/news/?id=d75yllv4)
- [Apple's new App Review Guidelines clamp down on apps sharing personal data with 'third-party AI' — TechCrunch (2025-11-13)](https://techcrunch.com/2025/11/13/apples-new-app-review-guidelines-clamp-down-on-apps-sharing-personal-data-with-third-party-ai/)
- [App Privacy Details — App Store](https://developer.apple.com/app-store/app-privacy-details/) — "collect" = transmit off-device + retain beyond real-time; tracking vs linked vs not-linked; data-use purposes.
- [ITSAppUsesNonExemptEncryption — Apple Developer](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption) — when `false` is/ isn't correct; OS HTTPS exempt; app-controlled key exchange not automatically exempt.
- [NSCameraUsageDescription / NSMicrophoneUsageDescription / NSPhotoLibraryUsageDescription / NSPhotoLibraryAddUsageDescription — Apple Developer](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSCameraUsageDescription)
- [Screenshot specifications — App Store Connect](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- [User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/)
