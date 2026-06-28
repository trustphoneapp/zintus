# DESIGN — Mobile onto a shippable track

Date: 2026-06-28 · Author: mobile release design architect · Repo HEAD: `6bcd097` (`feat/multimodal-image-input`, which IS `origin/main`)

> Scope: a DESIGN, not an implementation. Read-only investigation of source; the only file written is this doc.
> **Mobile is its own release track.** It does not gate, and is not gated by, the web/gateway/desktop release. Everything below is sequenced so mobile can ship on its own cadence once it is rebased and certified on a device.

---

## 0. Ground truth — the TRUE divergence (corrects the 06-26 audit)

The serious mobile app is real and lives **only** on `feat/mobile-serious-app`. The 06-26 audit's headline numbers and several "MISSING" claims are now stale. Re-measured at HEAD `6bcd097`:

```
git rev-list --left-right --count origin/main...feat/mobile-serious-app
80      7
```

Topology (verified):
- **merge-base = `7c50799`** (= local `main` HEAD, 2026-06-26 15:18). `feat/mobile-serious-app` is built *directly* on this base.
- `feat/mobile-serious-app` = **7 commits ahead** of the base (the real app), tip dated 2026-06-26 17:26.
- `origin/main` (= working HEAD `6bcd097`) = **80 commits ahead** of the base, dated 2026-06-28.
- So the branch is **80 behind / 7 ahead**, NOT "~47 behind". Divergence has *grown* since the 06-26 audit, and keeps growing every day main advances. **This is the single biggest risk and it compounds daily.**

The 7 mobile commits:
```
0f0399e docs: scope deferred multimodal image input (#5) as its own PR
7a7a52b docs(mobile): voice fallback, expo-doctor status, README/TESTING refresh
3b605d0 feat(mobile): Projects/workspaces (#10) + one-tap local runtime (#13)
eed0863 feat(mobile): file attachments with on-device text extraction (#6)
d195ae8 feat(mobile): Providers control center + Private Mode
927767a feat(mobile): onboarding, Deep Research, and conversation history
228232c feat(mobile): surface Zintus moat in chat + production composer + history
```

`feat/mobile-serious-app` is **the real app and it is ahead** (it owns 18+ files that exist nowhere else). It is *not* stale in the "abandoned" sense — it is stale in the "diverged from a fast-moving main" sense. **Decision: rebase/merge it forward, do NOT ship the basic branch, do NOT rebuild from scratch.**

### Reality corrections to the 06-26 audit
The 06-26 `04-mobile.md` audited a mix of branches and conflated the basic branch with the serious one. On `feat/mobile-serious-app` specifically:

| 06-26 claim | Reality on `feat/mobile-serious-app` |
|---|---|
| "No consent gate / no `lib/consent.ts`" | **FALSE.** `apps/mobile/lib/consent.ts` exists and is enforced pre-send at `app/index.tsx:374-388` (gate) with a data-flow modal at `app/index.tsx:686-731`. |
| "Stop generation MISSING / no image/file/voice" | Partly stale — `lib/attachments.ts`, Projects, Deep Research, history, Markdown, ResponseFooter all present (commits above). |
| "Android cleartext unset" | **TRUE.** `app.json` has no `usesCleartextTraffic` / `expo-build-properties`. |
| "Streaming likely broken on device" | **TRUE.** `lib/chat.ts:155` `response.body.getReader()` on RN global fetch. |
| "iOS ATS / ITSAppUsesNonExemptEncryption correctly set" | **TRUE.** `app.json` ios.infoPlist is correct. |
| "No EAS projectId" | **TRUE.** `app.json` has no `extra.eas.projectId`; `eas.json` has no submit block. |

Net: the app is **more complete than the audit implies**, but has 3 hard blockers (streaming, Android cleartext, EAS wiring) **plus** a new structural blocker the audit could not have seen: the multimodal `ChatMessage` type change on main.

---

## 1. Branch strategy — **REBASE**, not merge, not cherry-pick

### Recommendation: rebase `feat/mobile-serious-app` onto `origin/main`
`git rebase origin/main feat/mobile-serious-app` (on a throwaway copy first — never on the working tree; do NOT switch the working branch).

Rationale:
- The branch is a **clean linear stack of 7 self-contained feature commits** on top of the merge-base. Rebase replays them onto a 7-commit-deep history that keeps each mobile feature reviewable and bisectable. That is exactly the shape rebase is good at.
- The reverse — **merge main into the branch** — produces one giant merge commit where the `ChatMessage` type adaptation (below) is buried and un-bisectable. Reject.
- **Cherry-pick** is for the opposite situation (pull a few main commits back). Here we want *all* of main plus the 7 mobile commits, so cherry-pick is the wrong tool. Reject.

### Concrete conflict-risk surfaces (measured)

**A. The ONLY direct file overlap: `apps/mobile/lib/messages.ts`** — guaranteed conflict.
`origin/main` commit `6a26517 (multimodal PR1)` edited this same file. Diff branch→main:
- main now imports `{ textOf }` from `@zintus/types` and filters with `textOf(message.content).trim()`.
- branch's `UiMessage` carries richer fields (`storedId`, `providerId`, `model`, `meta`, `error`) and filters with `message.content.trim()` (string-only).
- Resolution: keep the branch's richer `UiMessage`, adopt main's `textOf(...)` usage. Mechanical but must be done by hand.

**B. The structural blocker — `@zintus/types` `ChatMessage.content` changed shape (the real work).**
- branch (`packages/types/src/route.ts:5-8`): `content: string`.
- main (`packages/types/src/route.ts`): `content: string | ContentBlock[]` plus new `TextContentBlock`/`ImageContentBlock`/`ContentBlock`, `isContentBlockArray`, `textOf`, `sanitizeForLogs`, and a new `packages/types/src/content.ts` + `content.test.ts`.
- This is a workspace dependency, not an `apps/mobile` file, so it won't show as a *git* conflict — it will surface as **TypeScript build breakage** after rebase wherever mobile reads `.content` as a string. Audit those call sites during rebase: `lib/messages.ts`, `lib/chat.ts` (`StreamChatParams.messages: ChatMessage[]`), `components/ChatMessageBubble.tsx`, `lib/history.ts`, anything that renders or persists `message.content`. Fix = route through `textOf(content)` for display/persist; mobile stays text-only on send for now (image send is deferred PR #5 per `0f0399e`).

**C. Lockfile + workspace manifests — mechanical conflicts.**
`bun.lock`, root `package.json`, `tsconfig.build.json` all moved on main, and the branch bumped `apps/mobile/package.json` deps. Standard resolution: take main's `bun.lock`, re-run `bun install` after the rebase to regenerate, never hand-merge the lockfile.

**D. Shared packages the 80 commits rewrote that mobile imports at runtime/build time:** `@zintus/types`, `@zintus/providers`, `@zintus/router`, `@zintus/crypto-e2e` (mobile deps in `apps/mobile/package.json`). No git conflict (mobile doesn't edit them), but mobile must **typecheck + run** against the new versions. Treat `bun --filter @zintus/mobile typecheck` as the rebase's acceptance gate.

### Rebase runbook (read-only on the working tree)
1. Snapshot in a worktree or clone — do not check out the branch in the working tree.
2. `git rebase origin/main feat/mobile-serious-app`.
3. Resolve `messages.ts` (surface A) by hand.
4. `bun install` to regenerate `bun.lock` (surface C).
5. `bun --filter @zintus/mobile typecheck` → fix every `.content` string-assumption (surface B).
6. `bun --filter @zintus/mobile test` (the `gateway-url-resolve.test.ts` and others).
7. Push to a new PR branch (e.g. `feat/mobile-rebased`) — keep `feat/mobile-serious-app` intact as a fallback until the PR merges.

---

## 2. Streaming fix design — adopt `expo/fetch` (zero new dependency)

### Root cause (file:line)
`apps/mobile/lib/chat.ts`:
- `:124` `const response = await fetch(...)` — this is React Native's **global** fetch (no import of `fetch` in the file). RN's global fetch is XHR-backed and **does not populate `response.body`** as a WHATWG `ReadableStream`.
- `:147-148` `if (!response.body) throw new Error("Gateway returned no response body")` — on device this is the throw that fires.
- `:155` `const reader = response.body.getReader()` and `:165` `reader.read()` — never reached on device; works only in Expo Go's Hermes/Metro debug bridge where a partial polyfill exists, which is why it "works in dev" and dies in a release/EAS build. **No test covers this** — `gateway-url-resolve.test.ts` only asserts URL resolution.

### Fix: swap the global fetch for Expo's streaming fetch
Expo SDK 52+ (this app is on `expo ~56.0.0`, `package.json`) ships a WinterCG-compliant streaming fetch at **`expo/fetch`** whose `response.body` IS a real `ReadableStream` with a working `getReader()` on device (iOS + Android, release builds included). It is part of the `expo` package already in `dependencies` — **no new dependency, no native module, no config plugin.**

Design change in `apps/mobile/lib/chat.ts`:
- Add at top: `import { fetch as expoFetch } from "expo/fetch";`
- Change `:124` `await fetch(` → `await expoFetch(` .
- Everything downstream (`response.ok`, `response.headers` for `parseResponseMeta` at `:117`, `response.body.getReader()`, `TextDecoder`, the SSE line-buffer loop `:160-210`) is unchanged because `expo/fetch` returns a standards-compliant `Response`. The header-derived `ResponseMeta` (the compression-moat footer) keeps working because `expo/fetch` exposes response headers synchronously on resolve, same as today.
- Keep the `if (!response.body)` guard at `:147` as defense-in-depth.

Why this over the alternatives:
- **`react-native-fetch-api` + `react-native-polyfill-globals`** — works, but pulls 2 deps and monkeypatches global `fetch`/`ReadableStream`/`TextEncoder` for the whole app (broad blast radius, can collide with other libs). Only choose this if a non-Expo bare workflow is adopted later. Not needed here.
- **`react-native-sse` (EventSource)** — would require reworking the request to a GET-able SSE endpoint; the gateway streams over a `POST /v1/chat/completions` with a JSON body (`chat.ts:124-145`), which `EventSource` cannot send. Also the gateway emits OpenAI-style `data:` frames the existing loop already parses. Rework cost is high for no gain. Reject for the chat path. (Note: the separate `app/remote.tsx:106` live-feed *does* try `EventSource` and no-ops in RN — that's a different, lower-priority surface; `react-native-sse` is the right fix *there* if/when that feed matters.)
- **XHR manual chunking (`onprogress`)** — works without deps but you re-implement incremental UTF-8 decoding and SSE framing by hand; `expo/fetch` gives it for free. Reject.

### Test design (close the "no coverage" gap)
- Unit: a `chat.test.ts` that mocks `expo/fetch` to return a `Response` whose `body` is a hand-rolled `ReadableStream` emitting `data: {...}` frames + `[DONE]`, and asserts `onChunk` accumulates text and `meta` is parsed from headers + the `metadata` frame (`chat.ts:180-205`).
- **Device-only certification (cannot be unit-tested):** that the *real* RN runtime + `expo/fetch` actually streams in a **release** build (not Expo Go). This must be a manual checklist item on an EAS preview build (§5).

---

## 3. Android cleartext + iOS ATS — exact config changes

### Android — the hard blocker (file: `apps/mobile/app.json`)
Today there is **no** `usesCleartextTraffic` and **no** `expo-build-properties` plugin. On API 28+ release builds Android blocks cleartext HTTP by default, so the device can never reach the LAN gateway at `http://<host>:8788` (`gateway-url-resolve.ts:5` `GATEWAY_PORT = 8788`). It "works" in the dev client only because the dev client ships a debuggable manifest. **This is invisible in dev and fatal in release.**

Add the `expo-build-properties` config plugin (a new devDependency: `expo-build-properties`) to `app.json` `plugins`:

```jsonc
[
  "expo-build-properties",
  {
    "android": {
      // Minimum viable: allow cleartext app-wide.
      "usesCleartextTraffic": true
    }
  }
]
```

**Preferred hardening (scoped, defensible for Play review):** instead of a blanket flag, ship an Android **network security config** that permits cleartext ONLY for RFC1918 LAN ranges + `10.0.2.2` (emulator) + `localhost`, and keeps cleartext disabled for the public internet. `expo-build-properties` does not generate a `network_security_config.xml`, so this needs a tiny custom config plugin (or `app.config.ts` `mods`) that drops `res/xml/network_security_config.xml` and points `android:networkSecurityConfig` at it. This is the version to take to a Play "Gen-AI / data safety" review because it shows cleartext is intentionally LAN-only, not lazy. Recommend shipping the blanket flag first to unblock an internal EAS build, then tightening to the scoped config before production submit.

### iOS — already correct, leave it (file: `apps/mobile/app.json`)
`ios.infoPlist` already has, verified:
- `NSAppTransportSecurity.NSAllowsLocalNetworking: true` (reaches `http://` LAN without disabling ATS globally — the right, App-Store-defensible choice; do NOT add `NSAllowsArbitraryLoads`).
- `NSLocalNetworkUsageDescription` (required string for the iOS 14+ local-network permission prompt).
- `ITSAppUsesNonExemptEncryption: false`.
No change needed. Do **not** add `NSAllowsArbitraryLoads` — it would invite an ATS justification request at review for no benefit.

---

## 4. Consent gate — already present; design = harden + make revocable in UI

The gate **exists** (correcting the audit):
- `apps/mobile/lib/consent.ts` — MMKV-backed `hasProviderSendConsent()` / `grantProviderSendConsent()` / `revokeProviderSendConsent()`, keyed `providerSendConsent.v1`.
- Enforcement `app/index.tsx:374-388`: `if (routing.posture !== "local-only" && !hasProviderSendConsent()) { setConsentVisible(true); ... }` — first send to any non-local provider is intercepted.
- Modal `app/index.tsx:686-731`: shows the actual data-flow (`describeFlow("standard")` from `lib/data-flow.ts`) with Cancel / "Got it — send".
- Local-only (Private Mode) turns correctly bypass consent — data never leaves the device.

This satisfies Apple **5.1.2(i)** (explicit consent before sharing personal data with a third party). Design deltas to finish it:
1. **Make revoke reachable.** `revokeProviderSendConsent()` exists but verify Settings (`app/settings.tsx`) actually exposes a toggle; 5.1.2(i) expects consent to be *reversible*. If absent, add a "Allow sending to AI providers" switch wired to grant/revoke. (Spec, not yet confirmed wired — flag for the consent PR.)
2. **Versioned re-consent.** The key is `...v1`; if the set of destinations in `data-flow.ts` materially changes, bump to `v2` so prior consent doesn't silently cover new flows.
3. **Per-image consent copy (forward-looking).** When deferred image send (PR #5) lands, the modal copy must explicitly state images leave the device — the `ImageContentBlock` on main is already `exifStripped: true` and relay-excluded by contract, so the copy can truthfully say "EXIF stripped, never sent to Zintus relay."
4. **Play Data Safety parity.** Android has no 5.1.2(i) modal requirement, but the same gate doubles as the disclosure backing the Play Data Safety form — keep it on both platforms.

---

## 5. EAS RELEASE build + store-submission checklist

Current EAS state (`apps/mobile/eas.json`, `app.json`):
- `eas.json`: `appVersionSource: "remote"`, has `development` / `preview` / `production` build profiles. **No `submit` block.** Remote version source **requires** an EAS `projectId`, which is absent.
- `app.json`: **no `extra.eas.projectId`, no `owner`, no `runtimeVersion`.** Bundle IDs `com.zintus.app` (both platforms), scheme `zintus`.

### One-time wiring (HUMAN — requires Expo/Apple/Google accounts)
- `eas init` (Expo login) → writes `extra.eas.projectId` into `app.json`. Without this, every EAS build fails immediately. **[HUMAN]**
- Add a `submit` block to `eas.json`: iOS needs `appleId` / `ascAppId` / `appleTeamId` (or ASC API key); Android needs a Google Play **service-account JSON** with the app already created in Play Console. **[HUMAN]**
- Apple Developer Program + App Store Connect app record; Google Play Console app record. **[HUMAN]**
- `runtimeVersion` policy in `app.json` (recommend `{ "policy": "appVersion" }`) so OTA updates and store builds line up.

### What ONLY an on-device / EAS build can certify (cannot be proven in Expo Go or unit tests)
1. **Streaming actually works** end-to-end with `expo/fetch` in a **release** JS engine (Hermes, no Metro bridge). This is the single most important device-only check.
2. **Android cleartext** actually reaches `http://<LAN>:8788` from a release `.aab`/`.apk` (the dev client masks this).
3. **iOS local-network permission prompt** fires (driven by `NSLocalNetworkUsageDescription`) and, once granted, LAN gateway is reachable.
4. **expo-secure-store / MMKV / expo-sqlite** native modules link and persist across launches in a production build (consent, history, keys).
5. **Icons/splash** render at real densities; `notification-icon.png` is not a stub.
6. App launches without the Metro packager present (catches any `__DEV__`-only code path).

### `ITSAppUsesNonExemptEncryption`
- Already set `false` in `app.json` ios.infoPlist, so App Store Connect won't ask the export-compliance question per submission.
- **Counsel caveat:** the project uses `@zintus/crypto-e2e` (x25519). `false` is only correct if all crypto is exempt under the standard "limited to authentication/HTTPS/proprietary-but-exempt" carve-outs. x25519 key-agreement for app-level E2E is **not automatically exempt** — this must stay a **counsel-confirmed** value. If counsel says non-exempt, you owe a CCATS/self-classification and possibly a French encryption declaration. Treat the current `false` as provisional-pending-counsel, not settled. **[HUMAN/legal]**

### Store-listing gates (HUMAN content)
- Live **Privacy Policy URL** (data-flow already documented in-app via `data-flow.ts` — reuse that copy).
- Apple **App Privacy** "nutrition label" + Google Play **Data Safety** form — both must match the consent modal's disclosed flows.
- **Google Play Generative-AI policy**: app sends user content to third-party AI → declare AI use, provide a user-reporting/flagging affordance for AI output (the 06-26 audit flagged "Report-AI" — confirm a report affordance exists on the rebased app or add one before Play submit). **[HUMAN + small feature]**
- Demo gateway reachable by reviewers, plus reviewer notes that DON'T route them through a cloud-only key path on a LAN build (the 06-26 audit flagged `gateway-key-push.ts` requiring a Zintus Cloud session — verify on the rebased app that "Add key" works in pure-LAN before writing review notes).

---

## 6. PR sequencing plan

Mobile is **its own track** — none of these block, or are blocked by, the web/gateway release. Sequence so each PR is independently reviewable and the device-certification PR comes last.

| # | PR | Contents | Gate to merge |
|---|----|----------|---------------|
| **M0** | `chore(mobile): rebase serious app onto main` | The rebase of all 7 commits onto `origin/main`; resolve `messages.ts`; adopt `textOf()` everywhere `.content` is read; regenerate `bun.lock`. **No behavior change.** | `bun --filter @zintus/mobile typecheck` + existing tests green; CI green. |
| **M1** | `fix(mobile): on-device streaming via expo/fetch` | `chat.ts` swap to `expo/fetch`; add `chat.test.ts` mock-stream coverage. | Unit test green; **device check deferred to M5**. |
| **M2** | `fix(mobile): Android cleartext for LAN gateway` | `expo-build-properties` plugin (blanket flag first), then scoped `network_security_config.xml` LAN-only. iOS untouched. | Builds; reviewed config. |
| **M3** | `feat(mobile): consent revoke in Settings + Play AI report` | Wire `revokeProviderSendConsent()` toggle in `settings.tsx`; confirm/​add AI-output report affordance; version-key bump policy. | UI review. |
| **M4** | `chore(mobile): EAS project + submit profiles` | `eas init` projectId, `eas.json` submit block, `runtimeVersion`. **[HUMAN creds]** | EAS dev build succeeds. |
| **M5** | `release(mobile): EAS preview certification` | No code; an EAS **preview/internal** build + the §5 device checklist run on real iOS + Android. | Manual: streaming + cleartext + local-network prompt + persistence all verified on device. |
| **M6** | Store submission | Privacy URL, App Privacy / Data Safety forms, encryption-compliance counsel sign-off, reviewer notes + demo gateway. **[HUMAN]** | Apple + Play accept. |

Order rationale: **M0 must land first** (everything else is meaningless against a non-compiling rebase). M1–M3 are independent and can be parallel PRs once M0 is in. M4 is HUMAN-gated and can proceed in parallel. M5 is the truth gate — nothing is "done" until streaming + cleartext are proven on a real release build, which only M5 can do.

---

## 7. Risks

- **Divergence compounds daily (highest risk).** 80 behind today, growing. The longer M0 waits, the worse the `@zintus/types` adaptation and the more main commits touch shared packages mobile imports. **Do M0 now**; re-rebase if it sits more than a few days.
- **The type change is silent.** `ChatMessage.content` going `string → string | ContentBlock[]` produces zero *git* conflicts but TypeScript breakage scattered across mobile. Easy to under-scope M0. Mitigate: treat `typecheck` as the merge gate, grep every `.content` read.
- **Streaming "passes in dev, dies in release."** Both the `expo/fetch` fix AND its failure mode are invisible in Expo Go. Only M5 on a real EAS build certifies it. Do not call streaming fixed before M5.
- **Android cleartext blanket flag may draw Play scrutiny.** Ship blanket to unblock internal builds, but tighten to the scoped network-security-config before production submit.
- **Encryption export classification (`ITSAppUsesNonExemptEncryption: false`) is provisional.** x25519 E2E is not auto-exempt; needs counsel. Wrong value = submission pulled or legal exposure. **[HUMAN/legal]**
- **HUMAN-gated long-pole items**: Expo/Apple/Google accounts, `eas init` login, submit creds, privacy URL, demo gateway, encryption counsel. None are code; all block M4–M6. Start them in parallel with M0.
- **`feat/mobile-serious-app` is the only home of the real app** until M0 merges — keep the branch intact as the fallback; do not delete or force-push it during the rebase.

---

## Appendix — evidence (file:line, all on `feat/mobile-serious-app` unless noted)
- Divergence: `git rev-list --left-right --count origin/main...feat/mobile-serious-app` → `80  7`; merge-base `7c50799` = local `main`.
- Streaming break: `apps/mobile/lib/chat.ts:124` (global `fetch`), `:147-148` (no-body throw), `:155` `getReader()`, `:165` `reader.read()`. No `expo/fetch`/polyfill anywhere in `apps/mobile` (grep empty).
- Type change: `packages/types/src/route.ts:5-8` branch `content: string` vs `origin/main` `content: string | ContentBlock[]` + new `content.ts`/`content.test.ts`, `textOf`, `isContentBlockArray`, `sanitizeForLogs`.
- Direct file conflict: `apps/mobile/lib/messages.ts` edited by `origin/main:6a26517`; branch vs main diff confirmed.
- Android: `apps/mobile/app.json` — no `usesCleartextTraffic`, no `expo-build-properties` (grep empty).
- iOS ATS / encryption: `apps/mobile/app.json` ios.infoPlist `NSAllowsLocalNetworking:true`, `NSLocalNetworkUsageDescription`, `ITSAppUsesNonExemptEncryption:false` — present and correct.
- Consent: `apps/mobile/lib/consent.ts`; gate `app/index.tsx:374-388`; modal `app/index.tsx:686-731`.
- Gateway URL: `apps/mobile/lib/gateway-url-resolve.ts:5` `GATEWAY_PORT = 8788`, `resolveGatewayUrl()` priority saved→env→devHost→localhost.
- EAS: `apps/mobile/eas.json` `appVersionSource:"remote"`, no `submit` block; `app.json` no `extra.eas.projectId`/`owner`/`runtimeVersion`.
- Deps: `apps/mobile/package.json` `expo ~56.0.0` (ships `expo/fetch` streaming); no fetch polyfill / `react-native-sse` dep.
