# Post-build audit 02 — Gateway tool-calling / structured-output + relay no-custody

*Branch `feat/tool-calling`. Independent, read-only re-verification against the
10/10 bar. Scope: `apps/gateway/src/handler.ts`, `workers/relay`, `docs/openapi.yaml`.
Prior verdict had the gateway/relay at ~9.5/10, no-custody proven.*

Ground truth: tool-calling + structured output are NEW on this branch and touch
ONLY the gateway/providers/router/types/schemas layers. `git diff main...HEAD`
shows the relay's only changes are unrelated, pre-existing billing/redact/
account-delete work — **no tool-calling code reaches the relay**.

---

## (1) SSE tool_calls shape — OpenAI-compatible? **OK** (one low nit)

`handler.ts:1144-1189` (stream) / `1010-1025` (non-stream).

- Non-stream: `message.tool_calls[]` = `{id, type:"function", function:{name,
  arguments:JSON.stringify(...)}}`, `content:null` when tools-only, `finish_reason:
  "tool_calls"`. Exact OpenAI shape. **OK**.
- Stream: each call emitted as its own `chat.completion.chunk` with
  `delta.tool_calls:[{index:i, id, type, function:{name, arguments}}]` and
  `finish_reason:null`, then a terminal `{delta:{}, finish_reason:"tool_calls"}`
  frame. A generic client accumulating by `index` reconstructs correctly. **OK**.
- **NIT (low):** the streaming tool-call deltas omit `delta.role:"assistant"`
  (OpenAI puts `role` on the first tool-call delta) and emit each call's
  `arguments` as one whole blob rather than fragments. Both are tolerated by the
  OpenAI SDK and the documented contract (`openapi.yaml:1041-1064`), so this is a
  cosmetic deviation, not a correctness break. `handler.ts:1156-1168`.

## (2) 422 disambiguation — correct for every combo? **OK**, one **RISK (minor)**

Explicit-provider gates (`handler.ts:702-724`) fire in order vision → tools →
strict-schema, each via the model-aware, fail-closed checks `supportsVision/
supportsTools/structuredOutputLevel` (`capabilities.ts:125-211`, allowlist +
default-model, unknown model → false/"none"). Correct and conservative.

Strict-schema gate is keyed on `response_format.type==="json_schema" &&
strict===true` (`handler.ts:715-717`); a NON-strict json_schema/json_object
request intentionally does NOT 422 — it downgrades and stays honest via
`served_level`/`guaranteed` metadata. Right design.

- **RISK (minor):** the AUTO-routing branch (`handler.ts:902-909`) maps the
  engine's single generic `"unsupported_capability"` error by request SHAPE:
  `wantsStrictSchema && !hasImages && !wantsTools` → structured, else
  `wantsTools && !hasImages` → tools, else → vision. When a request combines
  capabilities (e.g. tools+strict-schema, or image+tools) and auto-routing fails,
  the precedence can mis-label WHICH capability was missing (a tools+schema
  request that failed only on schema reports the tools error). Same `suggestions`
  family, low severity, but the `required:[...]` field can be wrong. Explicit-
  provider requests are unaffected (each gate is precise).

## (3) Structured buffering vs stream/timeout/idle-watchdog — **OK**

- Non-stream (`handler.ts:986-1005`) drains `result.stream` through the SAME
  `withIdleWatchdog` the buffered path already used, THEN reads `result.toolCalls`
  and `asStructured(result)` — metadata read strictly after drain. **OK**.
- Stream (`handler.ts:1094-1236`): unchanged inline idle loop drains text, then
  tool frames, then metadata, then ONE terminal structured frame carrying `parsed`
  + `structured_output`, then `[DONE]`. No second drain of the stream; `toolCalls`/
  `structuredOutput` are side-channel fields, not a re-iteration. **OK**.
- Buffer interaction: structured disables token streaming, so the engine emits the
  whole doc as the first chunk — the connect window is bounded by
  `withTimeout(routeAndStream, requestTimeoutMs)` and the buffer/repair pull by the
  per-chunk idle watchdog (`streamIdleTimeoutMs`, resets per chunk). A legitimately
  long validate+repair loop exceeding the 60s idle window would be aborted as
  "idle" (`handler.ts:1105-1118`) — acceptable at 60s, noted as the only edge.
- Strict-invalid honesty: non-stream returns 422 `structured_output_invalid` with
  metadata and WITHOUT `parsed` (`handler.ts:1032-1046`); never serves
  non-conformant prose as success. **OK**.

## (4) Leak of tool args / image bytes to logs or relay — **OK (none found)**

- Logs carry only counts/ids: `chat.route` logs provider/model/`images` count
  (`handler.ts:968-977`); error logs use `redactSecrets(message)` on the error
  string only (`1243`, `1727`, `1742`). Tool `arguments` (`JSON.stringify(call.
  arguments)`) and image base64 go ONLY to the client response, never to a log.
- Image bytes never logged, never compressed (Tokzen skipped for image requests,
  `handler.ts:792`), surfaced only as derived headers (`X-Zintus-Image-Bytes`,
  count). **OK**.
- All client-facing error frames are scrubbed (`redactSecrets`) on both SSE and
  JSON paths (`1247-1250`, `1458-1461`, `1000`, `892`). **OK**.
- Relay: it does NOT proxy `/v1/chat/completions` and never sees messages, tool
  args, or image bytes (grep: zero chat/message handling in `workers/relay/src`).
  No new leak surface. **OK**.

## (5) Code efficiency — minor **INEFFICIENT** only

- `new TextEncoder()` re-allocated per request (`handler.ts:649`, `1086`, `1417`)
  and `imageCount()` + the `imageBytes` reduce make two passes over `messages`
  (`690`, `725-735`). Pre-existing, trivial; a module-level encoder + single fold
  would remove it. **INEFFICIENT (negligible).**
- No redundant serialization of tool args or double-drain of the stream found;
  `structuredOutputBody`/`buildUsageMetadata`/`asStructured` each called once per
  applicable branch. **OK.**

## (6) No-custody still holds — **OK (UNCHANGED)**

- `MANAGED_KEYS_AVAILABLE=false` (`tiers.ts:8`); managed-key tiers gated off.
- `GatewaySession` forwards opaque ciphertext and explicitly NEVER decrypts/
  inspects `encryptedKey` (`GatewaySession.ts:53-56`, `339-345`).
- Grep for `decrypt|payout|disburse|withdraw|transfer|custody` in `workers/relay/
  src` returns only the no-custody guard comments — no funds movement, no key
  decryption. The tool-calling feature adds nothing to the relay.

---

### Verdict
Tool-calling + structured output are wired honestly and capability-correctly at
the gateway: model-aware fail-closed gating, OpenAI-shaped SSE/JSON, buffered-
structured honesty (`served_level`/`guaranteed`/`valid`), and 422 hard-errors
instead of silent downgrade. No new leak path; relay no-custody UNCHANGED and
intact. Two non-blocking items: the auto-route 422 `required` label can be
imprecise for multi-capability requests (RISK-minor), and streaming tool deltas
omit `role`/argument-fragmenting (compat NIT). Gateway holds ~9.5/10; relay 10/10
no-custody.
