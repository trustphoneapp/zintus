# MOBILE agent report (a5aafaedec9027518)

## BRANCH REALITY (headline)
Serious mobile app NOT on this checkout. `feat/cross-surface-parity` = BASIC RN app. Rich version entirely on `feat/mobile-serious-app` (git diff: 26 files, +4497 lines, 18 files exist only there). Absent here: onboarding/history/projects/research screens, ChatMessageBubble, Markdown, ResponseFooter, lib/{attachments,consent,data-flow,chat-mode,route-options,provider-intel}.ts, BUILD-STATUS.md.
→ Every FEATURE-MATRIX mobile ✅ for stop(#3)/markdown(#7)/footer(#9)/history(#16)/PrivateMode(#18)/keyTest(#20)/file(#23)/voice(#25)/consent(#26)/report(#27)/research(#15)/projects(#17) UNVERIFIABLE here & confirmed ABSENT on-branch. CHECKLIST.md:68 honestly describes the real basic app.

## VERDICT
- iOS: NOT submittable. Streaming likely broken on-device (`chat.ts:78` response.body.getReader(), no RN stream polyfill) + no pre-send consent gate (Apple 5.1.2(i)).
- Android: NOT submittable. No usesCleartextTraffic/network-security-config → release build can't reach http LAN gateway → non-functional. + no AI report control (Play Gen-AI).

## DEAD/FAKE/MISSING (on-branch)
- Stop generation MISSING (index.tsx 282-311 only Send; chat.ts:28 accepts signal but UI never aborts).
- Image/file/voice input MISSING (no picker, no attachments.ts). Matrix file✅/voice🟡 are other-branch claims → matrix OVERSTATES.
- Consent gate MISSING (no lib/consent.ts). First msg hits 3rd-party provider, zero disclosure.
- Report-AI MISSING. Markdown/footer/history/projects/research MISSING (plain <Text> index.tsx:246).
- Provider key add DEAD in local-LAN: `gateway-key-push.ts:63-66` pushKeyToGateway requires Zintus Cloud session; resolveSessionId() null on pure LAN → save fails "Not connected to Zintus Cloud", local mirror only after cloud push (line 91). Providers "Add key" (providers.tsx:206) can't save in primary local-first path. **review-notes.md:54 tells reviewers to use this flow → rejection risk.**
- No standalone key TEST (only validate-on-save ProviderSheet.tsx:87).
- Remote SSE live feed no-ops: remote.tsx:106 typeof EventSource undefined in RN, no react-native-sse dep → live updates dead (one-shot fetch works). Honest degradation.

## P0/P1/P2
- P0 Streaming may be 100% broken on device: RN fetch no Response.body ReadableStream; chat.ts:74-78 throws "Gateway returned no response body". Fix expo/fetch or react-native-fetch-api+polyfill-globals. No unit test covers (passing test only checks URL resolution). NEEDS DEVICE confirm, high confidence.
- P0 Android cleartext: no usesCleartextTraffic in app.json → API28+ release blocks http://LAN:8788. Fix expo-build-properties android.usesCleartextTraffic:true (or scoped RFC1918 config). Won't show in dev client.
- P0 No consent gate (Apple 5.1.2(i)). Port lib/consent.ts + pre-send modal.
- P1 Play Gen-AI report control missing.
- P1 Providers key flow misleads local users/reviewers.
- P1 VALIDATE_URL default http://localhost:3000 (limits.ts:12) = phone itself on-device; works only via createProvider().validateKey fallback (validate.ts:23).
- P2 unbounded 5s health poll (index.tsx:58) not AppState-scoped → battery. P2 Copy uses Share not clipboard.

## ATS/CLEARTEXT
- iOS correctly configured ✅: app.json:13-19 NSAllowsLocalNetworking:true + usage desc → reaches http LAN. ITSAppUsesNonExemptEncryption:false set (counsel-gated, x25519 not auto-exempt).
- Android NOT configured 🔴 — biggest Android blocker.

## EAS BLOCKERS
- No projectId (absent app.json/eas.json; appVersionSource:"remote" requires it) → eas build fails. Run eas init (Expo login [HUMAN]).
- No submit block in eas.json → no Apple ASC id / Google SA JSON. [HUMAN].
- Bundle IDs com.zintus.app (both), scheme zintus, icons real-sized (notification-icon.png 216B maybe stub).

## COMPETITOR GAPS: no stop, no image/voice/file, no markdown render, no history/persistence (vanish on tab switch), no projects/research. = single-screen text-chat demo.

## HUMAN: Xcode+CocoaPods (env CLI-only), Apple/Play accounts, eas init login, submit creds, encryption-export counsel, live privacy URL + demo gateway. DECISION: ship basic branch or merge feat/mobile-serious-app (which has own [HUMAN]/EAS items) before store push.
