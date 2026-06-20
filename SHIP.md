# SHIP — Zintus product-readiness pass

Single-pass hardening of the existing MVP. No speculative features added. Branch:
`cursor/zintus-full-stack-implementation`. **Not committed** (per request).

## Release verification — 10-step manual smoke (fresh Mac)

Runnable end-to-end; proves the lane works. Needs Bun (and Docker for step 1).

1. **Container boots:** `docker compose up -d` → `curl -s localhost:8788/health` returns `{"ok":true,...}` (HTTP 200).
2. **Web up:** `zintus serve` (or `bun run dev:gateway`) + `bun run dev:web` → open `http://localhost:3000/chat`. Stop the gateway and the web/desktop/mobile clients show a "Gateway offline — run `zintus serve`" banner.
3. **Add keys:** `bun run dev:cli -- keys set groq <key>` (repeat for `gemini`, `cerebras`). `keys list` shows them.
4. **Strategy actually routes:** in Settings pick **economy**, send a prompt; then **fastest**, send again → the winning provider differs (check the network POST body has `"strategy"`, and `X-Provider-Used` in the response).
5. **Cache hit:** send the *same* prompt twice → 2nd response header `X-Cache-Hit: L1` (auto-routed; see the get/set key fix).
6. **Failover + cooldown:** force a Groq 429 (exhaust it or set a tiny `requestsPerMinute` in `policy.json`) → response `X-Failover-Count: 1`, winner is the next provider; next request skips the cooled-down one.
7. **Trace list:** `curl -s "localhost:8788/v1/traces?limit=5"` returns recent traces with attempts + failover; the web **/usage** "Recent requests" table shows the same.
8. **Savings + offline honesty:** `/usage` shows "Estimated saved"; stop the gateway → mobile shows **"Gateway offline — quota unknown"** (no fake zeros).
9. **Load smoke:** `bun run smoke:gateway` exits 0 with `/health p95 < 500ms PASS`.
10. **Optional live:** with `GROQ_API_KEY` + `GEMINI_API_KEY` set, `bun run test:live` passes (skips cleanly without keys).

Automated gate: `bun run typecheck` (0) · `bun run test` (0 fail) · `cd apps/web && bun run build` · `cd apps/desktop && bun run build`.

## Verification (all green)

```bash
bun install
bun run typecheck   # 0 errors (root build + web/desktop/mobile)
bun run test        # 95 pass / 0 fail (16 vitest + 77 + 2 bun)
cd apps/web && bun run build   # Next.js production build OK (11 routes)
```

Manual smoke: gateway boots, `GET /health` returns provider status, a chat
request streams through the engine, the error path returns cleanly (a stale
invalid Groq key in the OS keychain produced a graceful `400`, not a crash), and
`Access-Control-Expose-Headers` advertises the routing-metadata headers.

## What changed

### P0 — correctness
- **Non-Groq cooldown bug fixed** (`packages/router/src/factory.ts`). Cooldown
  was gated on a Groq-specific `isLastGroqModel`, so every other provider hit
  `continue` and was never cooled down — a rate-limited Gemini/OpenRouter/Cohere
  got re-picked every request. Now keyed on `isLastModel` (last model for *any*
  provider), so a 429/5xx cools the provider down via the existing exponential
  backoff while preserving Groq's 70B→8B in-request retry and `x-ratelimit-*`
  header handling. New `factory.cooldown.test.ts` (non-Groq + Groq paths).
- **Desktop routing duplication removed.** Deleted `fallback-router.ts` (a full
  parallel router with its own localStorage quota), `quota.ts`, and `router.ts`.
  Desktop is now gateway-only: status from `/health`, chat via the gateway, real
  token accounting from the engine. No second router to drift.
- **Mobile/web strategy labels fixed.** `fastest` was described as economy's
  behavior ("most remaining quota"). Web + mobile now match the router and CLI:
  fastest = provider-priority order, capability = most-capable models, economy =
  most remaining quota.

### P1 — gateway hardening & feature exposure
- Bearer auth wired end-to-end: web/desktop/mobile send `Authorization: Bearer`
  when their `*_GATEWAY_TOKEN` is set (gateway already enforced it).
- Request limits: body size + message count → `413`, time-to-first-token → `408`
  (`GATEWAY_MAX_BODY_BYTES` / `GATEWAY_MAX_MESSAGES` / `GATEWAY_REQUEST_TIMEOUT_MS`).
- `virtual_key` + `provider_weights` exposed on `/v1/chat/completions`.
- Response headers `X-Provider-Used` / `X-Cache-Hit` (L1/L2/miss) /
  `X-Failover-Count`, exposed via CORS. Engine now surfaces `cacheHit` +
  `failoverCount`.
- Web `/api/chat` stays a `503` stub; no router/engine bundled into Vercel.
- New gateway tests: bearer reject/accept, 413 (body + messages), 408, headers,
  key passthrough.

### P2 — honest docs
- README "removed semantic cache" note replaced with the real **L1 SHA-256 + L2
  sqlite-vec** cache behavior, plus a "Production readiness" section and the new
  gateway API/limits.
- CHECKLIST rewritten: 12 providers (was "8"), accurate per-platform quota
  storage (**no Tauri rusqlite** — desktop reads `/health`), "PRODUCTION ✅"
  downgraded to honest MVP/🟡/❌.
- ROADMAP marks shipped phases (cache, weighted routing, virtual keys,
  checkpoints, `consolidateFactsWithLlm`) vs. still-planned (`policy.json`
  hot-reload). CONTRIBUTING's stale "we removed the cache" rule corrected.

### P3/P4 — tests, CI, cleanup
- Opt-in env-gated live E2E (`bun run test:live`, skips without `GROQ_API_KEY`);
  default suite stays fully offline.
- Removed the demo `greet` Tauri command. Verified `listProviders()` = 12.
- Added `apps/mobile/.env.example`; documented `NEXT_PUBLIC_GATEWAY_TOKEN` and
  the gateway limit vars.

### P5 — web UI redesign (informed by competitor teardown)
- Removed the separate full-width provider rail; provider selection is now a
  **chip + popover inside the composer** (`ProviderPicker`).
- **Stop button** now rendered while streaming (the abort logic already existed
  but was never surfaced); `Esc` also stops.
- **Copy / Regenerate** message actions (hover-revealed, after the bubble).
- Empty state is now **example-prompt cards** instead of a CLI paragraph.
- Sidebar gains **New chat** + Main/Dev sections; gateway status consolidated to
  one place (sidebar footer) with the URL.

## Remaining for an actual store/native release (none block gateway+web)
- Live API keys (add via CLI `keys set` / web vault / mobile SecureStore).
- EAS `projectId` (`eas init`), App Store / Play credentials in `eas.json`.
- Tauri code signing (`TAURI_SIGNING_*`), deployed worker `WORKER_VALIDATE_URL`.
- Branded app icons.
- Post-ship: load/abuse testing.

## Mobile / iOS readiness (this pass)

Made the Expo app actually buildable, not just typecheck-clean:
- **`app.json` completed**: `ios.bundleIdentifier` + `android.package`
  (`com.zintus.app`), app icon, adaptive icon, branded splash
  (`expo-splash-screen`), and the `expo-notifications` plugin. Added iOS
  **App Transport Security** exceptions (`NSAllowsLocalNetworking` +
  `NSLocalNetworkUsageDescription`) so the app can reach a LAN/HTTP gateway, and
  `ITSAppUsesNonExemptEncryption=false` for TestFlight.
- **Fixed the bundle** (Metro), which typecheck never exercised: declared
  babel/runtime deps that bun's isolated `node_modules` hid
  (`@babel/plugin-transform-react-jsx`, `@babel/core`, `react-native-worklets`,
  `react-native-css-interop`, `expo-splash-screen`) and made `metro.config.js`
  monorepo-aware with a `.js`→`.ts` resolver for the shared `@zintus/*`
  packages.
- **Verified by bundling**: `expo export` succeeds for **iOS (1810 modules →
  Hermes `.hbc`)** and **Android (1811 modules)**; `expo config` validates.

Still required for an installable binary (need machine/account I don't have
here): full **Xcode.app** + a simulator runtime + **CocoaPods** for a local iOS
build (this box only has Command Line Tools), and **`eas init`** (Expo login) to
mint the `projectId`, then signing/store credentials in `eas.json`. I did **not**
boot it in a simulator — no Xcode in this environment.

Run it yourself:
```bash
cd apps/mobile
bun run start            # dev server; press i (needs Xcode) / a (needs Android SDK)
# or a full local build:
npx expo run:ios         # needs Xcode + CocoaPods
```

## Terminal / CLI — cross-OS (this pass)

Two audit agents (CLI + desktop terminal) surfaced concrete cross-OS breakage;
applied the safe fixes:

**Web `/terminal` is now a real command console** (works on any OS via the
browser, talks only to the gateway): `help`, `status`, `keys`, `models`,
`history`, `trace`, `gateway`, `clear`, `version`, and `chat <msg>` (bare text
still sends a chat). Up/down arrow command history. Mirrors the `zintus`
CLI. Cleaned up the terminal-line store model. Verified: web build OK, the
gateway `/v1/models` and `/v1/threads` it calls return 200.

**CLI cross-platform fixes:**
- **Windows `HOME` bug** — `${process.env.HOME ?? "."}` is undefined on Windows,
  so DB files scattered into the cwd. Fixed in 5 files (router/factory,
  engine, conversation-store, cache, memory-store) to use
  `join(homedir(), ".zintus", "<db>")`.
- **Headless-Linux keychain** — `keys set` threw an opaque native error when no
  Secret Service is running. Now throws an actionable message; the convenience
  manifest write is best-effort so it never hard-fails. (`packages/keychain`)
- Fixed a hardcoded `~/.zintus/config.json` message to print the real path.

**Desktop terminal cross-OS:**
- Hardcoded `/bin/zsh` broke Linux and ignored `$SHELL`. Added a Rust
  `default_shell()` command (Windows→`COMSPEC`/PowerShell, macOS→`$SHELL`/zsh,
  Linux→`$SHELL`/bash) and call it from `TerminalPane`; per-OS JS fallback too.
- WebGL addon now disposes on `onContextLoss` (DOM-renderer fallback on
  Linux/VM GPUs); PTY errors are logged instead of swallowed; removed the unused
  `lib/terminal.ts` scaffold (same bug, dead code).

**Still must-verify on a real desktop build (no Rust toolchain here):**
- PTY: `tauri-pty` JS `^0.1.1` + `tauri-plugin-pty` Rust `0.3` is the
  **conventional Tauri-v2 pairing** (the version numbers aren't meant to match);
  `TerminalPane.tsx` uses the correct API (`spawn`/`onData`/`write`/`resize`/
  `kill`). Just needs a real `bun tauri dev` to confirm at runtime.
- Desktop keyring TS uses `tauri-plugin-keyring-api` while the Rust side exposes
  custom `keyring_*` commands — reconcile to one mechanism when building.

**CLI packaging note:** `bin` points at `src/index.ts` with a `#!/usr/bin/env
bun` shebang and the engine imports `bun:sqlite` — so the CLI requires **Bun**
and `bun run`/`bun link` (a plain `npm i -g` + node shim won't work on Windows).
Documented as a Bun runtime requirement.

## Recommended first platform
**Gateway + Web (Vercel)** — fully wired, builds clean, no native signing/store
process. **Gateway + CLI** is an equally solid alternative (the CLI is the most
complete client). Desktop/mobile follow once signing + store credentials land.

## Competitor research (future work, not in scope now)
A teardown of LiteLLM, OpenRouter, Portkey, Helicone, Cloudflare/Kong/Envoy,
TensorZero, RouteLLM, etc. fed ROADMAP "Phase 4": same-model multi-provider
failover (model groups), PeakEWMA/P2C latency routing, token/cost budgets +
tiers, context-window/content-policy fallbacks, OpenTelemetry tracing, and
content-aware cost/quality routing. Zintus's native L1+L2 cache and
single-binary SQLite ledger (no Postgres/Redis) are genuine differentiators to
keep.
