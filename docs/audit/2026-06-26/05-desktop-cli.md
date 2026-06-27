# DESKTOP + CLI agent report (a8ba9995a90bdcc24)

## VERDICTS
- DESKTOP NOT launch-grade. Biggest blocker: BYOK key entry 100% NON-FUNCTIONAL + architecturally disconnected. Not standalone (keys must be set via CLI). + unsigned all-OS, stub icons, no native menu.
- CLI near-launch but walled: npm secret-safe + exit codes sound, BUT requires Bun (npm i -g zintus → Node users get env: bun: not found), cloud status/logout broken, --json only 2 cmds, no completion.

## DEAD/FAKE/MISLEADING
1. **Keyring fully DEAD (P0):** lib/tauri.ts:13,28,36 calls tauri-plugin-keyring-api (plugin:keyring|*) but Cargo.toml:16-21 has NO tauri-plugin-keyring (only keyring/pty/updater), lib.rs:59-60 registers only pty+updater, capabilities/default.json:6 grants no keyring:default. Custom keyring_get/set/delete (lib.rs:11-34) ORPHANED — nothing invokes (only default_shell, TerminalPane.tsx:16). ProvidersScreen.tsx:83 "Save to keyring" THROWS; hasKey always "No key".
2. **Service mismatch (P0):** desktop "com.zintus.desktop" (tauri.ts:3, lib.rs:5); gateway/CLI keychain "zintus" (packages/keychain/storage.ts:6). Even if plugin existed, desktop keys invisible to chat path.
3. **No key→gateway sync exists** (grep none apps/desktop). STORE-READINESS.md:116 claims keys "pushed to gateway as x25519 ciphertext via relay" — CODE DOES NOT EXIST. Doc fiction.
4. **Fake Find:** AppShell.tsx:75-79 ⌘⇧F just router.push("/chat") no search UI. DOC drift: RELEASE-CHECKLIST.md:189-191 says ⌘N/⌘,/⌘⇧F "not present" but ARE present as JS keydowns AppShell.tsx:64-83.
5. **Export unverified:** ChatPanel.tsx:226-233 + research/page.tsx:104-111 Blob+a.download, no fs/dialog plugin → likely silent no-op in WKWebView. Matrix #29 🟡 confirmed.
6. Updater dead surface (compiled+registered+granted, no plugins.updater block, no JS caller — inert, removable).
7. Private Mode no honesty badge (ChatPanel.tsx:294-312 sends block_training, no "not honored" state).
8. **CLI cloud misreports:** cloud.ts:175-196 always "offline" (relay route cookie-auth ignores Bearer); cloud.ts:228-237 logout never revokes server session.

## P0/P1/P2
DESKTOP:
- P0-1 Keyring · app non-functional standalone · tauri.ts/Cargo.toml/lib.rs:59-66/capabilities:6/storage.ts:6 · Fix repoint tauri.ts to invoke("keyring_get/set/delete") (Rust cmds exist) + align SERVICE="zintus", OR build x25519 push to gateway · Test packaged build save→restart→chat · NEEDS RUST BUILD.
- P0-2 (HUMAN) Signing unsigned macOS, no Windows signCommand.
- P1 real 1024² icon + tauri icon; no native menu (no MenuBuilder lib.rs); verify/replace Blob export.
- P2 remove updater plugin+perm; no UI to set gateway token (gateway.ts:5 build-time NEXT_PUBLIC_GATEWAY_TOKEN only); RouteOptionsPanel.tsx:84-108 advisory-only (renders <li>, no switch/compress action).
CLI:
- P1 Bun-only (package.json:7,39, index.ts:1) — npm i -g breaks for Node; documented README:13-16 but still breaks. Add runtime preflight or node build.
- P1 cloud status/logout misleading (relay-side fix).
- P2 --json only research + keys list; status.tsx Ink needs TTY (breaks piped/CI); no shell completion.

## PER-OS (all need Rust build + clean machine): macOS ✅universal/default menu/keyring DEAD/pty→$SHELL/unsigned · Windows ✅msi+nsis/default/keyring DEAD CredMgr/→COMSPEC/unsigned NO signCommand · Linux ✅deb/rpm/appimage/default/keyring DEAD SecretService/→$SHELL/needs WebKitGTK4.1+FUSE.

## NATIVE MENU SPEC (lib.rs MenuBuilder): App{About, Preferences⌘,, Quit⌘Q}; File{New Chat⌘N}; Edit default; View{Find⌘⇧F→real search}; Window{Minimize,Zoom,Close⌘W}. Wire events→webview nav.

## TAURI ORIGIN/PNA: CSP connect-src (tauri.conf.json:24) localhost:8787/8788 + 9 provider hosts, but desktop ONLY calls gateway (grep no direct provider fetch) → provider hosts VESTIGIAL. On packaged build verify gateway CORS/PNA accepts tauri://localhost (prod) origin not just localhost:3001 (dev).

## CLI npm SAFE: files:["dist/cli.js","README.md","LICENSE"] allowlist → only minified bundle; no src/*.test.ts/.map (no --sourcemap)/.env. keys list --json masked only (keys.ts:82-83 {provider,masked}); doctor masks (doctor.ts:91); top catch redacts (index.ts:299 redactSecrets). NO LEAK. Exit(1) on failure across keys/research/doctor/chat + top catch — good. Errors chalk strings to stderr NOT JSON envelope. --json missing status/doctor/projects/history/trace/cloud.

## COMPETITOR GAPS: Desktop vs Claude/ChatGPT/Cursor: no working in-app key entry; no native Preferences/New/Find; no auto-update; export likely no-op vs real Save; requires separate zintus serve (rivals self-contained). CLI vs Claude Code/Gemini/OpenAI: Bun-only; no completions; no agentic file-edit/tool loop (single-turn stream); thin --json; unreliable cloud status.

## HUMAN: Apple Developer ID+notarization; Windows cert + add signCommand; clean-machine installs per OS; RUST BUILD to verify keyring fix/PTY/export/menu/CSP-PNA; real 1024² icon (current icon.icns 12.6KB/icon.ico 1981B/32x32.png 104B below RELEASE-CHECKLIST §1 bar despite FEATURE-MATRIX.md:57 claiming "real multi-res icons").
