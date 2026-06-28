# RED TEAM — Structured / JSON Output (feat/tool-calling)

Adversarial audit of the structured-output feature. Each charge: location, a
concrete falsifiable scenario, severity, and a proposed fix. Read-only.

Scope reviewed: `packages/providers/src/capabilities.ts`,
`packages/router/src/factory.ts`, `packages/providers/src/openai-compat.ts`,
`packages/providers/src/providers/gemini.ts`, `packages/schemas/src/index.ts`,
`packages/engine/src/engine.ts`, `apps/gateway/src/handler.ts`,
`packages/types/src/route.ts`.

---

## 1. CRITICAL — Strict-schema `422` is silently skipped on the streaming (default) path

**Where:** `apps/gateway/src/handler.ts:1038-1052` (the only 422-on-invalid gate)
lives inside the `if (body.stream === false)` branch. The streaming branch
(`apps/gateway/src/handler.ts:1225-1242`) emits the `structured_output` frame
with `valid:false` but **never changes the HTTP status** — the `Response` was
already created `200` at `:1275`.

**Scenario:** Client POSTs `{"response_format":{"type":"json_schema","strict":true,
"schema":{…}}}` and does **not** set `stream:false`. The gateway default is
`stream: body.stream !== false` (`:873`) → streaming. The engine buffers,
exhausts repairs, and returns `valid:false`. The client receives **HTTP 200**
with a terminal SSE frame `structured_output:{guaranteed:false,valid:false}` and
non-conformant prose in the text deltas. The documented honesty contract ("a
STRICT request whose output did NOT validate … is an honest hard failure — return
422", `:1034-1036`) holds **only** for the minority `stream:false` callers. The
overwhelming default path violates it.

**Severity:** CRITICAL (honesty contract breached on the default code path).

**Fix:** For a strict request, force the buffered/non-streaming response shape (it
is already fully buffered by the engine — there is nothing to stream), or emit the
422 JSON body instead of opening the SSE stream when
`structuredOutput && body.response_format?.strict && !structuredOutput.valid`.
Mirror the `:1038` gate before `new Response(stream …)`.

---

## 2. HIGH — `normalizeOpenAiStrictSchema` forces optional fields `required` WITHOUT making them nullable, corrupting caller semantics

**Where:** `packages/providers/src/openai-compat.ts:218-219`:
`out.required = Object.keys(normalizedProps); out.additionalProperties = false;`

**Scenario:** Caller schema `{type:"object",properties:{a:{type:"string"},
b:{type:"string"}},required:["a"]}` — `b` is intentionally optional. The
normalizer lists **both** `a` and `b` in `required` but leaves `b`'s type as
`"string"` (no `"null"` added). OpenAI strict mode then forces the model to emit
a non-null `b` — the model **invents** a value for a field the caller wanted
omitted. The function's own doc-comment ("OpenAI treats an absent-but-required key
as nullable") is wrong: OpenAI only tolerates this when the field's `type` union
**also** includes `"null"`, which this transform never adds. Post-hoc the engine
validates against the *original* schema (where `b` is optional) so validation
passes — masking that the provider was handed a stricter, semantically-different
schema and fabricated data.

**Reachability (honest):** Currently latent — no OpenAI-compat provider is
`json_schema` in `MODEL_CAPABILITIES`, so `toOpenAiResponseFormat` never receives
`level:"json_schema"`. But it is an **exported, unit-tested** function presented as
"the OpenAI strict contract"; it becomes live the instant any compat model is
promoted in `JSON_SCHEMA_MODELS`/`MODEL_CAPABILITIES`.

**Severity:** HIGH (latent semantic-corruption bug + misleading contract).

**Fix:** For each formerly-optional key, add `"null"` to its `type` (union form)
when forcing it into `required`, per OpenAI's documented optional-field recipe; or
keep the original `required` set and rely on `additionalProperties:false` alone.

---

## 3. HIGH — Gemini `normalizeSchema` silently drops `oneOf`/`allOf`/`pattern`/length & numeric-precision keywords, yielding a typeless node Gemini rejects (→ opaque 400)

**Where:** `packages/providers/src/providers/gemini.ts:29-44` (`ALLOWED_SCHEMA_KEYS`)
+ `:49-79`. The allow-list omits `oneOf`, `allOf`, `not`, `const`, `pattern`,
`minLength`, `maxLength`, `multipleOf`, `exclusiveMinimum/Maximum`,
`additionalProperties`, `$ref`.

**Scenario A (correctness → 400):** A discriminated-union schema
`{type:"object",properties:{x:{oneOf:[{type:"string"},{type:"number"}]}}}`.
`oneOf` is not in the allow-list → stripped → `x` becomes `{}` (typeless). Gemini's
`responseSchema` requires a `type` on each node and returns HTTP 400. That 400 is a
`ProviderHttpError` with status 400 — not 429/5xx, so the router does **not**
fail over (`factory.ts:908-911`), it throws; the gateway's outer catch surfaces it
as a generic **400** (`handler.ts` tail). A perfectly legal JSON-Schema strict
request dies with an opaque error. `normalizeSchema` is also used for **tool
parameters** (`gemini.ts:345`), so the same stripping breaks `oneOf` tool params.

**Scenario B (wasted calls):** A schema with `pattern`/`minLength`/`multipleOf`
constraints — those keywords are stripped, so Gemini's constrained decode is
**weaker** than the schema. The model emits values violating the dropped
constraints; the engine validates against the *full* original schema (Ajv) → fails
→ triggers repair round-trips (extra real provider calls) that a faithful schema
would have avoided. (Note: `guaranteed` labeling stays *sound* here because final
validation is against the original schema — but at the cost of wasted calls.)

**Severity:** HIGH (legal schemas 400; plus wasted provider calls).

**Fix:** Translate rather than drop: map `oneOf`→`anyOf` (Gemini accepts `anyOf`),
inline `$ref`, and either honor the supported subset of `pattern`/length keywords
or surface an honest "schema feature unsupported" error instead of a silent strip.

---

## 4. MED — Under auto-routing the engine ALWAYS predicts `prompt`, injecting a full-schema coercion system message even when the winner natively supports JSON

**Where:** `packages/engine/src/engine.ts:580-602`. `structuredOutputLevel(
targetProvider as ProviderId, targetModel)` is called with
`targetProvider="auto"` / `targetModel="auto"` for any unforced request (see
`:517-518`). `MODEL_CAPABILITIES["auto"]` is `undefined` → `structuredOutputLevel`
returns `"none"` → `predictedLevel` resolves to `"prompt"` → the full
`coercionMessage(schema, name)` (which `JSON.stringify`s the entire schema,
`:74-79`) is prepended on **every** auto-routed structured request.

**Scenario:** Auto request with `response_format:{type:"json_object"}` wins on
Gemini (native JSON). The engine still prepends a `system` coercion message
containing the stringified schema; the Gemini adapter *also* sets
`responseMimeType`/`responseSchema`. Redundant token spend on every auto
structured call, and a duplicated/competing schema instruction. The code comment
calls this "coerces harmlessly" — it is wasteful, not harmless, and scales with
schema size.

**Severity:** MED (efficiency; every auto structured request over-pays).

**Fix:** Predict the level from the *resolved winner* (thread the resolved level
back out of the first dispatch and only prepend coercion when the served level is
actually `prompt`), or skip coercion when the request will hit a native provider.

---

## 5. MED — `extractJsonObject` returns the FIRST balanced span, so an incidental `{}`/`[]` in prose hijacks `parsed` (wrong value, `valid:true`)

**Where:** `packages/schemas/src/index.ts:344-348` + `firstBalancedSpan`
(`:363-394`). After a whole-body parse fails, it returns the first balanced span.

**Scenario:** A `prompt`/`json_object`-level model answers
`Sure! {} — here is the data: {"answer":42}`. Whole-body parse fails (prose);
`firstBalancedSpan` finds the first `{` (the empty `{}`) and returns `"{}"`, which
parses. For a `json_object` request with **no schema**, `validateOnce`
(`engine.ts:621-626`) sets `valid:true` and `parsed = {}`. The gateway returns
`parsed:{}` / `valid:true` while the model's real answer `{"answer":42}` is
dropped. For a schema'd request a too-loose schema (e.g. `{type:"object"}`) has the
same effect.

**Severity:** MED (silently wrong `parsed` with a `valid:true` honesty label).

**Fix:** Prefer the **last** top-level balanced span, or scan all balanced spans
and pick the largest / the first that validates against the schema; for the
no-schema case, reject a trivially-empty object when more content follows.

---

## 6. MED — Repair loop duplicates the prior output in context (assistant turn AND embedded inside the repair instruction) — ~2× token growth per round

**Where:** `packages/engine/src/engine.ts:635-639` appends
`{role:"assistant",content:text}` **and** `{role:"user",content:repairInstruction(
text, issues)}`. `repairInstruction` (`schemas/index.ts:402-419`) **also** embeds
the full `rawText` ("Previous output:\n" + rawText).

**Scenario:** A 3 KB invalid JSON output → each repair round adds ~6 KB (the text
twice). Two rounds ≈ 12 KB of redundant context plus the original schema coercion,
all re-sent on each re-dispatch — inflating input tokens (billed/quota-debited) and
risking context-window pressure on the smaller free models the router targets.

**Severity:** MED (efficiency; quadratic-ish context inflation, bounded at 2).

**Fix:** Send the prior output **once** — either drop the assistant turn and keep
it only inside the instruction, or have `repairInstruction` reference the assistant
turn rather than re-embedding `rawText`.

---

## 7. MED — Each repair re-dispatch is a full provider call (separate quota debit + ledger request) NOT covered by the gateway's per-chunk idle watchdog

**Where:** `packages/engine/src/engine.ts:551-571` (`dispatchAndDrain` → fresh
`router.routeAndStream` + raw `for await` drain) invoked up to 3× (`:603-644`).
Each call independently reserves quota and `recordUsage`s a distinct request/token
debit in the ledger. The drains run **inside** `engine.routeAndStream`, before it
resolves to the gateway, so the gateway's per-chunk `withIdleWatchdog`
(`handler.ts:994` / `:1100`) never wraps them — only the single 60 s
`withTimeout(routeAndStream)` (`:849`) bounds the entire 3-call sequence.

**Scenario:** A strict request that needs 2 repairs makes 3 upstream calls and 3
ledger request-debits for one user request (legitimate, but undisclosed in the
`structured_output` metadata, which reports `repair_attempts` but not the extra
quota burned). A provider that opens then stalls mid-repair-drain hangs until the
60 s start-timeout — finer idle protection does not apply.

**Severity:** MED (quota amplification + weaker stall protection on repairs).

**Fix:** Wrap the per-attempt drain in the same idle watchdog; surface
repair-call quota cost; consider a tighter per-attempt deadline so 3× stalls can't
consume the full 60 s budget.

---

## 8. LOW — `validateOnce` re-parses the text; the eager `extractJsonObject` at engine.ts:606 is dead work

**Where:** `packages/engine/src/engine.ts:606` `let extracted = extractJsonObject(
text)` is immediately overwritten by `validateOnce()` (`:611-613`) at `:629`
before it is ever read.

**Scenario:** Every structured request runs `extractJsonObject` (a full text scan +
JSON.parse attempt, including `firstBalancedSpan`) one extra time with its result
discarded.

**Severity:** LOW (redundant pass).

**Fix:** Initialize `extracted` without calling `extractJsonObject`, or drop the
eager call and let `validateOnce()` populate it.

---

## 9. LOW — Validator cache evicts by **insertion order**, not recency, so a hot early schema is evicted under churn

**Where:** `packages/schemas/src/index.ts:271-279` (`MAX_VALIDATOR_CACHE`,
`cacheValidator` deletes `validatorCache.keys().next().value` — the oldest by
insertion).

**Scenario:** One frequently-used schema compiled at startup, then >200 distinct
one-off schemas arrive; the hot schema is evicted purely because it was inserted
first, forcing an Ajv **recompile** on its next use despite being the most-used.

**Severity:** LOW (occasional avoidable recompile; the comment claims it "keeps the
cache warm for recent schemas", which insertion-order eviction does not guarantee).

**Fix:** Make it true LRU — on cache hit, `delete` then re-`set` the key so reuse
refreshes recency.

---

## Strongest charges (priority order)
1 (CRITICAL streaming-strict-422 gap), 3 (HIGH Gemini `oneOf`/constraint stripping
→ 400 + wasted calls), 2 (HIGH OpenAI strict required-without-nullable),
5 (MED wrong-span `parsed`), 4 (MED always-prompt over-coercion).
