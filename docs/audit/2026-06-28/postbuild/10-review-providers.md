# Provider Adapter Wire-Format Review — post tool/structured/image build

Date: 2026-06-28 · Branch: feat/tool-calling · Suite: 971 green
Scope: `packages/providers/src/openai-compat.ts`, `src/utils.ts` (`parseOpenAiSseStream`),
`src/providers/gemini.ts`, `src/capabilities.ts`. READ-ONLY.

Verified against OpenAI Chat Completions, OpenRouter, and Gemini
`v1beta:streamGenerateContent` specs. Findings classified
CORRECT / BUG / RISK / INEFFICIENT, with file:line + concrete fix.

---

## (1) OpenAI tool_calls SSE accumulation + finish_reason

### CORRECT — index-keyed fragment accumulation
`utils.ts:90-113` matches the real wire pattern exactly: `id` + `function.name`
land on the first delta for an `index`; `function.arguments` are concatenated
(`acc.args += …`) across many deltas. `typeof delta.index !== "number"` correctly
admits `index: 0`. Empty-arg tools (`arguments: ""`) drain to `{}` via the
`if (acc.args)` guard (`utils.ts:67`). Parallel calls keyed by distinct index,
drained in sorted order (`utils.ts:60`). Malformed arg JSON → `{}` not a throw.
This is solid.

### BUG (latent) — `{ done:true }` emitted before the final usage chunk
`utils.ts:196-209`. With `stream_options.include_usage` (set at
`openai-compat.ts:313`) OpenAI's real frame order is:
`… → {choices:[{finish_reason}], usage:null} → {choices:[], usage:{…}} → [DONE]`.
The code yields `{ done:true }` **on the finish_reason frame**, *then* the separate
usage frame arrives and yields `{ usage }` **after** `done`, then `[DONE]` yields a
**second** `{ done:true }`. So `done` fires twice and usage trails it.

Why it doesn't bite today: the sole consumer
(`packages/router/src/factory.ts:743-761`) ignores `chunk.done` and drains the
generator to completion, so `reportedUsage` is still captured. It is a live trap
for any consumer that treats `done` as terminal (the field exists on `StreamChunk`
precisely to be honored). Fix: do **not** yield `{ done:true }` inside the
`finishReason != null` branch; emit `done` only on `[DONE]` / stream end. Yield the
mapped `finishReason` there, keep accumulating, let the trailing usage frame flow.

### RISK — tool calls buffered but finish_reason is `stop`
`utils.ts:198,204`. Some OpenAI-compatible providers send `finish_reason:"stop"`
while tool-call fragments are buffered. The drain guard (`|| toolCalls.size > 0`)
correctly flushes the calls, but `mapFinishReason("stop")` then labels the turn
`"stop"`, not `"tool_calls"`. Downstream sees toolCall chunks yet a `stop` reason —
the engine keys "is this a tool turn?" off `result.toolCalls.length`
(`engine.ts:798`) so it survives, but the finishReason is semantically wrong.
Fix: if any tool call drained, force `finishReason: "tool_calls"` regardless of the
raw reason.

### RISK — finish_reason mapping incomplete
`utils.ts:39-51` maps `tool_calls/stop/length/content_filter`; unknown values →
`undefined` (no finishReason emitted). Misses the deprecated `function_call`
(legacy single-function path) — minor, and unrecognized vendor reasons silently
yield no terminal reason. Acceptable but document; if legacy `function_call`
support is wanted, map it to `tool_calls`.

### RISK — trailing-buffer path drops a final tool-call delta
`utils.ts:216-239`. The no-trailing-newline buffer parse handles only
`content`/`usage`, not `tool_calls`. A provider that closes without a terminating
`\n` on the last tool delta would lose it (already-accumulated calls still drain at
`utils.ts:243`). Low likelihood (providers newline-terminate). Tests don't cover.

---

## (2) Gemini

### CORRECT — whole functionCall + stable synth id
`gemini.ts:243-256`. Gemini delivers `functionCall` complete in one part (no
accumulation needed). `id = call_<name>_<index>` is stable within a stream and
round-trips: `buildToolNameMap` (`gemini.ts:82`) re-maps id→name from the assistant
turn, with `nameFromSynthId` as fallback. The regex `/^call_(.+)_\d+$/`
(`gemini.ts:75`) is **greedy**, which is actually correct — it strips only the
trailing `_<index>`, preserving names containing `_<digits>` (e.g.
`call_get_item_2_0` → `get_item_2`). NOTE: the doc comment says "lazily"; the regex
is greedy. Comment is wrong, behavior is right — fix the comment.

### RISK — `normalizeSchema` over-strips Gemini-supported keywords
`gemini.ts:27-34`. `ALLOWED_SCHEMA_KEYS` = `type, properties, items, required,
enum, description`. Gemini's OpenAPI-3 `Schema` actually accepts more:
`format, nullable, anyOf, minimum, maximum, minItems, maxItems, minLength,
maxLength, pattern, default, propertyOrdering`. Consequences:
- `format` dropped → loses `date-time`, `int64`, `enum`-string hints (degrades, not
  breaks).
- `nullable` dropped → loses null support.
- `anyOf` dropped → a union property collapses to a node with **only**
  `description` and no `type`; Gemini can **reject** a typeless schema node. This
  CAN break valid input schemas. Fix: widen the allowlist to the keywords above
  (at minimum add `format`, `nullable`, `anyOf`, numeric/length bounds), recursing
  into `anyOf` like `items`.

### BUG (edge) — tuple `items` array passed through, Gemini rejects
`gemini.ts:51-54`. JSON-Schema tuple form `items: [schemaA, schemaB]` is mapped to
an **array** of normalized schemas. Gemini's `items` must be a **single** Schema
object — an array is rejected. Rare in practice (tuples uncommon) but unguarded.
Fix: collapse array `items` to a single schema (e.g. first element) or reject.

### CORRECT — responseSchema + responseMimeType combo
`gemini.ts:344-354`. `json_schema` → `responseMimeType:"application/json"` +
normalized `responseSchema`; `json_object` → mimeType only. Matches
`generationConfig`. Merge into `generationConfig` preserves
`temperature`/`maxOutputTokens` (`gemini.ts:365-369`); `undefined`s are dropped by
`JSON.stringify`. Good.

---

## (3) OpenAI `response_format` json_schema strict:true — contract mismatch

### BUG — `strict: true` emitted without enforcing OpenAI's strict-schema rules
`openai-compat.ts:208-216` hardcodes `strict: true` and forwards the caller's
`schema` **unmodified**. OpenAI Structured Outputs with `strict:true` REQUIRES, for
every object node: `additionalProperties: false` AND every property listed in
`required` (optional fields must be modeled as `["T","null"]` unions, not omitted
from `required`). A schema with optional fields or a missing
`additionalProperties:false` causes a hard **400** ("'required' must contain every
key"; "additionalProperties must be false"). The adapter does no transformation, so
any non-strict-shaped caller schema fails the request. Tests
(`openai-compat.test.ts:201,261`) only assert `strict:true` is present — they never
feed a schema with optional fields, so the gap is invisible.

Fix: before emitting, run a `toStrictSchema` pass that recursively sets
`additionalProperties:false` on every object and forces `required` = all property
keys (or set `strict:false` and rely on json-mode + engine post-validation). Same
defect applies to **function tools**: `tool.strict ? { strict:true }`
(`openai-compat.ts:166`) forwards `tool.parameters` raw under the identical strict
contract.

---

## (4) Merge correctness — web_search + function tools + response_format

### CORRECT — single tools array, no clobbering (OpenAI side)
`openai-compat.ts:281-294`. web_search tool and function tools are pushed into one
array; `tool_choice` is gated to travel only with function tools; `response_format`
is an independent field. No overwrite. Gemini side (`gemini.ts:316-329`) likewise
merges `googleSearch` + `functionDeclarations` into one `tools` array — valid on
Gemini 2.x (the default `gemini-2.5-flash`), correct.

### RISK — OpenRouter web-search wire shape likely wrong
`openai-compat.ts:285` pushes `{ type:"openrouter:web_search", engine:"auto" }`
into `tools`. OpenRouter does **not** document a `tools` entry of this type. Its web
search is enabled via a top-level **`plugins`** array
(`plugins:[{ id:"web", engine:"auto" }]`) or the `:online` model-slug suffix. An
unrecognized `tools[].type` is at best ignored (silent no-op web search) and at
worst 400s. Only `openrouter` sets this flag (`skeletons.ts:17`). Verify against
current OpenRouter docs; fix is to emit a top-level `plugins:[{id:"web"}]` body
field instead of a tools entry. Currently untested.

---

## (5) Efficiency

### INEFFICIENT — `toOpenAiMessages` multi-pass per message
`openai-compat.ts:111-150`. Each message does two `.filter` passes + `textOf` +
`.some(b => b.type==="image")` — up to four iterations of the same block array.
Fold into one pass collecting toolResults/toolCalls/text/hasImage. Minor (message
arrays are small) but trivially fixable.

### INEFFICIENT — `splitGeminiMessages` double-filters
`gemini.ts:155-177` iterates `messages` once to extract system, again for
non-system, plus `buildToolNameMap` (`gemini.ts:82`) walks all messages even when
no tools are present. Single partition pass + skip the name map when
`!options.tools?.length` would suffice.

### INEFFICIENT (negligible) — per-drain key allocation
`utils.ts:60` `[...toolCalls.keys()].sort(...)` allocates an array + sort each
drain. Tool-call counts are tiny; ignore unless profiled.

### CORRECT — no redundant JSON parses
Tool args parsed once at drain (`utils.ts:69`); Gemini tool_result parsed once
(`gemini.ts:117`); both necessary.

---

## capabilities.ts

CORRECT and well-guarded: fail-closed allowlists (`VISION_MODELS`,
`TOOL_MODELS`, `JSON_SCHEMA_MODELS`), `structuredOutput` 3-state kept consistent
with the derived `json` boolean, default-model fallthrough. Only `gemini` claims
`json_schema` (matches the responseSchema support reviewed above) — conservative
and correct. No wire-format issues. NOTE: a model's allowlist membership for
structured output presumes `normalizeSchema` actually emits a Gemini-valid schema —
see finding (2); fixing the allowlist of keywords is the real lever.

---

## Edge cases the 971-green suite MISSES (summary)

1. include_usage frame ordering: finish_reason frame, then separate usage frame,
   then `[DONE]` — exposes the premature/duplicate `done` (finding 1).
2. tool calls buffered with `finish_reason:"stop"` → wrong terminal label.
3. OpenAI strict schema with optional fields / no `additionalProperties:false`
   (finding 3) — current tests only check the flag, not contract compliance.
4. Gemini `normalizeSchema` on `format`/`nullable`/`anyOf`/numeric bounds and
   tuple `items` (finding 2).
5. OpenRouter web_search merged with function tools end-to-end body assertion
   (finding 4) — the merge path is untested.
6. Trailing-buffer tool-call delta without final newline (finding 1 RISK).
