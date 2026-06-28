# Post-build review: Tool / Function Calling

**Date:** 2026-06-28 · **Branch:** `feat/tool-calling` · **Reviewer:** Opus 4.8 (read-only)
**Design:** `docs/audit/2026-06-28/07-design-tool-calling.md` · **Suite:** 971 green
**Scope:** correctness bugs the tests don't catch + efficiency wins. Full trace:
types → `utils.ts` accumulator → `openai-compat.ts` → `gemini.ts` → router `factory.ts`
→ `engine.ts` → gateway SSE → web → CLI.

Severity legend: **BUG** (wrong behavior) · **RISK** (edge/latent) · **INEFFICIENT** · **CORRECT** (verified, no action).

---

## TL;DR — top findings

1. **BUG (critical):** the gateway request schema never gained tool blocks or a `tool`
   role, so the **multi-turn continuation turn is rejected at the edge with a 400** — the
   loop cannot complete over HTTP even though every internal layer supports it.
2. **BUG (high):** the engine **does not skip the response-cache READ** for tool requests;
   the cache key omits `tools`, so a tools request can be served a stale text answer — a
   **silent downgrade**, the exact honesty violation the design forbids.
3. **BUG (high):** the gateway **Tokzen path is gated only on `!hasImages`**, not on
   tools/tool-turns; it flattens messages through `textOf` and replaces them, **destroying
   `tool_call`/`tool_result` blocks** before routing.
4. **RISK:** Gemini synthesized ids reset per stream → `call_<name>_0` repeats every
   assistant turn; benign for Gemini (by-name) but produces **duplicate ids** if the same
   conversation is later routed to an id-correlated OpenAI-compat provider.
5. **RISK:** `sanitizeForLogs` is defined but **never called** anywhere — the "tool args
   never hit the logs" contract is unenforced (no active leak found).

---

## BUG-1 (CRITICAL) — Gateway edge schema rejects every tool-result continuation turn

**Files:**
- `packages/schemas/src/index.ts:48-51` — `ContentBlockSchema = z.discriminatedUnion("type", [TextBlockSchema, ImageBlockSchema])` — **no `tool_call`/`tool_result` members.**
- `packages/schemas/src/index.ts:18` — `ChatRole = z.enum(["system","user","assistant"])` — **no `tool` role.**
- `apps/gateway/src/handler.ts:1767-1773` (`parseMessages`) — throws `Invalid role` for anything but system/user/assistant; no `{role:"tool"}` → `tool_result` normalization.

**Defect:** The first-turn request works (`tools` defined, model emits calls, surfaced via
SSE at `handler.ts:1144`). But the **second** request — the one that carries the tool
results back (`{type:"tool_result", toolCallId, content}` blocks, or the OpenAI-native
`{role:"tool", tool_call_id, content}` message the design §3.4 explicitly promised to
accept) — fails `ChatCompletionRequestSchema.safeParse` (`handler.ts:662`) and returns
**400 "Invalid request body"**, or throws `Invalid role: tool` in `parseMessages`. The
documented client loop (design §5) therefore **cannot complete through the HTTP gateway.**
The internal layers fully support it — `toOpenAiMessages` maps `tool_result`→`{role:"tool"}`
(`openai-compat.ts:120-126`) and `splitGeminiMessages` maps it to `functionResponse`
(`gemini.ts:112-127`) — they are simply unreachable because the edge rejects the body.

**Why tests miss it:** the suite exercises first-turn surfacing + the 422 capability gates;
no test posts a continuation body with `tool_result` blocks (or `role:"tool"`) through the
schema, so the rejection never fires in CI.

**Fix:**
1. In `packages/schemas/src/index.ts`, add `ToolCallBlockSchema` + `ToolResultBlockSchema`
   and widen the union:
   ```ts
   const ToolCallBlockSchema = z.object({
     type: z.literal("tool_call"),
     id: z.string(),
     name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
     arguments: z.record(z.string(), z.unknown()),
   });
   const ToolResultBlockSchema = z.object({
     type: z.literal("tool_result"),
     toolCallId: z.string(),
     content: z.string(),
     isError: z.boolean().optional(),
   });
   const ContentBlockSchema = z.discriminatedUnion("type", [
     TextBlockSchema, ImageBlockSchema, ToolCallBlockSchema, ToolResultBlockSchema,
   ]);
   ```
2. Accept the OpenAI-native `tool` role: either add `"tool"` to a request-only role enum and
   normalize `{role:"tool", tool_call_id, content}` → a `user` turn carrying a
   `tool_result` block inside `parseMessages` (`handler.ts:1760`), per design §3.4, or
   document that only the `tool_result`-block shape is accepted and reject `role:"tool"`
   explicitly with a helpful message. Add a handler test that round-trips a continuation
   body end-to-end.

---

## BUG-2 (HIGH) — Engine cache READ not skipped for tool requests → silent downgrade

**Files:** `packages/engine/src/engine.ts:668` (`if (cache && !request.bypassCache)`),
key built at `:681-686`; `packages/cache/src/cache.ts:360-372` (`generateKey` payload is
`{messages, model, providerId, temperature, maxTokens}` — **`tools`/`toolChoice` absent**).
`engine.ts` imports only `textOf, requiresStructuredOutput` (`:36`) — neither
`requiresTools` nor `hasToolTurns`.

**Defect:** A tools request reaches the cache lookup unguarded. Because the cache key omits
`tools`, an identical prior **non-tool** request (same messages/model/provider/temp/maxTokens
— `targetProvider`/`targetModel` are `"auto"` for unforced requests) yields an **L1/L2 hit**
and returns cached **text**, bypassing the provider entirely — the model never gets the
chance to call a tool. This is a silent text downgrade (design §10: "no text downgrade").
The write-skip exists (`engine.ts:798` skips caching when `result.toolCalls.length > 0`) but
the **read** has no equivalent guard. Affects both the gateway and the CLI (CLI hits the
engine directly). The design's own task line ("engine forward + **cache-skip**") was only
half-implemented.

**Aggravating:** the L2 semantic lookup uses `textOf(lastUser.content)` (`engine.ts:691`);
for a `tool_result`-bearing user turn `textOf` returns `""`, so the embedding query is empty
and can match arbitrary low-distance cached entries.

**Fix:** import the helpers and gate the cache block (mirror the structured-output bypass):
```ts
import { textOf, requiresStructuredOutput, requiresTools, hasToolTurns } from "@zintus/types";
...
if (cache && !request.bypassCache
    && !requiresTools(request) && !hasToolTurns(effectiveMessages)) { ... }
```

---

## BUG-3 (HIGH) — Gateway Tokzen flattens & destroys tool blocks

**Files:** `apps/gateway/src/handler.ts:792` (`if (!hasImages)` — the only skip condition),
`:799` (`searchMessages.map((m) => ({ role, content: textOf(m.content) }))`),
`:808-811` (`compressedMessages` keeps only system/user/assistant text),
`:849` (`messages: compressedMessages.length > 0 ? compressedMessages : searchMessages`).
`hasToolTurns` is **not imported** in the handler.

**Defect:** Design §1.7/D6 requires Tokzen to be skipped when `hasImages || hasTools`.
The implementation skips only for images. For a tools request the compressor runs and
`textOf` strips every non-text block — a `tool_result` user turn collapses to
`{role:"user", content:""}` and a `tool_call` assistant turn loses its calls. Then line 849
**replaces** the original messages with the flattened set, so the tool history is gone before
it reaches the router/provider. (Currently masked by BUG-1, which 400s continuation turns
earlier — but the moment BUG-1 is fixed, this corrupts every continuation turn. First-turn
requests are unaffected only because they carry no tool blocks.)

**Fix:** mirror the image skip — compute and reuse a single predicate:
```ts
const skipTokzen = hasImages || wantsTools || hasToolTurns(messages);
...
if (!skipTokzen) { /* compress */ }
```
Import `hasToolTurns` from `@zintus/types`. Add a handler test asserting a tool/continuation
request emits no compression headers and forwards messages verbatim.

---

## RISK-1 — Gemini synth ids are not unique across turns

**File:** `packages/providers/src/providers/gemini.ts:195` (`functionCallIndex = 0` is
**stream-local**), `:245` (`id = call_${name}_${functionCallIndex}`).

**Defect:** `functionCallIndex` resets to 0 on every `parseGeminiSseStream` call, so each
assistant turn's calls restart at `call_<name>_0`. In a multi-turn conversation two distinct
calls across turns get the **same id**. For Gemini this is harmless (it correlates results by
**name**, via `buildToolNameMap`/`resolveToolName` at `:82-99`). But if the same conversation
is later routed to an OpenAI-compat provider (failover, model change), `toOpenAiMessages`
replays `tool_calls` with duplicate ids and the matching `{role:"tool"}` messages — OpenAI
correlates strictly by id and may reject or mis-pair them.

**Fix:** seed `functionCallIndex` from the count of prior `tool_call` blocks already in the
request (thread it into `parseGeminiSseStream`), or append a per-turn nonce to the synth id
so ids are conversation-unique, not stream-unique.

---

## RISK-2 — Two calls to the same tool name in one Gemini turn can't be disambiguated on the way back

**File:** `gemini.ts:94-99` (`resolveToolName`), `:121-126` (`functionResponse.name`).

**Defect:** Outbound, two same-name calls get distinct ids (`call_w_0`, `call_w_1`) — good.
Inbound, both `tool_result` blocks resolve to the **same** `name` ("w") because the
functionResponse wire shape carries only `name`, no id. Gemini matches responses to calls by
name and cannot tell the two apart. This is the inherent Gemini limitation flagged in design
R3; the code does the best the protocol allows. **No fix available at this layer** — document
the parallel-same-name-call caveat in the feature matrix; the index suffix disambiguates the
internal id but not Gemini's by-name correlation.

---

## RISK-3 — `sanitizeForLogs` is dead; the "args never logged" contract is unenforced

**File:** `packages/types/src/route.ts:210-230` defines `sanitizeForLogs` (now elides
`tool_call` args and `tool_result` content) — but a repo-wide search finds **zero call sites**
in `packages/`/`apps/` source (only the dist + the definition). Design §10 asserts "tool
args/results never hit the logs (elided by `sanitizeForLogs`)."

**Assessment:** No **active** leak found — the gateway/engine `log(...)` calls record ids,
provider, counts, not message content. But the elision is a guarantee with no enforcement, so
any future log line that dumps `messages` would leak args silently. The CLI prints args to
**stderr** (`apps/cli/src/commands/chat.ts:193`) — intended local display for the user who
owns the keys, acceptable.

**Fix:** either wire `sanitizeForLogs` into the one place request messages could be logged
(or a debug trace), or add a lint/comment marking it the required wrapper. Low priority but
closes the contract.

---

## INEFFICIENT / minor RISKs in `parseOpenAiSseStream` (`packages/providers/src/utils.ts`)

- **`:208` + `:251` double `yield { done: true }`.** When a `finish_reason` frame arrives
  the generator yields `{done:true}` (`:208`) but does not return, then yields `{done:true}`
  again at stream end (`:251`). Harmless (the router/engine consumers ignore `done`) but
  noisy. *Fix:* `return` after the terminal yield, or track a `doneYielded` flag.
- **`:216-239` trailing-buffer path ignores `tool_calls`.** If a provider closes the
  connection with an unterminated final SSE line carrying a `tool_calls` fragment, that
  fragment is dropped — the trailing block only reads `delta.content`. Completed-line
  fragments are still flushed by the `:243` safety net, so this only loses a fragment that
  arrived in the final partial line. *Fix:* run `accumulateToolCalls` in the trailing block
  too, before the `:243` flush.
- **`:66-76` malformed-args → `arguments: {}`.** Design R2 said *skip* on malformed; the
  implementation emits the call with empty args instead, which can hand the model a wrong
  zero-arg call. The web client does the same (`apps/web/lib/gateway.ts:641-645`). Defensible
  (never crash the stream) but worth a comment that an empty-arg call is a possible artifact.

---

## CORRECT — verified, no action

- **Parallel `toolCalls` channel is always read AFTER the text stream drains** (hunt item 3).
  Router fills `collectedToolCalls` by reference as `textStream` drains
  (`factory.ts:738`, push at `:755`, returned by reference `:847`); engine forwards the same
  reference (`engine.ts:844`); gateway reads it post-drain in both the non-streaming path
  (`handler.ts:1010`, after the `:988` drain loop) and the streaming path (`:1144`, after the
  `:1122` break); CLI reads it after `for await` (`chat.ts:189`). No read-before-drain hole.
- **OpenAI fragment accumulation** keys by `index`, takes `id`/`name` from the first
  fragment, concatenates `arguments` across deltas, tolerates interleaved indices via the
  `Map`, and parses once on `finish_reason` (`utils.ts:90-113`, `:56-87`). The web client
  mirrors it correctly (`apps/web/lib/gateway.ts:620-652`).
- **Router capability gate + model fan-out filter:** the `requiresTools` gate
  (`factory.ts:578-585`) hard-errors `unsupported_capability` with no tool-capable
  candidate; the per-provider fan-out (groq 70B→8B, openrouter free models) is filtered by
  `supportsTools` so failover never lands on a non-tool model (`:671-679`). Forced non-tool
  provider hard-errors via the same gate. Honest, no silent downgrade here.
- **Gemini schema normalizer** recursively strips non-OpenAPI keywords into a fresh object,
  never mutating input (`gemini.ts:39-60`), and `tools`/`toolConfig` merge with native search
  rather than overwrite (`:316-336`).
- **Gateway honest 422** (`UNSUPPORTED_TOOLS_ERROR` at `handler.ts:113`), explicit-provider
  gate (`:708`), and request-shape disambiguation of the shared `unsupported_capability`
  error (`:902-909`) all mirror the shipped vision gates faithfully.

---

## Recommended fix order

1. **BUG-1** (schema + `parseMessages`) — without it the feature's whole reason for existing
   (the loop) is unreachable over HTTP.
2. **BUG-3** (Tokzen skip) and **BUG-2** (cache-read skip) — both must land with BUG-1, else
   the continuation turn that BUG-1 unblocks is corrupted/short-circuited.
3. **RISK-1** (Gemini cross-turn id uniqueness).
4. Minor: utils double-`done`, trailing-buffer tool-call drop, `sanitizeForLogs` wiring.
