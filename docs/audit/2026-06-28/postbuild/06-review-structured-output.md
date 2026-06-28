# Post-build Review — Structured / JSON Output (2026-06-28)

Branch `feat/tool-calling`. Scope: the buffer→validate→repair structured-output
path. Suite (971) is green; the findings below are gaps the tests do not exercise
plus efficiency wins. Traced: `types/route.ts` → `capabilities.ts` →
`router/factory.ts` → `openai-compat.ts`/`gemini.ts`/`ollama.ts` →
`schemas/index.ts` → `engine.ts` → `handler.ts`.

---

## BUG — `guaranteed`/`served_level` over-claim (honesty bug, headline)

`packages/engine/src/engine.ts:591-597`

```ts
const level = structuredOutputLevel(structuredResult.providerId, structuredResult.model);
const servedLevel = level === "none" ? "prompt" : level;
const guaranteed = servedLevel === "json_schema" && valid;
```

The engine recomputes `servedLevel` from the winner's **raw provider capability**,
**not** the level that was actually served. The router resolves the real level
per-candidate in `resolveResponseFormat` (`factory.ts:34-54`) but that result is
**never returned up** — `RouteStreamResult` (`types/route.ts:302-328`) has no
served-level field, so the design §6.1 "returned up to the engine" path was not
implemented.

Concrete failure: a `type:"json_object"` request (no schema) routed to **gemini**
→ `resolveResponseFormat` sends `json_object` (responseMimeType only, no
`responseSchema`); `validateOnce` (`engine.ts:572-576`) sets `valid=true` on any
syntactic JSON because `schema` is undefined; but the engine reports
`served_level:"json_schema"`, `guaranteed:true`. So a request that enforced and
validated **no schema at all** is labeled provider-guaranteed schema-conformant.
This is precisely the honesty bar the whole design exists to defend (§0).

Fix: thread the resolved level out of the router on `RouteStreamResult` and use
it for `servedLevel`; `guaranteed` must be `served_level==="json_schema" && schema != null && valid`.
No test covers a `json_object` request to a `json_schema`-capable provider — add one.

## BUG — repair loop omits the assistant turn → consecutive user messages

`packages/engine/src/engine.ts:580-588`

```ts
convoMessages = [...convoMessages, { role: "user", content: repairInstruction(text, issues) }];
```

The design flow (§5.1) inserts `{role:"assistant", content:text}` **before** the
repair `user` message. The implementation appends only the user message, so the
history becomes `[…user, user(repair)]` (and on a 2nd repair, three consecutive
`user` turns). **Gemini requires alternating roles** — `userParts`/contents with
back-to-back user turns are rejected or silently merged, so the repair path can
hard-fail on exactly the provider that is the default `json_schema` route. Tests
use OpenAI-compat fixtures (lenient on alternation), so this is invisible.
Fix: append the assistant turn carrying the prior output, then the user repair.

## BUG — prompt-level coercion never implemented

The design (§3, §5.3) specifies `coercionSystemMessage(schema, name)` injected by
the engine for the `prompt` level. It does **not exist** in `schemas/index.ts`,
and the engine's structured branch dispatches `effectiveMessages` unchanged
(`engine.ts:552-554`) with **no** JSON instruction. Effect: for every `prompt`-
level provider (`cohere`, `huggingface`, `lmstudio`, and any `none` default) the
**first** attempt has zero guidance to emit JSON → it returns prose → guaranteed
validation failure → a wasted real provider call (quota + latency) before the
`repairInstruction` finally steers it. Add the coercion message and inject it
before the first dispatch for `prompt`-resolved requests.

## RISK — ollama adapter ignores `responseFormat`

`packages/providers/src/providers/ollama.ts:21-39` never reads
`options.responseFormat`. The registry marks ollama `structuredOutput:"json_object"`
(`capabilities.ts:73`), so a json_object request resolves to `json_object` and the
engine expects native JSON mode, but the adapter sends no `format:"json"`/`format:<schema>`.
First attempt is plain chat → likely prose → forced repair. Either emit Ollama's
`format` field (design §6.2) or drop ollama to `none`.

## RISK — Ajv validator cache is unbounded

`packages/schemas/src/index.ts:237` `validatorCache = new Map()` is module-level
and never evicted, keyed by `JSON.stringify(schema)`. In the long-running gateway
every distinct incoming schema permanently retains a compiled Ajv validator (heavy
objects) — a high-cardinality or hostile caller grows memory without bound (the
§10.6 "hostile schema" DoS, only partially mitigated by the edge size cap). Bound
it (LRU with a cap). Also `JSON.stringify(schema)` is recomputed on **every**
`validateJson` call for the cache key — minor per-call cost on the hot path.

## RISK — strict 422 enforced only on the non-streaming path

`handler.ts:1032` returns 422 `structured_output_invalid` for
`strict && !valid` — but only in the JSON branch. The streaming branch
(`handler.ts:1219-1235`) has already streamed the (possibly non-conforming) prose
as a block and then appends `structured_output{valid:false}` with no error frame.
A `stream:true` strict request that fails validation thus leaks prose with a 200,
violating §0.1/§5.2 honesty for the streaming case. Emit an SSE error frame (not a
200 terminal) when `strict && !valid` in the stream path.

## INEFFICIENT / incomplete

- `engine.ts:556` `extractJsonObject(text)` is immediately redone inside
  `validateOnce` (`:562`) — one redundant parse of the initial response.
- OpenAI strict normalizer (design §6.3: force `additionalProperties:false` +
  all-required, reject un-strictifiable schemas) is **not** applied in
  `toOpenAiResponseFormat` (`openai-compat.ts:202-223`); `strict:true` is sent
  with the raw schema. Currently unreachable (no OpenAI-compat model is in
  `JSON_SCHEMA_MODELS`), but the moment one is added, OpenAI 400s the request.
- Repair messages accumulate cumulatively and each `repairInstruction` re-embeds
  the full prior `rawText` (`schemas/index.ts:360-377`), so a 2nd repair carries
  both instructions + both outputs — growing context per round.

---

## CORRECT (verified, no action)

- **Repair termination + cap.** `maxRepairAttempts = Math.min(req ?? 2, 2)`,
  loop `while (!valid && repairAttempts < maxRepairAttempts)` with a pre-increment
  — no infinite loop, no off-by-one; negative/huge caller values are clamped
  (`engine.ts:525-528,580-589`). `repair_attempts` reports the true round-trip count.
- **No double engine-side effects.** Repairs re-dispatch through `router.routeAndStream`
  directly (not `engine.routeAndStream`); user message persisted once pre-loop,
  assistant once post-loop; all attempts share one `traceId`/`onAttempt`
  (`engine.ts:499-509,604-615`). Quota debit per repair is intentional (§5.4).
- **Buffering preserves stream consumers.** Final text replays as one chunk via
  `replayStream` (`engine.ts:641-648`); `.stream` stays `AsyncIterable<string>`.
- **Router strict gate + gateway explicit-provider gate** hard-error
  (`factory.ts:593-601`, `handler.ts:715-724`) — no silent downgrade.
- **`extractJsonObject`** tracks strings/escapes in `firstBalancedSpan`
  (`schemas/index.ts:321-352`) so nested/stringy braces don't desync the depth
  count; whole-body parse handles fenced + scalar JSON first.
- **Ajv `strict:false`** lets vendor schemas (Gemini `propertyOrdering`, etc.)
  compile instead of throwing; `validateJson` never throws on an uncompilable
  schema (`schemas/index.ts:231-278`).
