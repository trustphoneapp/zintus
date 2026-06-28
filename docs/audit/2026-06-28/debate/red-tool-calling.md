# RED TEAM — Tool/Function Calling Audit (2026-06-28)

Branch `feat/tool-calling`. Charges are numbered so blue can rebut by number.
Each charge: file:line, concrete failing scenario, severity, proposed change.

---

## 1. The gateway emits an assistant `tool_calls` turn it cannot ingest back — multi-turn loop break for OpenAI-native clients. **CRITICAL**

**Where:**
- Emits OpenAI-shape assistant message with `tool_calls`:
  - JSON path: `apps/gateway/src/handler.ts:1018-1031` (`message.tool_calls = [...]`, `content:null`).
  - SSE path: `apps/gateway/src/handler.ts:1150-1194` (`delta.tool_calls[...]` then `finish_reason:"tool_calls"`).
  - Web client returns the same shape: `apps/web/lib/gateway.ts:574,705`.
- Cannot ingest it back:
  - `ChatMessageSchema` has **no `tool_calls` field** — only `role`, `content`, `tool_call_id` (`packages/schemas/src/index.ts:77-85`). Zod `.object` strips unknown keys (comment at `:164`), so an echoed `tool_calls` array is **silently dropped**.
  - `content:null` is rejected: `content` is `z.union([z.string(), z.array(...).min(1)])` (`:81`) → a pure tool-call assistant turn (`content:null`) **400s**.
  - `parseMessages` only normalizes `role:"tool"` → user/tool_result (`apps/gateway/src/handler.ts:1781-1796`); it has no branch that turns an assistant `tool_calls` field into `tool_call` content blocks.

**Failing scenario (falsifiable):** A standard OpenAI-compatible client does turn 1, receives `choices[0].message.tool_calls`, runs the tool, then POSTs turn 2 with the conversation array exactly as OpenAI requires: the prior assistant message `{role:"assistant", content:null, tool_calls:[{id,type,function}]}` followed by `{role:"tool", tool_call_id, content}`.
- If `content:null` → **400 "Invalid request body"** at the schema.
- If the client sends `content:""` to dodge that → `tool_calls` is stripped → the assistant turn becomes bare `{role:"assistant", content:""}`. The tool_call is gone. For OpenAI-compat providers, `toOpenAiMessages` then emits a `role:"tool"` message with **no preceding assistant `tool_calls`** → upstream OpenAI 400 ("tool message must follow tool_calls"). For Gemini, `buildToolNameMap` finds no `tool_call` → see Charge 6.

The ONLY continuation shape that works is the internal `tool_call` **content-block** array — which is neither what the gateway emits nor OpenAI-compatible. The documented OpenAI surface cannot complete its own loop.

**Fix:** In `parseMessages`, normalize an assistant message carrying `tool_calls` into `tool_call` content blocks (parse `function.arguments`), and add `tool_calls` (+ allow `content:null`) to `ChatMessageSchema`.

---

## 2. Server-side threaded tool loop loses tool calls — engine persists assistant text only. **HIGH**

**Where:** `packages/engine/src/engine.ts:849-859` (and cache-hit path `:771-781`). `wrappedStream` appends `{ role:"assistant", content: assistantContent }` to the conversation store. `result.toolCalls` is **never persisted**.

**Failing scenario:** Client uses the `message` + `thread_id` continuation mode (server holds history; `GET /v1/threads/{id}` at `handler.ts:1700` returns `engine.getThreadMessages`). Turn 1 produces tool calls; the stored assistant turn is plain text with the tool calls dropped. Turn 2 sends the `tool_result`. The reconstructed history has a `tool_result` (user turn) with **no preceding `tool_call`** assistant block → same provider-side failure as Charge 1. The threaded loop is structurally impossible.

**Fix:** When `result.toolCalls?.length`, append the assistant turn as a `tool_call` content-block array (text + calls), not a bare string.

---

## 3. Tool `strict:true` schema is not normalized → OpenAI hard-400. **HIGH**

**Where:** `packages/providers/src/openai-compat.ts:163-175` (`toOpenAiFunctionTools`) forwards `tool.parameters` verbatim and tacks on `strict:true`, **without** `normalizeOpenAiStrictSchema`. Contrast the structured-output path, which DOES normalize before sending (`toOpenAiResponseFormat` → `normalizeOpenAiStrictSchema`, `:274`).

**Failing scenario:** A perfectly normal tool — `{ name:"get_weather", strict:true, parameters:{ type:"object", properties:{ city:{type:"string"} }, required:["city"] } }`. OpenAI Structured-Outputs strict requires `additionalProperties:false` on every object node and every property listed in `required`. This schema has neither `additionalProperties:false` set → OpenAI returns **400 invalid_request_error**. Any `strict` tool with optional fields or a missing `additionalProperties:false` fails. The `strict` flag is effectively a footgun that 400s real schemas.

**Fix:** Run `normalizeOpenAiStrictSchema(tool.parameters)` when `tool.strict` is set, mirroring the response-format path.

---

## 4. Cache skip-guard checks `requiresTools` (new defs), not `hasToolTurns` — continuation tool turns read/write cache; L2 embeds empty string. **MED**

**Where:** Read guard `packages/engine/src/engine.ts:729-734` gates on `!requiresTools(request) && !requiresStructuredOutput(request)`. Write guard `:864` gates on `!(result.toolCalls?.length)`. Neither checks `hasToolTurns(messages)`.

**Failing scenario:** A continuation turn that carries `tool_result` blocks but does NOT re-send a `tools` array (client asks only for the final synthesis): `requiresTools(request)` is **false**, so the cache READ proceeds. L1 misses, so L2 runs: `cache.getL2(textOf(lastUser.content), ...)` (`:756-757`). `lastUser` is the `tool_result` user turn, and `textOf` **elides** tool_result blocks (`packages/types/src/route.ts:161-167`) → the embedding query is the **empty string**. An empty-string embedding can spuriously match an unrelated cached entry within the 0.12 distance and return a **wrong cached answer** in place of the tool-synthesis reply. The write guard then also caches this turn. This directly contradicts the in-code claim "tool/structured turns skip the WRITE" (`:724-728`).

**Fix:** Add `!hasToolTurns(request.messages)` to both the read and write guards (the helper is already exported from `@zintus/types`).

---

## 5. `toOpenAiMessages` makes 4 passes over each block-array message. **LOW (efficiency)**

**Where:** `packages/providers/src/openai-compat.ts:111-128`. Per block-array message it runs `content.filter` (tool_result) + `content.filter` (tool_call) + `textOf(content)` (which is itself a `filter`+`map`+`join`) + `content.some` (image) — four linear passes, and `textOf` is computed unconditionally even when the chosen branch (tool_call-only or image-only) never uses it.

**Fix:** Single pass that partitions blocks into {text, image, tool_call, tool_result} and computes the joined text inline; reuse it across branches.

---

## 6. Gemini synth-id fallback mis-resolves provider-issued ids. **LOW**

**Where:** `packages/providers/src/providers/gemini.ts:93-96` `nameFromSynthId` matches only `^call_(.+)_\d+$`. `resolveToolName` (`:113-118`) falls back to it whenever the `toolCallId` isn't in the assistant-call map.

**Failing scenario:** Whenever the assistant `tool_call` block is missing (Charges 1/2) or the loop switched providers mid-flight, the `tool_result.toolCallId` is an OpenAI-origin id like `call_abc123def` (no trailing `_<index>`). The regex fails → the **whole id** is returned as the function name → Gemini `functionResponse.name:"call_abc123def"` matches no declared function → Gemini rejects / silently mis-correlates the result.

**Fix:** This is a symptom of Charges 1/2; once assistant `tool_call` blocks survive the round-trip the map always resolves. Independently, treat an unresolved id as an error rather than fabricating a function name.

---

## 7. `parseOpenAiSseStream` recomputes the tool-turn decision twice per terminal frame. **LOW (efficiency / clarity)**

**Where:** `packages/providers/src/utils.ts:199-212`. `drainedToolCalls` is derived, the drain branch runs, then `mapped` recomputes `drainedToolCalls || finishReason === "tool_calls"`. Micro, but the duplicated condition is easy to drift; collapse into one computed `isToolTurn` before draining.

---

### Net assessment
Charges 1 and 2 are the load-bearing ones: the feature can stream a tool call out, but the **multi-turn loop cannot be closed** through either documented continuation surface (OpenAI-native message array OR server-side thread) because the assistant tool-call turn is dropped on the way back in. Charge 3 makes the `strict` tool flag actively break requests. The 987 passing tests evidently exercise the internal content-block continuation shape, not the OpenAI wire shape the gateway itself advertises.
