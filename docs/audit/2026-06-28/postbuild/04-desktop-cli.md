# POST-BUILD VERIFICATION — DESKTOP + CLI (tool-calling)

Independent re-verification. Branch `feat/tool-calling`. READ-ONLY. Scope:
`apps/cli` `--tools <file>` wiring (index.ts on both `chat` and shorthand;
commands/chat.ts `loadTools` + engine threading + tool-call printing). Re-confirm
prior CLI findings (cloud status/logout, `--image`, Bun-only npm gap) and the
desktop keyring code-fix. Prior pass: `docs/audit/2026-06-28/05-desktop-cli.md`.

Bar: 10/10. Classifications: FIXED / OK / RISK / INEFFICIENT / [HUMAN].

---

## (1) `loadTools` validation — OK (robust), two minor holes RISK(low)

`apps/cli/src/commands/chat.ts:18-47`. Verified each failure mode yields a clear,
user-facing message (no parse stack), and all surface through the top-level
`program.parseAsync(...).catch` which `redactSecrets` + `exit(1)`
(`apps/cli/src/index.ts:334-338`):

- Unreadable file → `Could not read --tools file: <path>` (chat.ts:22-24). **OK**
- Invalid JSON → `--tools file is not valid JSON: <path>` (chat.ts:28-30). **OK**
- Non-array / missing fields → `--tools file must be a JSON array of
  { name, description, parameters } objects` via `Array.isArray` + `.every`
  (chat.ts:31-45). **OK**

**RISK(low) — `typeof parameters === "object"` accepts `null` and arrays**
(chat.ts:39). `typeof null === "object"`, so `{ name, description,
parameters: null }` (or an array) passes validation and is cast to
`ToolDefinition`. Not a crash here — it's forwarded to the adapter, which is where
a bad schema would actually fail (less clear error). Tighten with a
non-null-plain-object check.

**RISK(low) — empty array silently degrades to plain chat** (chat.ts:31-46 returns
`[]`; routeAndStream gets `tools: []`; `requiresTools` is false for length 0 —
`packages/types/src/route.ts:191-193`). A `--tools tools.json` containing `[]`
runs as a normal text turn with no signal that tools were ignored. Cosmetic.

Net: validation is robust against the three named cases (bad JSON / non-array /
missing fields) — clear errors, never a stack trace.

## (2) Engine-direct tool path surfaces `toolCalls` — FIXED / OK

End-to-end live-channel-by-reference, verified at every hop:

- Router collects per-chunk tool calls into one array `collectedToolCalls`
  (`packages/router/src/factory.ts:738`, pushed at `:754-755`) and returns **that
  same reference** as `toolCalls` (`factory.ts:847`).
- Engine forwards the router's `result.toolCalls` **by reference**
  (`packages/engine/src/engine.ts:844`; comment :841-843).
- CLI drains the text stream FIRST (`chat.ts:181-184`), THEN reads
  `result.toolCalls` (`chat.ts:189-196`). Because the array is the live reference
  the router fills as the stream drains, reading after the drain is correct — the
  ordering is load-bearing and the code gets it right.
- Print shape matches the type: `ToolCallContentBlock { id, name, arguments }`
  (`packages/types/src/route.ts:32-39`) → printed as
  `name({...args})  <id>` (chat.ts:190-195). Empty/absent array → nothing printed
  (guarded `result.toolCalls && .length > 0`). **OK** — honest, no auto-execute.

Threading is sound: CLI passes `tools` into `engine.routeAndStream`
(chat.ts:164-172); `EngineRouteRequest extends Omit<RouteRequest,"messages">`
(engine.ts:82) and `RouteRequest.tools` exists (route.ts:254); the engine spreads
`...request` into `router.routeAndStream` (engine.ts:755-757). Output is correctly
printed to **stderr** (chat.ts:190-192) so it never pollutes piped stdout text.

## (3) CODE-EFFICIENCY — one real asymmetry: RISK/INEFFICIENT

**RISK(medium-low) — cache READ not bypassed for tool requests** while the WRITE
side is. The engine never *writes* a tool-call turn to cache (correct —
`engine.ts:798`, guarded by `result.toolCalls?.length`). But the cache *read*
(`engine.ts:668`, `if (cache && !request.bypassCache)`) does **not** consider
`tools`. So a `--tools` prompt that matches a previously-cached *non-tools* answer
— L1 exact key (`engine.ts:681-688`), or L2 semantic at 0.12 distance
(`engine.ts:689-696`) — returns the cached **text** and never invokes the model,
yielding **zero tool calls** for a request that explicitly asked for them. The
read key omits `tools` entirely. Trivial fix: skip/scoped-bypass the cache read
when `requiresTools(request)` (the helper already exists, route.ts:191). Asymmetric
guard is the only correctness gap found in the new path.

Otherwise efficient: `loadTools` reads once (sync), validates once, no redundant
parse; tool-call array is forwarded by reference (no copy); no extra allocations.

**Coverage gap (not a bug):** there is **no unit test** for `loadTools` or the
tool-call printing branch. `apps/cli/src/commands/` has only
`chat-content.test.ts` (images), `cloud.test.ts`, `keys.test.ts` — none exercise
`--tools` validation or `result.toolCalls` rendering. The new code ships untested.

## (4) Re-confirmed prior CLI findings

| Item | Status | Evidence |
|---|---|---|
| Bun-only — `npm i -g zintus` breaks for Node | **STILL-OPEN [HUMAN/device]** | shebang `#!/usr/bin/env bun` (index.ts:1); `build` is `bun build … --target=bun` (package.json:39); `engines.bun >=1.1.0`, **no `node`** (package.json:19-21). No Node target / preflight added. |
| `cloud status` / `logout` honesty | **FIXED (unchanged)** | `cloud.ts` Bearer + tri-state + exit codes; relay session-scoped Bearer — not touched this round. |
| `--image` multimodal | **OK (unchanged)** | local, fail-fast, secret-safe; chat-content.test.ts covers helpers. |
| npm secret-safety / `files` allowlist | **OK (unchanged)** | `files: ["dist/cli.js","README.md","LICENSE"]` (package.json:10-14); build externalizes native deps + `--minify`, no `--sourcemap`. |

## (4) Desktop — keyring code-fix intact; still [HUMAN]/device-gated

Desktop unchanged this round (confirmed):

- Frontend calls the shipped Rust commands: `invoke("keyring_get"|"keyring_set"|
  "keyring_delete")` (`apps/desktop/lib/tauri.ts:38/52/61`). No plugin path remains.
- Service name matches both sides: Rust `const SERVICE: &str = "zintus"`
  (`src-tauri/src/lib.rs:12`) == gateway/CLI `const SERVICE = "zintus"`
  (`packages/keychain/src/storage.ts:6`). **FIXED (code).**

**Still [HUMAN] / device-gated (unchanged, cannot be certified here):**

- **Per-OS Tauri/Rust build** — the camelCase→snake_case invoke arg mapping
  (`providerId`→`provider_id`) and the real keychain write→read→gateway round-trip
  (macOS Keychain / Windows Credential Manager / Linux Secret Service) are proven
  by neither test nor compiler in `bun test`. Needs a clean-machine Rust build.
- **Signing / notarization** — STILL-OPEN: `tauri.conf.json` has no `signCommand`
  / `signingIdentity` / `certificateThumbprint` (grep empty). Requires real certs.

---

## VERDICT

The `--tools` path is wired correctly. `loadTools` gives clear, stack-free errors
for the three named bad-input cases (FIXED/OK), the engine→router→CLI tool-call
channel is forwarded by reference and read after the stream drains in the right
order, and the printed shape matches the type (OK). One real efficiency/correctness
asymmetry: the cache **read** is not bypassed for tool requests while the **write**
correctly is — an identical/semantically-near prior non-tools prompt can replay
cached text and drop the tool calls (RISK, trivial fix via `requiresTools`). Two
minor validation holes (`parameters: null`/array slips through; empty array
silently degrades) and a missing unit test for the new code. Prior findings hold:
cloud + `--image` FIXED, CLI remains **Bun-only** (npm-for-Node gap, [HUMAN]).
Desktop keyring code-fix intact but still **build-/cert-gated** ([HUMAN]).
