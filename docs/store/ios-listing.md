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

## 4. Encryption / export compliance

- `app.json` sets `ios.infoPlist.ITSAppUsesNonExemptEncryption = false`.
- **Reality check:** Zintus uses encryption (TLS/HTTPS to providers and relay;
  x25519 via `@noble` for BYOK key push — see `apps/mobile/lib/gateway-key-push.ts`).
  This is **standard / exempt** encryption (HTTPS + standard crypto used for
  the app's own security), which qualifies for the exemption — hence
  `ITSAppUsesNonExemptEncryption = false` and **no annual self-classification
  report / no French import declaration** is required.
- App Store Connect "Export Compliance" answer: **uses encryption, but only
  exempt** (standard encryption). This matches the `false` flag.
- `[HUMAN]` if Apple's export-compliance flow asks, the answer is: the app uses
  standard encryption algorithms (TLS, NaCl/x25519) and qualifies for the
  Category 5 Part 2 exemption. Confirm with counsel if shipping to regions with
  specific import rules.

---

## 5. App Privacy "nutrition labels" — mapped to what is actually collected

Set in App Store Connect → App Privacy. Map each to the **real** data flow.

### From the app on iOS (BYOK path)
- **API keys:** stored on-device in `expo-secure-store` only; pushed to the
  user's gateway as opaque x25519 ciphertext via relay. **Not collected by us**,
  not readable by the relay. → Do **not** list keys as collected.
- **Prompts / chat content:** routed device → gateway → chosen provider. On the
  pure-LAN/BYOK path the prompt content does **not** touch Zintus servers. →
  Not collected by us on the BYOK path.

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

---

## 6. Pre-submission gate

- [ ] Privacy Policy URL live (not draft placeholder) — `[HUMAN]` + counsel.
- [ ] Demo gateway reachable for review, or built-in demo steps — see `review-notes.md`.
- [ ] Screenshots at exact 2026 sizes (§2).
- [ ] No paid/managed-key copy in description (feature is disabled).
- [ ] `[HUMAN]` Apple Developer Program enrollment ($99/yr) — see `SECRETS.md`.
- [ ] `[HUMAN]` `eas init` run (writes `extra.eas.projectId`) per `docs/agents/MOBILE.md`.

---

## Sources (2026)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — esp. 2.1 (completeness/demo), 2.3.x (accurate metadata), 3.x (business), 5.1.1 (privacy policy).
- [Screenshot specifications — App Store Connect](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- [App Store Screenshot Dimensions 2026 (6.9" 1320×2868, 13" iPad 2064×2752)](https://screenhance.com/blog/app-store-screenshot-dimensions-2026)
- [App Privacy Details — App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/)
