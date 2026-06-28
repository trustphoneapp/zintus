# Post-Build Coverage + Doc-Honesty Audit — 2026-06-28

*Branch `feat/tool-calling`. Committed HEAD is `6bcd097` (the multimodal work);
**the tool-calling / structured-output / image-mapper / CSP-nonce work is
UNCOMMITTED in the working tree** (`git diff main --stat` = 184 files, +14127).
The 2026-06-28 `VERDICT.md` and `FEATURE-MATRIX.md` were written against the
*committed* state, where tools/structured were absent — so they now lie. READ-ONLY
audit.*

---

## 1. New-capability coverage map (the six paths asked about)

| # | Path | Source | Status | Evidence |
|---|------|--------|:------:|----------|
| 1 | Tool-call streaming fragment edge cases (provider/OpenAI) | `packages/providers/src/utils.ts` `parseOpenAiSseStream` | **TESTED** | `utils.test.ts:71` split-across-fragments, `:125` two parallel by index, `:167` malformed JSON → `{}`, `:202` plain stop leaves text intact |
| 2 | Gemini `functionResponse` round-trip | `packages/providers/src/providers/gemini.ts` | **TESTED** | `gemini.test.ts:94` tool_call→functionCall + tool_result→functionResponse w/ resolved name, `:145` id-parse fallback, `:287` parse functionCall→toolCall, `:347` missing args→`{}` |
| 3 | Structured repair-loop **exhaustion** | `packages/engine/src/engine.ts:511-598` | **TESTED** | `engine.structured.test.ts:162` "(c) still invalid after exhausting repairs → valid false, parsed undefined", asserts `repairAttempts===2`, `calls()===3` |
| 4 | Gateway structured **422** | `apps/gateway/src/handler.ts:711-723` | **TESTED** | `handler.test.ts` "(b) strict json_schema invalid → 422 structured_output_invalid", "(c) explicit non-json_schema + strict → 422 unsupported_capability" |
| 5 | **Web SSE tool accumulation** | `apps/web/lib/gateway.ts:583-662` (`toolCallsByIndex`) | **UNTESTED** | No `apps/web/lib/gateway.test.ts` exists; zero `*.test.ts` reference `toolCallsByIndex`/`tool_calls`/`accumulat` under `apps/web` |
| 6 | **CLI `--tools`** | `apps/cli/src/commands/chat.ts:18` `loadTools`, `:164-191`; wired `index.ts:56,77,123` | **UNTESTED** | `loadTools` is not exported; `chat-content.test.ts` has only `loadImages`/`buildChatContent`/`normalizeChatError` — no tool test anywhere in `apps/cli` |

Paths with **NO test: #5 (web SSE tool accumulation) and #6 (CLI `--tools`).**
Bonus untested capability shipped in the same tree: **CSP nonce**
(`apps/web/proxy.ts` `buildCsp`/nonce gen/Report-Only toggle/dev `unsafe-eval`
carve-out) — no `proxy` test, no test references `nonce`/`Content-Security`.

### Worst gap (ranked)
1. **Web tool-call reassembly (`apps/web/lib/gateway.ts:583-662`)** — the *same*
   fragile index-keyed delta→`ToolCallContentBlock[]` reassembly that is carefully
   tested for the provider side (`utils.test.ts`) is **re-implemented untested** in
   the user-facing web client. Worst because it is duplicated, fragile, and on the
   primary surface.
2. **CLI `loadTools` + `--tools` + tool-call render** — all error paths (file read,
   non-JSON, non-array, bad shape `chat.ts:23,29,43`) and the `runChat` tools
   wiring are untested though sibling CLI flows (`keys`, `cloud`, content) are.
3. **CSP nonce (`proxy.ts`)** — untested AND (per design `09-…`) **not yet
   browser-verified**; must not be marked "done/verified" anywhere.

## 2. False-comfort / asserts-too-little
- Gateway tool/structured tests (`handler.test.ts` §"tool / function calling",
  §"structured") drive a **stubbed engine returning canned `toolCalls`/
  `structuredOutput`** — they certify the *wire shape* (delta.tool_calls,
  finish_reason, snake-cased `structured_output`) but **not** that a real engine
  produces them; the real validate→repair logic is covered separately in
  `engine.structured.test.ts` (good), so no gap — but do not read the handler
  tests as end-to-end.
- `utils.test.ts:167` / `gemini.test.ts:347` codify **malformed/missing tool args →
  `{}`** as passing. That is a deliberate leniency, not a bug, but it means a model
  emitting broken arguments is silently turned into an empty-arg call rather than
  surfaced — design risk, not false comfort.

## 3. DOC-HONESTY findings

### Updated & TRUE (no action)
- **`docs/openapi.yaml`** — fully updated: `tools` (`:833`), `tool_choice`
  (`:841`), `response_format` w/ json_schema/json_object/text + strict→422
  (`:852-881`), `ToolCall` (`:890`), `tool_calls` on message/delta + `finish_reason`
  (`:908-947`), `parsed`/`structured_output` (`:979`). True-to-the-line.

### DOC-DRIFT — false "absent / incomplete" (must fix)
- **`docs/FEATURE-MATRIX.md:105-106`** — "Capability gaps confirmed absent
  stack-wide: **tool/function calling, multimodal image input, structured/JSON
  output.**" — **all three now exist** (multimodal committed; tools+structured in
  tree). Flip to: present (multimodal web+CLI; tools+structured engine/gateway/web/
  CLI), with the caveat that web/CLI tool surfaces are code-complete but the web SSE
  accumulation + CLI `--tools` are untested.
- **`docs/audit/2026-06-28/VERDICT.md`** — stale across the file (written pre-tools):
  - §1 "tool/function calling and structured/JSON output are **entirely absent**" —
    now false.
  - §3 "It still loses on **tool/function calling, structured output**" — now
    largely closed.
  - §4 matrix row **"Tool calling / structured out | ❌ | ❌ | ❌ | ❌"** → Web and
    CLI should flip to ✅ (engine `engine.ts`, gateway `handler.ts`, web
    `gateway.ts`, CLI `chat.ts` all wired + provider/engine/gateway tested); keep
    desktop/mobile ❌. Annotate web/CLI as "untested client accumulation".
  - §5 P0 #1 "**Tool calling + structured output absent**" → built, not absent.
  - §7 P2 "**CSP nonce (reverted — see §8.4)**" → now **relanded** in `proxy.ts`
    (dev-only `unsafe-eval`, Report-Only toggle) but **untested + not
    browser-verified** — re-classify reverted→relanded-unverified, NOT done.
- **`docs/STORE-READINESS.md:69-71`** — still an **unchecked `[ ]`** "AI-content
  report control … decide mechanism … and wire it" though it shipped on web/desktop
  (`MessageBubble`, commit `8137fd9`). Inverse drift (false-incomplete); flagged in
  VERDICT correction #5 and **still not fixed**. Check it off.

### No NEW false ✅ found (correctly honest)
- `FEATURE-MATRIX.md` row 24 + `VERDICT.md §4` keep **desktop/mobile image UI = ❌**
  — correct (no UI exists).
- CSP is NOT yet claimed browser-verified anywhere — keep it that way; the reland is
  untested.
- `README.md` does not claim tools/structured at all (router-framed) — an omission,
  not a lie; lowest priority.

## 4. VERDICT.md cells to flip (exact edits)

| Location | Now says | Should say | Class |
|----------|----------|-----------|-------|
| `FEATURE-MATRIX.md:105-106` | tools/multimodal/structured "absent stack-wide" | all three present (multimodal committed; tools+structured in tree) | DOC-DRIFT |
| `VERDICT.md §4` row "Tool calling / structured out" Web/CLI | ❌ / ❌ | ✅ / ✅ (client accumulation untested) | DOC-DRIFT |
| `VERDICT.md §1` | "entirely absent" | "built; client tests pending" | DOC-DRIFT |
| `VERDICT.md §5 P0-1` | "absent" | "built this run" | DOC-DRIFT |
| `VERDICT.md §7 P2` | "CSP nonce (reverted)" | "relanded `proxy.ts`, untested, unverified-in-browser" | DOC-DRIFT |
| `STORE-READINESS.md:69-71` | `[ ]` wire AI-report | `[x]` shipped (`8137fd9`) | DOC-DRIFT |

## 5. Classification summary
- **TESTED:** OpenAI fragment accumulation; Gemini functionResponse round-trip;
  structured repair-loop exhaustion; gateway tools-422 + structured-422; engine
  validate→repair; schemas (tools/response_format) validation.
- **UNTESTED:** web SSE tool accumulation (`apps/web/lib/gateway.ts`); CLI
  `--tools`/`loadTools` (`apps/cli/src/commands/chat.ts`); CSP nonce
  (`apps/web/proxy.ts`).
- **DOC-DRIFT:** `FEATURE-MATRIX.md:105-106`; `VERDICT.md` §1/§3/§4/§5/§7;
  `STORE-READINESS.md:69-71`. (`openapi.yaml` is current; `README.md` merely
  silent.)
