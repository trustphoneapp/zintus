# BLUE TEAM — Tool/Function Calling Rebuttal (2026-06-28)

Adjudication of `red-tool-calling.md`. Read-only on source. Each verdict cites
file:line proof.

---

## 1. Gateway emits OpenAI-native `tool_calls` it cannot ingest back — CONFIRMED (severity HIGH, red's CRITICAL is slightly overstated)

**The emit side is exactly as charged.** The gateway produces the OpenAI-native
wire shape:
- JSON: `apps/gateway/src/handler.ts:1018-1031` — `{role:"assistant", content: content.length>0?content:null, tool_calls:[...]}`, `finish_reason:"tool_calls"` (`:1066`).
- SSE: `handler.ts:1150-1195` — `delta.tool_calls[...]` then `finish_reason:"tool_calls"`.

**The ingest side cannot accept its own output.**
- `ChatMessageSchema` (`packages/schemas/src/index.ts:77-85`) has no top-level
  `tool_calls` field; zod `.object` strips it (header comment `:164`). PROVEN.
- `content` is `z.union([z.string(), z.array(...).min(1)])` (`:81`) → an echoed
  `content:null` assistant turn **400s**. PROVEN.
- `parseMessages` (`handler.ts:1766-1820`) only normalizes `role:"tool"` →
  user/tool_result (`:1781-1796`). There is **no branch** turning an assistant
  `tool_calls` field into `tool_call` content blocks. PROVEN.

**So the wire-format round-trip is genuinely broken** for a third-party
OpenAI-SDK client that replays the message array the gateway handed it. Red's
fix (normalize `tool_calls` → `tool_call` blocks, allow `content:null`) is correct.

**Why not full CRITICAL.** The loop is NOT structurally impossible — it closes
through the **Zintus-native content-block shape**, which validates and routes end
to end today:
- assistant `content:[{type:"tool_call", id, name, arguments}]` validates via
  `ToolCallBlockSchema` (`schemas/src/index.ts:53-58`), inside the
  `content` array union (`:81`).
- user `content:[{type:"tool_result", toolCallId, content}]` validates via
  `ToolResultBlockSchema` (`:63-68`).
- `parseMessages` passes both through unchanged (`handler.ts:1804`).
- `toOpenAiMessages` (`packages/providers/src/openai-compat.ts:111-139`) maps
  `tool_call`→`tool_calls`, `tool_result`→`role:"tool"`, in correct upstream
  order. Gemini `splitGeminiMessages` maps the same blocks.

And the project's own web client uses exactly this shape: `apps/web/lib/gateway.ts:574`
returns `toolCalls?: ToolCallContentBlock[]` (the internal block type, "caller
... sends results back as `tool_result` blocks"), NOT the OpenAI top-level field.
Red's citation of `:574` as "returns the same [OpenAI] shape" is inaccurate — it's
the ingestable content-block shape.

**Verdict: CONFIRMED real interop bug (a product advertising OpenAI-compat emits a
turn a stock OpenAI client cannot replay), severity HIGH.** Refuted only the
"loop cannot be closed at all" framing — a supported continuation shape exists.

---

## 2. Threaded loop loses tool calls — engine persists assistant text only — PARTIAL (factual defect real; severity MED, not HIGH)

**The factual claim is TRUE.** `wrappedStream` appends
`{role:"assistant", content: assistantContent}` (`packages/engine/src/engine.ts:849-858`)
and the cache-hit path the same (`:771-781`); `result.toolCalls` is never
persisted. The write guard at `:864` only *suppresses caching* on tool turns; it
does not preserve the calls. PROVEN.

**But the stated failure scenario ("Turn 2 sends the tool_result" in threaded
mode) is not expressible, so the impact is narrower than charged:**
- The threaded entrypoint is `message + thread_id`, and the schema constrains
  `message` to **string content only**:
  `message: z.union([z.string(), z.object({role, content: z.string()})])`
  (`schemas/src/index.ts:168-170`). A `tool_result` block **cannot be submitted**
  through the threaded surface at all.
- When `threadId` is present the engine **ignores any client `messages` array**
  and rebuilds `effectiveMessages` from the episodic store via `compileContext`
  (`engine.ts:449-478`, comment `:441-448`: "even when the client also sends a
  full messages array ... we use the server's view"). So tool_call/tool_result
  blocks a client might send are discarded on the threaded path regardless of
  persistence.

So persisting the tool calls is necessary for history fidelity but **not
sufficient** to make a threaded tool loop work; the threaded surface has two
independent blockers (string-only `message`, compiler-rebuilt history). The
usable tool loop is the stateless content-block array (Charge 1), where calls
already survive.

**Verdict: PARTIAL — the dropped-toolCalls defect is real and worth fixing for
history fidelity, but "the threaded loop is structurally impossible" is caused by
the string-only entrypoint, not solely by this. Severity MED.**

---

## 3. Tool `strict:true` schema not normalized → OpenAI 400 — CONFIRMED (severity HIGH for strict tools; opt-in)

`toOpenAiFunctionTools` (`openai-compat.ts:163-175`) forwards `tool.parameters`
verbatim and appends `strict: true` **without** calling
`normalizeOpenAiStrictSchema`. The structured-output path DOES normalize before
sending (`toOpenAiResponseFormat` → `normalizeOpenAiStrictSchema`, `:274`). The
asymmetry is exactly as charged. PROVEN.

`strict` is a real, reachable flag: `ToolDefinitionSchema.strict` is accepted at
the edge (`schemas/src/index.ts:129`) and the type carries it through to
`toOpenAiFunctionTools`. OpenAI Structured-Outputs strict requires
`additionalProperties:false` on every object node and all `properties` keys in
`required`; a normal `{properties:{city:{...}}, required:["city"]}` lacks
`additionalProperties:false` → upstream **400**.

Caveat on severity: `strict` is opt-in (default tools omit it), so this only
breaks clients that explicitly set `strict:true` with a non-pre-normalized schema
— but for those it is a guaranteed 400, and the fix is a one-line mirror of the
response-format path.

**Verdict: CONFIRMED. Fix: `normalizeOpenAiStrictSchema(tool.parameters)` when
`tool.strict`.**

---

## 4. Cache guards check `requiresTools`, not `hasToolTurns` — CONFIRMED (severity MED; spurious-match plausible not proven)

Both guards are as charged:
- Read guard: `!requiresTools(request) && !requiresStructuredOutput(request)`
  (`engine.ts:729-734`). `requiresTools` only checks `req.tools?.length`
  (`packages/types/src/route.ts:191-193`).
- Write guard: `!(result.toolCalls?.length)` (`engine.ts:864`) — checks the NEW
  response's calls, not whether the REQUEST carried tool turns.
- `hasToolTurns` exists and is exported (`route.ts:197-206`) but is referenced by
  neither guard. PROVEN.

The empty-embedding mechanism holds: a final-synthesis continuation
(`messages:[...,assistant(tool_call), user(tool_result)]`, no `tools` array) has
`requiresTools=false` → read proceeds. `lastUser` is the `tool_result` turn
(`engine.ts:506-508`), and L2 keys on `textOf(lastUser.content)` (`:756-757`).
`textOf` filters to text blocks only (`route.ts:161-167`) → `""` for a pure
tool_result turn. So L2 runs an **empty-string embedding** lookup at 0.12
distance. The write guard then caches the synthesis turn (no new toolCalls).

Whether an empty embedding actually returns a wrong neighbor within 0.12 is
plausible but not proven here; the structural defect (tool-continuation turns
both read and write the text cache, contradicting the in-code claim at `:724-728`)
is certain.

**Verdict: CONFIRMED. Fix: add `!hasToolTurns(request.messages)` to both guards.
Severity MED.**

---

## 5. `toOpenAiMessages` makes 4 passes per block message — CONFIRMED (LOW, efficiency)

`openai-compat.ts:111-128`: `content.filter` (tool_result) + `content.filter`
(tool_call) + `textOf(content)` (itself filter+map+join, `route.ts:163-166`) +
`content.some` (image), and `text` is computed unconditionally at `:117` even when
the taken branch (tool_call-only or image-only) discards it. Accurate. Pure
micro-optimization on small arrays.

**Verdict: CONFIRMED, LOW.**

---

## 6. Gemini synth-id fallback mis-resolves provider ids — CONFIRMED (LOW; symptom of 1/2)

`nameFromSynthId` matches only `^call_(.+)_\d+$` (`gemini.ts:93-96`);
`resolveToolName` falls back to it when the id is absent from the assistant-call
map (`:113-118`). An OpenAI-origin id like `call_abc123def` (no trailing
`_<index>`) fails the regex and the **whole id is returned as the function name**
→ `functionResponse.name` matches no declared function. PROVEN.

This only triggers when the assistant `tool_call` block is missing from history
(the Charge 1/2 conditions) or on a mid-flight provider switch; in the normal
content-block round-trip `buildToolNameMap` (`:101-111`) resolves the id, so the
fallback isn't hit. Red concedes this is a symptom. Independent hardening (error
on unresolved id rather than fabricating a name) is reasonable.

**Verdict: CONFIRMED, LOW.**

---

## 7. `parseOpenAiSseStream` recomputes the tool-turn decision twice — CONFIRMED (LOW, clarity)

`utils.ts:199-212`: `drainedToolCalls` derived at `:199`, used in the drain
branch `:200`, then `mapped` recomputes `drainedToolCalls || finishReason ===
"tool_calls"` at `:209-210`. Duplicated condition; collapsing into one
`isToolTurn` is a clean refactor. No behavioral bug.

**Verdict: CONFIRMED, LOW (clarity/drift risk only).**

---

## Net assessment

| # | Verdict | Severity |
|---|---------|----------|
| 1 | CONFIRMED (loop-impossible framing refuted; content-block shape closes it) | HIGH |
| 2 | PARTIAL (toolCalls-dropped real; threaded-loop break is from string-only entrypoint) | MED |
| 3 | CONFIRMED | HIGH (opt-in) |
| 4 | CONFIRMED (spurious-match plausible) | MED |
| 5 | CONFIRMED | LOW |
| 6 | CONFIRMED (symptom of 1/2) | LOW |
| 7 | CONFIRMED | LOW |

The load-bearing red claims survive on the facts (1, 3, 4), but the two strongest
framings are tempered: the tool loop IS completable today through the
Zintus-native content-block continuation (Charge 1), and the threaded loop's
breakage is over-attributed to dropped persistence when the string-only `message`
entrypoint and compiler-rebuilt history are the real blockers (Charge 2).
