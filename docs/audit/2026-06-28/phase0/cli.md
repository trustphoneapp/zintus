# Phase 0 From-Disk Audit — CLI (`apps/cli`)

Date: 2026-06-28 · Branch: `feat/zintus-10-10` · Scope: read-only, from actual code.
Column owner: **CLI**. Context: `docs/ROADMAP-10-10.md` — "CLI must surface the same
TRUTHS in text (provider, route reason, tokens, quota, privacy, cost, tools, files/images)."

Legend: ✅ real & surfaced · 🟡 partial / weak / placeholder · ❌ missing · 🔒 n/a for this surface.

---

## Capability matrix

| Capability | CLI | Evidence (file:line) |
|---|---|---|
| chat | ✅ | `src/commands/chat.ts:70` (runChat), registered `src/index.ts:60` + bare-prompt shorthand `src/index.ts:108`; streams raw chunks `chat.ts:186-189` |
| markdown (terminal) | ❌ | output is raw token passthrough `chat.ts:187` `process.stdout.write(chunk)`; no markdown renderer (no marked-terminal/ink-markdown anywhere) |
| image input | ✅ | `--image` repeatable, max 4 — `index.ts:70-75` (chat) & `index.ts:116-121` (shorthand); `loadImages`/`processImage` `chat-content.ts:80-96`; EXIF strip + base64 never logged `chat-content.ts:1-11`; vision-capability error `chat-content.ts:106-118` |
| file input | 🟡 | no generic `--file`; only codebase context `--code/--workspace` `index.ts:65-68` and working git diff (`--no-diff`) `index.ts:69`, applied `chat.ts:140-156` |
| voice | 🔒 | n/a (no audio surface in CLI) |
| tool calling | ✅ | `--tools <file>` `index.ts:76-79`; `loadTools` validation `chat.ts:18-52`; passed to engine `chat.ts:169-177`; toolCalls printed `chat.ts:194-201`. Honest: CLI does NOT auto-execute (`chat.ts:192` comment) |
| structured output | ❌ | engine supports it (`packages/engine/src/engine.ts:131-151` `structuredOutput`/`parsed`) but CLI exposes **no** `responseFormat` flag. (`--json` on research/keys/cloud is output formatting, not model structured output) |
| deep research | ✅ | `research` cmd `src/commands/research.ts:24`; `deepResearch` w/ cited sources, `--depth`, `--json` `index.ts:84-106`; needs `TAVILY_API_KEY`/`SERPER_API_KEY` `research.ts:28-37` |
| compare | ❌ | no compare/side-by-side command exists |
| projects | ✅ | full CRUD + active marker `src/commands/projects.ts`; instructions folded into user turn `chat.ts:163-165`; registered `index.ts:181-233` |
| provider keys | ✅ | `keys set/list/test/remove` `src/commands/keys.ts`; registered `index.ts:144-179` |
| BYOK vault | ✅ | OS keychain via `@napi-rs/keyring`/`@zintus/keychain` (`keys.ts:2`); cloud BYOK key-push decrypt-to-keychain `serve.ts:127-167`; README "Security" |
| local runtime | ✅ | ollama/lmstudio honored as forced/fallback `chat.ts:93-98`; doctor probes Ollama `doctor.ts:104-121`; `keys test` treats local as keyless `keys.ts:108-111` |
| routing strategies | ✅ | `config` wizard fastest/capability/economy `src/commands/config.ts:12-31`; `isRoutingStrategy` `src/lib/config.ts:26` |
| route reason | ❌ | chat prints only "Routed to `<name>` · trace `<id>`" `chat.ts:182-184` — no WHY. `trace` shows winner + attempts `history.ts:38-53` but `RequestTrace` has **no reason field** (`packages/types/src/trace.ts:12-19`). `failoverCount` exists on result (`engine.ts:123`) but is never printed |
| quota display | 🟡 | only in `status` dashboard `status.tsx` `QuotaBar`; denominator is a **placeholder 1_000_000** from `PROVIDER_META` (`src/lib/router.ts:21`) when provider reports no `tokensLimit`. Chat path shows no quota; `engine.getQuotaRemaining` (`engine.ts:168`) unused by CLI |
| compression savings | 🟡 | chat prints "Estimated saved vs paid APIs $X (est.)" `chat.ts:207-211` = **cost** estimate, not compression/token savings. `compileTokenEstimate` (`engine.ts:119`) never surfaced |
| usage / activity | 🟡 | live `status` tokensToday per provider `status.tsx:50`; `history` lists threads `history.ts:8-19`; `trace` attempts. No aggregate usage/cost-over-time report (data is in quota.db) |
| model catalog | ❌ | no `zintus models`. `packages/providers/src/provider-metadata.ts` & `pricing.ts` exist but CLI imports only `listProviders` for name/color/priority (`router.ts:18-26`) |
| pricing catalog | ❌ | `packages/providers/src/pricing.ts` never imported by CLI; no pricing command/output |
| OpenAI-compatible API | 🔒 | n/a directly; CLI launches the gateway that serves it — `serve` → `startGateway` `serve.ts:196` |
| account / auth (cloud/remote) | ✅ | `cloud login/status/logout` `src/commands/cloud.ts`; `remote` URL+QR `src/commands/remote.ts`; `serve --cloud/--remote` `index.ts:258-259`, `serve.ts:84-186` |
| security | ✅ | keychain storage; top-level error redaction `index.ts:336`; image EXIF strip; 0600 file perms (`config.ts:23`, `cloud.ts:55-57`); doctor checks keychain + db perms `doctor.ts:46-81` |
| observability | 🔒 | OTel lives in engine (`packages/engine/src/otel.ts`); CLI surfaces local traces via `trace` only |
| billing / paid overflow | 🟡 | `serve --managed/--pro` fetches Pro tier + token usage + 80% warning `serve.ts:58-80`. No standalone billing command; chat path has no paid-overflow indicator |
| referral / node marketplace | ❌ | nothing in CLI |

---

## Specific findings

### (1) Are `--tools` and `--image` real? — YES, both genuinely implemented.
- `--image`: repeatable collector `index.ts:36-38`, max-4 enforced `chat-content.ts:81`, processed via `@zintus/media` Node path (magic-byte mime + EXIF strip), over-size **rejected** not silently passed (`chat-content.ts:74-96`). Image bytes/base64 never enter logs or thrown messages (`chat-content.ts:1-11`, `39-70`). Router enforces a vision-capable provider or returns an honest capability error (`chat-content.ts:106-118`).
- `--tools`: loads & validates a `ToolDefinition[]` JSON file (`chat.ts:18-52`, rejects `null`/array `parameters`), routes to a tool-capable model, prints any returned tool calls (`chat.ts:194-201`). Honestly does **not** auto-execute tools.

### (2) Cloud / remote / account commands — present and notably honest.
- `cloud login` browser+poll flow, stores `~/.zintus/cloud.json` 0600 (`cloud.ts:70-157`).
- `cloud status` reports `unknown` (not a false "offline") when the relay is unreachable or rejects creds, exits non-zero (`cloud.ts:199-231`) — good truth discipline.
- `cloud logout` revokes server session then always clears local creds; flags orphaned sessions (`cloud.ts:280-348`).
- `remote` shows dashboard URL + optional QR (`remote.ts`). `serve --cloud` relays via E2E keypair (`serve.ts:84-186`).
- No standalone `account`/plan command; billing only appears as a side-effect of `serve` (`serve.ts:222-232`).

### (3) Is the CLI Bun-only? — YES, hard Bun-only at the deepest layer. **Distribution P0.**
- Shebang `#!/usr/bin/env bun` (`src/index.ts:1`).
- Build targets Bun: `bun build … --target=bun --outfile=dist/cli.js` (`package.json` scripts.build).
- `engines` declares **only** `"bun": ">=1.1.0"` — no `node` (`package.json`).
- `doctor` asserts Bun ≥1.2 (`doctor.ts:31-39`) and uses `Bun.file` (`doctor.ts:126`); `serve` uses `Bun.serve` (via `@zintus/gateway`).
- Core dependency `@zintus/engine` imports `bun:sqlite` + `drizzle-orm/bun-sqlite` (`packages/engine/src/conversation-store.ts:5-7`) — under Node this **throws at module load**, so any non-trivial command fails.
- Yet README leads with `npm install -g zintus` (`README.md:8`) and the package keywords include `npm`. The PATH shim installs, but the binary cannot run under Node. There is an honest warning (`README.md:13-16`), but the headline is misleading. **`npm install` for a Node user is effectively broken.**

### (4) Does the CLI expose model catalog / pricing / quota / route-reason?
- Model catalog: ❌. Pricing: ❌ (`pricing.ts` exists in `@zintus/providers`, never wired in).
- Quota: 🟡 only in the `status` TUI, with a fabricated 1,000,000 ceiling when no real limit is known.
- Route reason: ❌ never surfaced — only the chosen provider name + an 8-char trace id.

### (5) False / overstated claims
- **`npm install -g zintus`** as the primary install path (`README.md:8`) while the runtime is hard Bun-only — misleading for Node users.
- **"route chat, code, and agent workloads"** (`package.json` description, README:3) — "agent" overstates capability: tools are surfaced but never executed; there is no agent loop (`chat.ts:192`).
- **`status` QuotaBar denominator = 1,000,000** placeholder (`router.ts:21`) — when a provider reports no `tokensLimit`, the bar fill and `used/limit` figure are meaningless but rendered as if real (`status.tsx:50`, `16-30`).
- "Estimated saved vs paid APIs" is labeled `(est.)` (acceptable), but it is a cost estimate, not the "compression savings" truth the roadmap calls for — that truth is absent.

---

## Brutal P0–P3 toward 10/10

### P0 — blockers
1. **Node/npm packaging is broken.** Either ship a Node-compatible build (swap `bun:sqlite`→`better-sqlite3`/`node:sqlite`, `Bun.serve`→node `http`, `Bun.file`→`fs`, drop the `bun` shebang) **or** ship a self-contained `bun build --compile` binary so users need no Bun runtime. Until then, stop advertising `npm install -g zintus` as the primary path. (`package.json`, `README.md:8`, `conversation-store.ts:5`, `index.ts:1`)
2. **Surface the per-request TRUTHS in `chat`.** Today output = provider name + trace id only. Add: route **reason** (strategy/quota/failover — `failoverCount` already on the result `engine.ts:123`), provider-reported **input/output tokens** (`TokenUsage` on the stream result `packages/types/src/stream.ts:56-57`), and a **cost** estimate from `pricing.ts`. (`chat.ts:182-211`)
3. **Honest quota readout.** Remove the fabricated 1,000,000 denominator (`router.ts:21`); show the real `tokensLimit` or explicitly "no published limit", and surface `engine.getQuotaRemaining` (`engine.ts:168`) in chat/status. (`status.tsx`, `router.ts:28-41`)

### P1 — high value
4. **`zintus models` + `zintus pricing`** wired to `@zintus/providers` `provider-metadata.ts`/`pricing.ts` — zero catalog/pricing surfacing today.
5. **Usage/activity report** (`zintus usage`): aggregate tokens/requests/cost per provider over time from quota.db, beyond the live `status` snapshot.
6. **Add `reason` + `failoverCount` to `RequestTrace`** (`packages/types/src/trace.ts:12`) and print them in `trace` + chat.
7. **Markdown terminal rendering** for chat output (currently raw chunks `chat.ts:187`).

### P2 — completeness
8. **Structured-output flag** (`--format json` / `--json-schema <file>`) exposing the engine's `structuredOutput` verdict + `parsed` (`engine.ts:131-151`).
9. **`compare` command** (multi-provider side-by-side answer/latency/cost).
10. **Generic `--file <path>`** attachment beyond images and git diff.
11. **Honest billing/paid-overflow indicator in the chat path**, not only in `serve` (`serve.ts:58-80`).

### P3 — polish / messaging
12. Fix README/package.json: de-emphasize npm until a Node build exists; drop "agent workloads" until an agent loop ships.
13. Surface referral / node-marketplace truths if they are part of the product (absent today).
