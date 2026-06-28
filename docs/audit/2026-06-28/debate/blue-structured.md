# BLUE TEAM — Structured / JSON Output (rebuttal)

Adjudication of each red-team charge against the actual code on
`feat/tool-calling`. Verdicts: CONFIRMED / REFUTED / PARTIAL, each with proof.

---

## 1. Streaming strict-422 gap — **CONFIRMED (CRITICAL, must-fix)**

The 422-on-invalid gate is **inside** the non-streaming branch. Trace:

- `apps/gateway/src/handler.ts:985` opens `if (body.stream === false) {`.
- The strict gate lives at `:1038` — `if (structuredOutput && body.response_format?.strict && !structuredOutput.valid)` → returns 422. It is wholly contained in the `stream === false` block (block runs `:985`–`:1088`).
- The streaming branch (`const stream = new ReadableStream` at `:1090`) emits the structured frame at `:1225`–`:1242` with `structured_output: structuredOutputBody(structuredOutput)` (carrying `valid:false`) but **never** alters status. The `Response` is constructed `200` at `:1275`.
- Default is streaming: `stream: body.stream !== false` (`:873`). So a strict `json_schema` request that omits `stream:false` and fails validation after repair gets **HTTP 200 + SSE frame `valid:false` + non-conformant prose deltas**.

The documented contract at `:1034`–`:1036` ("a STRICT request whose output did NOT validate … return 422") therefore holds **only** on the `stream:false` minority path. The headline charge is real and the default path violates the honesty contract.

Note: the 422 at `:908`–`:915` (`unsupported_capability`) covers routing-time rejection (no capable provider), NOT post-repair `valid:false` — it does not save the streaming path.

**Minimal fix:** before opening the SSE stream, mirror the `:1038` gate — when `structuredOutput && body.response_format?.strict && !structuredOutput.valid`, return the 422 JSON body instead of `new Response(stream …)`. The response is already fully buffered (engine holds the whole doc), so nothing is lost by not streaming.

---

## 2. OpenAI strict: required-without-nullable — **CONFIRMED but LATENT (HIGH; fix before promotion)**

The transform is exactly as charged. `packages/providers/src/openai-compat.ts:217`–`:219`:
`out.required = Object.keys(normalizedProps); out.additionalProperties = false;`
— it forces **every** property into `required` and **never** adds `"null"` to a formerly-optional field's `type`. So OpenAI strict mode would force the model to emit a non-null value for a field the caller marked optional (fabrication). The doc-comment (`:194`–`:195`, "OpenAI treats an absent-but-required key as nullable") is misleading — OpenAI's recipe requires the field's `type` union to include `"null"`, which this never does.

**Reachability — agree with red, latent.** No OpenAI-compat provider is `json_schema` in `MODEL_CAPABILITIES` (`capabilities.ts:61`–`:74`: only `gemini` is `json_schema`, and Gemini uses its own adapter, not `openai-compat`). `JSON_SCHEMA_MODELS` lists only Gemini models (`:181`–`:189`). So `toOpenAiResponseFormat` never receives `level:"json_schema"` today and `normalizeOpenAiStrictSchema` is not on a live path. It is exported + unit-tested and goes live the instant any compat provider/model is promoted to `json_schema`.

**Fix:** for each formerly-optional key add `"null"` to its `type` (union form) when forcing it `required`, or keep the original `required` set and rely on `additionalProperties:false`.

---

## 3. Gemini `normalizeSchema` drops `oneOf`/constraints → typeless node / 400 — **CONFIRMED (HIGH, must-fix)**

`ALLOWED_SCHEMA_KEYS` (`packages/providers/src/providers/gemini.ts:29`–`:44`) is:
`type, properties, items, required, enum, description, format, nullable, anyOf, minimum, maximum, minItems, maxItems, default`.

Dropped (not in the set, stripped at `:52` `if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;`): **`oneOf`, `allOf`, `not`, `const`, `pattern`, `minLength`, `maxLength`, `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`, `additionalProperties`, `$ref`.** Note `anyOf` **is** preserved (`:38`, `:72`–`:73`), so red's proposed `oneOf→anyOf` mapping is viable.

- Scenario A confirmed: a property `{oneOf:[…]}` → `oneOf` stripped → property collapses to `{}` (typeless). Gemini's `responseSchema` requires `type` per node → 400.
- No-failover confirmed: a status-400 `ProviderHttpError` is not 429/5xx/network, so `shouldFailover` is false (`factory.ts:896`–`:911`) — it throws rather than failing over.
- Tool-param reach confirmed: `normalizeSchema` is applied to **tool parameters** at `gemini.ts:345` and to `responseSchema` at `:367` — so the same stripping breaks `oneOf`/`pattern` tool params, on the live default json_schema route.

Scenario B (pattern/minLength stripped → weaker constrained decode → wasted repair round-trips) is also accurate; red correctly concedes `guaranteed` labeling stays **sound** (final Ajv validation is against the original schema), so this is efficiency, not a soundness break.

**Fix:** translate rather than silently drop — map `oneOf`→`anyOf`, inline `$ref`, and either honor the supported subset of constraint keywords or surface an explicit "schema feature unsupported" error instead of emitting a typeless node that 400s opaquely.

---

## 4. Auto-routing always predicts `prompt` → redundant coercion — **CONFIRMED (MED)**

`engine.ts:580`–`:583` calls `structuredOutputLevel(targetProvider as ProviderId, targetModel)` with `targetProvider/targetModel = "auto"` for unforced requests (`:517`–`:518`). In `capabilities.ts:199`–`:210`, with `model:"auto"`: `JSON_SCHEMA_MODELS["auto"]` is undefined, `caps` is undefined (so `caps?.model === "auto"` is false) → returns `"none"`. `providerLevel === "none"` → `predictedLevel` resolves to `"prompt"` for both `json_schema` and `json_object` requested types (`:585`–`:594`) → `coercionMessage(schema, name)` (which `JSON.stringify`s the whole schema) is prepended on **every** auto structured request (`:597`–`:602`), even when the winner (e.g. Gemini) natively serves JSON and the adapter also sets `responseMimeType`/`responseSchema`. Redundant tokens, duplicated/competing schema instruction; "coerces harmlessly" (comment) understates the per-call token cost that scales with schema size. Efficiency only — soundness intact.

---

## 5. `extractJsonObject` first-balanced-span hijack — **CONFIRMED (MED)**

`schemas/src/index.ts:330`–`:350`: whole-body parse first, else `firstBalancedSpan` (`:363`–`:394`) which returns the **first** `{`/`[` span. For `Sure! {} — here is the data: {"answer":42}` the whole-body parse fails, then the first balanced span is the empty `{}`, which parses. For a no-schema `json_object` request `validateOnce` (`engine.ts:622`–`:625`) sets `valid:true` with `parsed = {}`, dropping the real answer. A too-loose schema (`{type:"object"}`) has the same effect. Silently-wrong `parsed` under a `valid:true` honesty label — confirmed.

**Fix:** prefer the last top-level span, or scan all balanced spans and pick the largest / first that validates; reject a trivially-empty object when more content follows.

---

## 6. Repair loop duplicates prior output (≈2× per round) — **CONFIRMED (MED, bounded at 2)**

`engine.ts:635`–`:639` appends `{role:"assistant", content:text}` **and** `{role:"user", content:repairInstruction(text, issues)}`; `repairInstruction` (`schemas/index.ts:410`–`:411`) **also** embeds `rawText` ("Previous output:\n" + rawText). So the invalid output is carried twice per repair round. Real, but bounded — `maxRepairAttempts` is capped at 2 (`engine.ts:546`–`:549`). Efficiency only.

**Fix:** carry the prior output once — drop the assistant turn, or have `repairInstruction` reference the assistant turn instead of re-embedding `rawText`. (Caveat: the assistant turn exists deliberately to preserve role alternation for Gemini per the `:631`–`:634` comment, so prefer trimming the embedded copy in `repairInstruction`.)

---

## 7. Repairs are full provider calls outside the per-chunk watchdog — **CONFIRMED (MED, design tradeoff)**

`dispatchAndDrain` (`engine.ts:551`–`:571`) issues a fresh `router.routeAndStream` and drains it **inside** the engine, up to 3× total (`:603`, `:630`–`:644`) before resolving back to the gateway. Each dispatch independently reserves quota / `recordUsage`s a distinct request debit in the ledger. Because the drains complete inside `engine.routeAndStream`, the gateway's per-chunk `withIdleWatchdog` (`handler.ts:994` / streaming `:1100`) never wraps them — only the single `withTimeout(engine.routeAndStream, requestTimeoutMs)` at `:849` bounds the whole multi-call sequence. So a provider that opens then stalls mid-repair hangs until the start-timeout budget, and the extra quota burned isn't surfaced in `structured_output` metadata (which reports `repair_attempts` but not the extra request/token debits). Accurate; severity MED. More an honest design limitation than a defect.

---

## 8. Eager `extractJsonObject` at `engine.ts:606` is dead work — **CONFIRMED (LOW)**

`let extracted = extractJsonObject(text)` at `:606` is overwritten by `validateOnce()` (invoked at `:629`), which re-runs `extracted = extractJsonObject(text)` at `:612`, before the `:606` value is ever read. One redundant full text scan + parse per structured request. Trivial fix: initialize `extracted` without the eager call.

---

## 9. Validator cache is FIFO, not LRU — **CONFIRMED (LOW)**

`schemas/src/index.ts:273`–`:279`: `cacheValidator` evicts `validatorCache.keys().next().value` — the **oldest by insertion order**. `compileValidator` (`:284`–`:288`) on a cache hit returns the cached validator but does **not** `delete`+re-`set` the key, so reuse never refreshes recency. A hot startup schema is evicted purely for being inserted first under churn, forcing an Ajv recompile. The comment "keeps the cache warm for recent schemas" overstates what insertion-order eviction guarantees. Fix: on hit, `delete` then `set` to make it true LRU.

---

## Summary

| # | Charge | Verdict |
|---|--------|---------|
| 1 | Streaming strict-422 gap | **CONFIRMED — CRITICAL, must-fix** |
| 2 | OpenAI strict required-without-nullable | CONFIRMED but **LATENT** (fix before promoting any compat json_schema model) |
| 3 | Gemini drops `oneOf`/constraints → 400 | **CONFIRMED — HIGH, must-fix** (live default route) |
| 4 | Auto always predicts `prompt` | CONFIRMED (MED, efficiency) |
| 5 | First-balanced-span hijacks `parsed` | CONFIRMED (MED) |
| 6 | Repair loop duplicates output | CONFIRMED (MED, bounded) |
| 7 | Repairs outside per-chunk watchdog | CONFIRMED (MED, tradeoff) |
| 8 | Dead eager `extractJsonObject` | CONFIRMED (LOW) |
| 9 | FIFO not LRU cache | CONFIRMED (LOW) |

No charge refuted. Must-fix: **#1** (default-path honesty breach) and **#3** (legal schemas opaque-400 on the live Gemini route, incl. tool params). **#2** is real but latent — gate it before promoting any OpenAI-compat model to `json_schema`.
