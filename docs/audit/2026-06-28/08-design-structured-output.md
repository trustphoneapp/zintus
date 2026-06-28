# Design — Structured / JSON-Schema-Constrained Output (2026-06-28)

Status: **DESIGN ONLY** (no code in this doc). Branch baseline
`feat/multimodal-image-input` @ `6bcd097`.

Closes the audit gap: `docs/audit/2026-06-26/VERDICT.md` §6 lists
**"no structured/JSON output"** as a missing table-stakes capability, and §2's
10/10 bar requires *capability-honest routing … hard-error, never silent
downgrade* over a real `model→{vision,tools,json,context}` registry.

This design follows the **multimodal-vision precedent already in the tree**,
which is the cleanest template we have for a capability that must route honestly:

- `requiresVision(messages)` (`packages/types/src/route.ts:69`) →
- router filters candidates with `supportsVision()` and throws
  `unsupported_capability` (`packages/router/src/factory.ts:528-535`) →
- gateway maps it to a 422 honest body `UNSUPPORTED_VISION_ERROR`
  (`apps/gateway/src/handler.ts:95-111,799-801`) →
- web surfaces it via `UnsupportedCapabilityError`
  (`apps/web/lib/gateway.ts:444-457`).

Structured output reuses **exactly this spine**. The single hard new problem the
vision path did not have: **validation happens on the *output*, not the input**,
so it forces a buffer-then-validate(-then-repair) loop and changes the streaming
contract for structured requests. That is the heart of this design.

---

## 0. Honesty bar (the thing this whole design defends)

There are **three distinct levels** of "structured output", and the industry
(and the existing `capabilities.ts` `json: boolean`) routinely conflates them.
We will not.

| Level | What the provider guarantees | Label |
|---|---|---|
| `json_schema` (strict) | Output is **valid JSON that conforms to the supplied schema**, enforced by the provider's constrained decoder. | **GUARANTEED** |
| `json_object` (json mode) | Output is **syntactically valid JSON**, but *not* schema-conformant — field names/types are up to the model. | best-effort (syntax only) |
| `prompt` (emulated) | Nothing. We *ask* for JSON-of-this-shape in the prompt and hope. | **best-effort, NOT guaranteed** |

The current `MODEL_CAPABILITIES[*].json` flag
(`packages/providers/src/capabilities.ts:33,40-52`) is a single boolean that
cannot express this and even mixes "json mode" with "schema strict". **PR-1
replaces it** with a three-state field. Every layer — registry, router, gateway
response meta, web/CLI label — carries the level forward so the user is never
told "structured" when they got "we asked nicely."

Hard rules:

1. A request that demands **GUARANTEED** schema conformance (`strict: true`)
   MUST hard-error (`unsupported_capability`, 422) if no eligible
   provider/model can guarantee it. **Never silently downgrade to `json_object`
   or `prompt`.** (Same contract the vision path enforces.)
2. Even on a GUARANTEED provider, the gateway/engine **still validates** the
   parsed output against the schema before returning it — a constrained decoder
   is trusted but verified (defense in depth; catches dialect-subset gaps,
   §6.3).
3. `json_object` and `prompt` outputs are validated **and** labeled
   `guaranteed: false` in the response meta. On validation failure they enter
   the repair loop (§5); if repair is exhausted the request returns an honest
   error, **not prose**.

---

## 1. Overlap with the tool-calling sibling design (read, then move on)

Structured output and tool calling are the same machinery wearing two hats; a
sibling agent owns tools. To avoid building two of everything:

**Shared (build once, both consume):**
- **Capability-registry shape.** The model→capability table
  (`packages/providers/src/capabilities.ts`) gains *both* a `structuredOutput`
  field (this design) and a `tools` capability (sibling). Same file, same
  per-provider, model-aware accessor pattern as `supportsVision()`.
- **Provider-adapter request-shaping seam.** Both need to inject a new field
  into each provider's request body. We add **one** extension point on
  `StreamChatOptions` (`packages/types/src/stream.ts`) and **one** per-adapter
  body-builder change; tools threads `tools`/`tool_choice` through the same seam.
- **JSON-Schema plumbing.** A tool's `input_schema` *is* a JSON Schema, and on
  some providers (Anthropic-style, and as a fallback elsewhere) structured
  output is literally implemented as "force a single tool whose `input_schema`
  is the user's schema." The JSON-Schema normalization/validation helpers in
  `@zintus/schemas` (§3) are shared by both.

**This design stays focused on:** JSON/schema-constrained *output* —
`response_format`, `responseSchema`, the buffer→validate→repair loop, and the
`json_schema`/`json_object`/`prompt` honesty ladder. We **do not** design tool
dispatch, multi-tool selection, or tool-result turns here. Where a provider's
*only* structured path is tool-forcing (e.g. a hypothetical Anthropic adapter),
we **note** it and consume the sibling's forced-tool primitive rather than
re-implementing it. (Zintus ships **no** Anthropic provider today —
`provider-metadata.ts:9-10` is explicit — so that path is documentation, not
code, in this PR set.)

---

## 2. Type contract (how a caller passes a schema; what comes back)

### 2.1 The request type

New shared type in `packages/types/src/route.ts` (alongside `ContentBlock`),
re-exported from `packages/types/src/index.ts`:

```ts
/** JSON Schema (draft-2020-12 subset) the caller wants the output to conform to.
 *  We accept a *raw JSON Schema object* as the wire type so non-TS callers and
 *  the relay can use it; TS callers can derive one from a Zod schema via the
 *  @zintus/schemas helper (§3.2). */
export type JsonSchema = Record<string, unknown>;

export interface ResponseFormat {
  /** "json_schema" = ask for schema-conformant output (the normal case).
   *  "json_object" = ask only for *valid JSON* (no schema). "text" = default. */
  type: "text" | "json_object" | "json_schema";
  /** Required when type === "json_schema". */
  schema?: JsonSchema;
  /** Human name for the schema (forwarded to providers that want one, e.g.
   *  OpenAI json_schema.name). Defaults to "response". */
  name?: string;
  /** When true, the request DEMANDS a provider that GUARANTEES schema
   *  conformance (level `json_schema`). If none is eligible → hard-error.
   *  When false/undefined, best-effort (json_object/prompt) is permitted and
   *  the response is labeled guaranteed:false. Default: false. */
  strict?: boolean;
  /** Max validate→repair round-trips on a non-conforming response (§5).
   *  0 = validate once, no repair. Default 2. Capped server-side at 2. */
  maxRepairAttempts?: number;
}
```

`RouteRequest` (`packages/types/src/route.ts:90`) gains:

```ts
  /** Structured-output request. Absent ⇒ plain text (unchanged behavior). */
  responseFormat?: ResponseFormat;
```

`StreamChatOptions` (`packages/types/src/stream.ts:1`) gains the **provider-level
seam** — note this is the *resolved provider-native* shape, not the caller shape:

```ts
  /** Structured-output instruction for THIS provider call. The router resolves
   *  the caller's ResponseFormat into the level this provider/model can serve
   *  (json_schema | json_object | prompt) before calling streamChat, so each
   *  adapter only has to emit its own native field for the level it's handed. */
  responseFormat?: ResolvedResponseFormat;
```

```ts
export interface ResolvedResponseFormat {
  level: "json_schema" | "json_object" | "prompt";
  schema?: JsonSchema;      // present for json_schema (and prompt, for coercion)
  name: string;
}
```

### 2.2 The capability predicate (mirrors `requiresVision`)

In `packages/types/src/route.ts`:

```ts
export function requiresStructuredOutput(req: { responseFormat?: ResponseFormat }): boolean {
  return req.responseFormat != null && req.responseFormat.type !== "text";
}
export function requiresGuaranteedSchema(req: { responseFormat?: ResponseFormat }): boolean {
  return req.responseFormat?.type === "json_schema" && req.responseFormat.strict === true;
}
```

### 2.3 The response shape

Non-streaming (`stream:false`) gateway response (`handler.ts:897`) gains a
sibling to `content`, plus an honesty meta block:

```ts
// added to the chat.completion choice / body
parsed?: unknown;                 // the validated object (present iff valid)
structured_output?: {
  requested: "json_object" | "json_schema";
  served_level: "json_schema" | "json_object" | "prompt";
  guaranteed: boolean;            // true ONLY when served_level === "json_schema"
  valid: boolean;                 // passed schema validation
  repair_attempts: number;        // how many repair round-trips were used
};
```

If `valid` is `false` after repair exhaustion, the gateway returns a **422**
`structured_output_failed` error (honest), never a 200 with prose. The Engine
result type (`EngineStreamResult`, `packages/engine/src/engine.ts:88`) carries
the same `structured` metadata so the CLI (which calls the engine directly,
`apps/cli/src/commands/chat.ts:122`) gets it without HTTP.

---

## 3. `@zintus/schemas` — validation/normalization core (reuse Zod, already present)

`packages/schemas` already depends on **Zod `^3.25.76`** (`package.json:18`) and
already owns `formatIssues()` (`src/index.ts:158`). We extend it rather than add
a new dep. New module `packages/schemas/src/structured.ts`:

### 3.1 Edge schema for the request field

Extend `ChatCompletionRequestSchema` (`src/index.ts:98`) and
`ResearchRequestSchema` minimally:

```ts
export const ResponseFormatSchema = z.object({
  type: z.enum(["text", "json_object", "json_schema"]),
  schema: z.record(z.string(), z.unknown()).optional(),
  name: z.string().max(64).optional(),
  strict: z.boolean().optional(),
  maxRepairAttempts: z.number().int().min(0).max(2).optional(),
}).refine(
  (rf) => rf.type !== "json_schema" || rf.schema != null,
  { message: "response_format.type 'json_schema' requires a schema" },
);
// ChatCompletionRequestSchema gets:  response_format: ResponseFormatSchema.optional()
```

The schema object itself is bounded (size cap, depth cap — see §6.5) so a
hostile schema can't blow up validation. Validated at the **edge** (gateway and
relay both import `@zintus/schemas`, the existing pattern at `src/index.ts:8-11`).

### 3.2 JSON-Schema validation (the actual conformance check)

The wire type is a **raw JSON Schema**, so validation needs a JSON-Schema
validator, not just Zod (Zod validates TS-defined schemas; here the schema
arrives as data). Two honest options:

- **Preferred:** add **Ajv** (`ajv` + `ajv-formats`) to `@zintus/schemas` for
  draft-2020-12 validation of arbitrary incoming schemas. Edge-safe (pure JS).
- TS-origin callers (CLI building a schema in code) may pass a **Zod** schema;
  we convert it to JSON Schema via `z.toJSONSchema()` (Zod 3.25+ ships this) so
  there is exactly **one** wire representation downstream.

```ts
export interface ValidationResult {
  valid: boolean;
  data?: unknown;                              // parsed value when valid
  issues?: Array<{ path: string; message: string }>;  // formatIssues-shaped
}

/** Parse model text → JSON (tolerant of ```json fences and leading prose),
 *  then validate against the JSON Schema. Pure, no network. */
export function validateStructured(rawText: string, schema: JsonSchema): ValidationResult;

/** Build the repair instruction fed back to the model on a failed validation. */
export function repairInstruction(rawText: string, issues: ValidationIssue[]): string;

/** Build the prompt-coercion system message for the `prompt` fallback level. */
export function coercionSystemMessage(schema: JsonSchema, name: string): string;
```

`validateStructured` strips Markdown code fences and trailing/leading prose
(common best-effort failure modes) **before** `JSON.parse`, because a
`json_object`/`prompt`-level model often wraps JSON in fences. This is the
single most valuable repair-avoidance step.

---

## 4. Capability registry — split `json` into a 3-state field (the honesty primitive)

`packages/providers/src/capabilities.ts`. Replace the boolean `json` (line 33,
and the `json:` cell on every row at lines 40-52) with:

```ts
/** Strongest structured-output level this model's API GUARANTEES.
 *  "json_schema" = constrained decode to a supplied schema (GUARANTEED).
 *  "json_object" = valid-JSON mode only (NOT schema-conformant).
 *  "none"        = no native structured support; only prompt-emulation. */
export type StructuredLevel = "json_schema" | "json_object" | "none";
// on ModelCapabilities:  structuredOutput: StructuredLevel;
```

Model-aware accessor, **mirroring `supportsVision()` (lines 94-99)** including a
per-model override set for models that differ from the provider default:

```ts
const JSON_SCHEMA_MODELS: Partial<Record<ProviderId, ReadonlySet<string>>> = { /* §4.1 */ };
const JSON_OBJECT_MODELS:  Partial<Record<ProviderId, ReadonlySet<string>>> = { /* §4.1 */ };

/** The structured level supported for a specific model (or the provider default
 *  when model is omitted). Never a whole-provider assumption — same discipline
 *  as VISION_MODELS. */
export function structuredOutputLevel(providerId: ProviderId, model?: string): StructuredLevel;

/** Convenience: does (provider, model) meet the requested level? Used by the router. */
export function supportsStructuredLevel(
  providerId: ProviderId, model: string | undefined, want: "json_schema" | "json_object",
): boolean;
```

Export all four from `packages/providers/src/index.ts` (next to the
`supportsVision` export at line 37).

### 4.1 Provider-by-provider native-vs-emulated mapping

**Values are best-effort against provider docs (reviewed 2026-06) and MUST be
re-verified before relying on them — the same caveat the file already carries at
`capabilities.ts:13-17` and that `data-policies.ts` carries.** Default model is
the one in `MODEL_CAPABILITIES` today.

| Provider (default model) | Native mechanism | Registry `structuredOutput` | Notes / divergence |
|---|---|---|---|
| **gemini** `gemini-2.5-flash` | `generationConfig.responseMimeType:"application/json"` + `responseSchema` | **`json_schema`** | Schema is a **Gemini/OpenAPI 3.0 subset**, *not* full JSON-Schema (no `$ref`, limited `anyOf`, `propertyOrdering`). Needs a normalizer (§6.3). |
| **openrouter** `llama-3.3-70b:free` | OpenAI `response_format` passthrough; strict support is **per-underlying-model** | **`json_object`** default; `json_schema` only for **mapped** strict-capable models | Free Llama route = json_object at best. Strict is model-specific → goes in `JSON_SCHEMA_MODELS`, UNMAPPED until verified+VCR-tested (same stance as `VISION_MODELS`). |
| **fireworks** `llama-v3p1-8b` | OpenAI-compat `response_format` incl. `json_schema` (grammar mode) | **`json_schema`** | Fireworks documents JSON-Schema grammar constraint. Verify per model. |
| **xai** `grok-2-latest` | OpenAI-compat `response_format: json_object`; `json_schema` on newer Grok | **`json_object`** | Strict only on specific models → JSON_SCHEMA_MODELS. |
| **deepseek** `deepseek-chat` | `response_format: json_object` only | **`json_object`** | No schema-strict mode documented → json_object. |
| **mistral** `mistral-large-latest` | `response_format: json_object`; `json_schema` on recent | **`json_object`** (default) | Strict via JSON_SCHEMA_MODELS where verified. |
| **cerebras** `llama-3.3-70b` | OpenAI-compat `response_format` incl. `json_schema` | **`json_schema`** | Cerebras documents structured-outputs/json_schema. Verify. |
| **groq** `llama-3.3-70b-versatile` | `response_format: json_object`; `json_schema` on some models | **`json_object`** (default) | Strict per model → JSON_SCHEMA_MODELS. |
| **cohere** `command-r-plus` | `response_format:{type:"json_object", schema}` (Cohere native) | **`json_object`** (treat schema as best-effort) | Current registry `json:false`. Cohere's schema field is not a strict decoder guarantee on free tier → classify `json_object`, not `json_schema`. |
| **huggingface** `Llama-3.3-70B` | none reliable via Inference API | **`none`** | Current `json:false`. Prompt-emulation only. |
| **ollama** `llama3.3` (local) | `format:"json"` (json mode) and `format:<schema>` (structured) | **`json_object`** default; `json_schema` is **runtime-detected**, not asserted | Ollama supports schema `format`, but capability depends on the locally-pulled model. Same rule as vision-local: **never asserted statically**; the gateway/local-runtimes layer decides. Registry default stays conservative. |
| **lmstudio** `local-model` | OpenAI-compat `response_format` (varies by loaded model) | **`none`** statically | Runtime-detected only. |
| **anthropic** | *(no Zintus adapter)* | n/a | Doc-only: native path is **forced tool with `input_schema`** (the sibling tools primitive). Not shipped here. |

The exact `json_schema`-capable model id sets live in `JSON_SCHEMA_MODELS` and
start **mostly empty** for providers where strict is model-specific, exactly
like `VISION_MODELS` starts with only gemini. We add an id **only when a VCR
fixture proves it** (§7).

---

## 5. Validation / repair loop (the new control flow)

Structured output cannot be a pure pass-through stream: we must hold the whole
output to validate it. The loop lives in **the engine** (`engine.ts
routeAndStream`, around the `wrappedStream` at line 573), because repair needs to
re-dispatch through the router, and the engine already wraps/persists the stream.
The router stays the *single dispatch* primitive; the engine orchestrates repair.

### 5.1 Flow

```
routeAndStream(req with responseFormat):
  resolved = resolveLevelFor(req)            # router picks provider+level (§6.1)
  text     = drain(router.routeAndStream(req with options.responseFormat=resolved))
  result   = validateStructured(text, schema)
  attempts = 0
  while !result.valid and attempts < min(req.maxRepairAttempts ?? 2, 2):
     attempts++
     repairMsgs = [...messages,
                   {role:"assistant", content:text},
                   {role:"user", content: repairInstruction(text, result.issues)}]
     text   = drain(router.routeAndStream({...req, messages:repairMsgs}))
     result = validateStructured(text, schema)
  emit { content:text, parsed: result.data, structured:{ served_level, guaranteed,
         valid: result.valid, repair_attempts: attempts } }
```

### 5.2 Streaming contract change (call it out loudly)

- **Structured requests are buffered, not token-streamed**, because validation
  needs the full document and repair may replace it entirely. The gateway
  `stream:true` path for a structured request emits the validated JSON as a
  **single terminal SSE data event** plus the `metadata` event, rather than
  incremental deltas. This is honest (we cannot stream a value we might discard)
  and documented in the OpenAPI description. Token-level partial-JSON streaming
  is explicitly **out of scope** (a future enhancement; see Risks §8).
- The existing non-streaming path (`handler.ts:870-896`) already buffers, so
  `stream:false` is the natural home and needs only the `parsed`/`structured`
  fields added.

### 5.3 Where each level's prompt-shaping happens

- `json_schema` / `json_object`: the **provider adapter** emits the native field
  (§6.2). No prompt mutation.
- `prompt` (emulated): the **router/engine** prepends
  `coercionSystemMessage(schema, name)` to the messages *before* dispatch, and
  the adapter sends plain text. This is the **only** level that mutates the
  prompt. The coercion message must be injected **after** Tokzen
  (`handler.ts:689-722` already skips compression for images; structured
  coercion text is tiny but must not be compressed away — inject it in the
  engine, downstream of the gateway's Tokzen step, same as the vision bypass
  reasoning).

### 5.4 Cost / quota honesty

Each repair round-trip is a **real provider call** and debits quota via the
ledger like any other (`factory.ts:670`). The `repair_attempts` count is
surfaced so the user sees that a best-effort response cost N tries. Repair is
**capped at 2** server-side regardless of request, to bound quota burn.

---

## 6. Router — capability-honest selection & hard-error

`packages/router/src/factory.ts`, in `routeAndStream`, **immediately after the
vision filter block (lines 528-535)** — same shape, same throw:

```ts
// Structured-output routing: a structured request MUST go to a provider/model
// that supports the REQUESTED level. Strict (json_schema) demands a GUARANTEED
// provider or we hard-error — never silently downgrade to prose/json_object.
if (requiresStructuredOutput(request)) {
  const want = request.responseFormat!.type;            // json_object | json_schema
  const strict = requiresGuaranteedSchema(request);
  if (strict) {
    candidates = candidates.filter((c) => supportsStructuredLevel(c.id, request.model, "json_schema"));
    if (candidates.length === 0) throw new Error("unsupported_capability");
  }
  // non-strict: keep all candidates; the level each one gets is resolved per-pick.
}
```

### 6.1 Per-pick level resolution

`supportsStructuredLevel` cannot decide the *served* level until a candidate is
chosen (the loop at `factory.ts:556` tries candidates in order). For each
candidate the router computes:

```
resolvedLevel(provider, model, want, strict):
  native = structuredOutputLevel(provider, model)     // json_schema | json_object | none
  if want === "json_schema":
     if native === "json_schema" → "json_schema"       # GUARANTEED
     else if strict              → (already filtered out; unreachable)
     else if native === "json_object" → "json_object"  # best-effort, labeled
     else                        → "prompt"             # emulated, labeled
  else /* want json_object */:
     native === "none" ? "prompt" : "json_object"
```

The resolved level is passed as `options.responseFormat` to `streamChat`
(`factory.ts:607`) **and** returned up to the engine so the response meta can
report `served_level` / `guaranteed`. `guaranteed = (served_level === "json_schema")`.

### 6.2 Adapter changes (the request-shaping seam)

- **`openai-compat.ts`** (`streamChat` body at lines 73-88): when
  `options.responseFormat?.level` is `json_schema`, add
  `response_format:{ type:"json_schema", json_schema:{ name, schema, strict:true } }`;
  when `json_object`, add `response_format:{ type:"json_object" }`; when
  `prompt`, add nothing (the engine already injected the coercion message). Covers
  openrouter, cohere, mistral, deepseek, fireworks, xai, cerebras, groq, lmstudio.
- **`gemini.ts`** (`generationConfig` at lines 158-161): when level is
  `json_schema`, set `responseMimeType:"application/json"` and
  `responseSchema: toGeminiSchema(schema)`; when `json_object`, set only
  `responseMimeType:"application/json"`. `toGeminiSchema` (§6.3) downconverts to
  the Gemini OpenAPI subset.
- **`ollama.ts`**: set `format: schema` (json_schema) or `format:"json"`
  (json_object) — but only when the local runtime layer has confirmed the loaded
  model supports it; otherwise fall to `prompt`.

These are the **same insertion points tools will use** — keep them one block.

### 6.3 Schema-dialect normalization (per provider)

- OpenAI `json_schema` **strict** requires `additionalProperties:false` and that
  every property be in `required`. A normalizer (`@zintus/schemas`) rewrites the
  incoming schema to satisfy this *without changing semantics where possible*,
  and **rejects** (→ hard-error / drop the candidate) schemas that can't be made
  strict-compatible, so we never claim GUARANTEED on a schema the provider would
  silently relax.
- Gemini accepts only a subset; `toGeminiSchema` strips/translates unsupported
  keywords and, if a feature can't be represented, **downgrades that candidate
  to `json_object` + post-validation** rather than lying about a `json_schema`
  guarantee.
- Because of these subset gaps, **rule §0.2 (always validate output even on a
  GUARANTEED provider)** is load-bearing, not paranoia.

---

## 7. Gateway, OpenAPI, web, CLI touchpoints

### 7.1 Gateway (`apps/gateway/src/handler.ts`)
- Accept `response_format` (already validated by `ChatCompletionRequestSchema`
  via §3.1; thread it into `engine.routeAndStream({... responseFormat: body.response_format})`
  at the call near line 748).
- New honest error constant `UNSUPPORTED_STRUCTURED_ERROR` next to
  `UNSUPPORTED_VISION_ERROR` (lines 95-111): `type:"unsupported_capability"`,
  `required:["json_schema"]`, suggestions = providers/models that DO guarantee
  it (gemini, fireworks, cerebras, plus "or set strict:false for best-effort").
- Map the router throw at the `catch` (lines 799-801): the same
  `error.message === "unsupported_capability"` branch returns the structured
  error when the request was structured (disambiguate vision vs structured by
  inspecting the request).
- Add a new error `structured_output_failed` (422) for repair-exhausted invalid
  output (§5.1) — distinct from `unsupported_capability`.
- Non-streaming response (lines 897-919): add `parsed` and `structured_output`
  (§2.3). Streaming response: emit the buffered-and-validated JSON as one final
  data event + the metadata event (§5.2).
- `buildUsageMetadata` (lines 68-91): add `structured_output` block when present.
- New response header `X-Zintus-Structured-Level` (mirrors
  `X-Zintus-Vision-Provider` at line 818) carrying `served_level`.

### 7.2 OpenAPI (`docs/openapi.yaml`)
- `ChatCompletionRequest` (line 771): add `response_format` property referencing
  a new `ResponseFormat` schema; document that **strict json_schema hard-errors
  (422) when unsupported** and that **structured requests buffer rather than
  token-stream**.
- `ChatCompletion` (line 846): add optional `parsed` + `structured_output`.
- `openapi-spec.test.ts` cross-checks spec↔handler, so the handler must reference
  `response_format`/`structured_output` (the test greps `handlerSource`).

### 7.3 Web (`apps/web/lib/gateway.ts`)
- `streamGatewayChat` params (line 459): add
  `responseFormat?: ResponseFormat`; include it in the POST body (line 492).
- Reuse the existing `UnsupportedCapabilityError` (line 444) for the structured
  422. Surface `served_level`/`guaranteed` in the per-response transparency strip
  with an explicit **"best-effort JSON (not schema-guaranteed)"** badge when
  `guaranteed === false` — this is the user-facing half of the honesty bar.

### 7.4 CLI (`apps/cli/src/commands/chat.ts`)
- The CLI calls the **engine directly** (line 122), so it passes
  `responseFormat` straight into `routeAndStream`. A `--json-schema <file>` /
  `--json` flag builds the `ResponseFormat`. On `unsupported_capability` the
  existing `normalizeChatError` (line 156) gets a structured-output branch
  mirroring its vision branch. Print the `guaranteed:false` warning to stderr.

---

## 8. Test plan

**Schema-conformance (the core invariant):**
- `packages/schemas/src/structured.test.ts`: `validateStructured` on (a) clean
  JSON, (b) fenced JSON, (c) JSON with leading prose, (d) wrong-typed field →
  issues, (e) missing required → issues. `repairInstruction` / `coercionSystemMessage`
  snapshot. Ajv draft-2020-12 acceptance of a representative schema.
- Schema normalizers: OpenAI-strict rewrite adds `additionalProperties:false` +
  full `required`; an un-strictifiable schema is rejected (no false GUARANTEED).
  `toGeminiSchema` drops `$ref`/unsupported keywords and downgrades correctly.

**Registry (mirror `capabilities.test.ts`):**
- `structuredOutput` covers every provider id, no extras (reuse the
  `DATA_POLICIES` key-set assertion at `capabilities.test.ts:13`).
- `json_schema` is asserted **only** for the verified default-model set
  (the audit-style invariant, like the vision test at lines 21-26).
- `structuredOutputLevel`/`supportsStructuredLevel` are model-aware: a strict-only
  model id in `JSON_SCHEMA_MODELS` returns `json_schema`; an unmapped one returns
  the provider default; local providers return conservative defaults.

**Router (capability-honest):**
- `strict json_schema` request + only `json_object` providers eligible → throws
  `unsupported_capability` (no silent downgrade).
- `strict` + a `json_schema` provider eligible → routes, passes
  `options.responseFormat.level === "json_schema"`.
- non-strict `json_object` request on a `none` provider → resolves to `prompt`,
  engine injects coercion message, response labeled `guaranteed:false`.
- forced provider that can't guarantee + strict → hard-error (parity with the
  forced-non-vision case).

**VCR (replay, no network — extend `packages/providers/src/vcr.test.ts`):**
- New fixtures under `tests/fixtures/providers/`: an OpenAI-compat
  `json_schema` strict response, a Gemini `responseSchema` response, a
  `json_object` response, and a malformed best-effort response that the **repair
  loop** fixes on attempt 2. Assert the parsed output **validates against the
  schema** end-to-end (conformance), and that the malformed-then-repaired case
  reports `repair_attempts: 1` and `valid:true`.
- A best-effort response that stays invalid through 2 repairs → engine yields
  `valid:false`; gateway test asserts **422 `structured_output_failed`**, never a
  200 with prose.

**Engine / gateway integration:**
- `apps/gateway/src/handler.test.ts` (mirroring the existing
  `unsupported_capability` test at lines 950-986): structured 422 honest body;
  non-streaming `parsed` + `structured_output` meta; `X-Zintus-Structured-Level`
  header; `guaranteed:false` for an emulated path.
- `openapi-spec.test.ts`: `response_format` documented and referenced in handler.

**Full-suite gate:** `bun run typecheck` + `bun run test` green (the VERDICT
ground-truth bar), plus one live-provider smoke per native path
(gemini responseSchema, one OpenAI-compat json_schema) behind a key, run
out-of-band like the other live smokes.

---

## 9. PR-by-PR plan

**PR-A — Registry & types (no behavior change).**
`capabilities.ts` (replace `json` boolean with `structuredOutput` 3-state +
`JSON_SCHEMA_MODELS`/`JSON_OBJECT_MODELS` + `structuredOutputLevel` /
`supportsStructuredLevel`), `providers/index.ts` exports, `types/route.ts`
(`ResponseFormat`, `JsonSchema`, `requiresStructuredOutput`,
`requiresGuaranteedSchema`), `types/stream.ts` (`ResolvedResponseFormat`),
`types/index.ts` re-exports. Tests: registry + predicate.
*Coordinate with the tools sibling on the `tools` field landing in the same file.*

**PR-B — `@zintus/schemas` validation/repair core.**
`schemas/structured.ts` (`validateStructured`, `repairInstruction`,
`coercionSystemMessage`, OpenAI-strict + Gemini normalizers), add Ajv dep,
`ResponseFormatSchema`, wire into `ChatCompletionRequestSchema`/`ResearchRequestSchema`.
Tests: conformance + normalizers. Pure, no network.

**PR-C — Provider adapters (request-shaping seam).**
`openai-compat.ts`, `gemini.ts`, `ollama.ts` emit native fields from
`options.responseFormat`. Tests: VCR fixtures + conformance. *Same block tools
will extend.*

**PR-D — Router honest selection + per-pick level resolution.**
`factory.ts` structured filter/throw after the vision block, `resolvedLevel`,
pass resolved level to `streamChat`, return `served_level`/`guaranteed` up.
Tests: router capability-honesty matrix.

**PR-E — Engine buffer→validate→repair loop.**
`engine.ts` `routeAndStream`: buffer structured responses, run the repair loop,
inject `prompt`-level coercion downstream of Tokzen, surface `structured` meta on
`EngineStreamResult`. Tests: engine repair (success-on-retry, give-up).

**PR-F — Gateway + OpenAPI + surfaces.**
`handler.ts` (`UNSUPPORTED_STRUCTURED_ERROR`, `structured_output_failed`,
`parsed`/`structured_output`, header, metadata, streaming terminal event),
`docs/openapi.yaml`, `web/lib/gateway.ts` (param + `guaranteed:false` badge),
`cli/commands/chat.ts` (`--json-schema` flag + error branch). Tests: handler +
openapi-spec + web billing-style unit.

Order rationale: A→B are leaf/pure (safe to land first); C/D/E build the
machinery; F exposes it. Each PR keeps `typecheck`+`test` green and ships its own
tests (the VERDICT §11 gate).

---

## 10. Risks & honest limitations

1. **Streaming is disabled for structured requests** (buffer-to-validate).
   Mitigated by emitting a single terminal SSE event and documenting it; true
   partial-JSON streaming is deferred. *This is a real UX regression vs plain
   chat and must be stated in the OpenAPI + web label.*
2. **"json mode" ≠ schema conformance.** A `json_object` provider returns *valid
   JSON of the wrong shape* and looks like success. §0.2 (always validate) +
   `guaranteed:false` labeling are the only defense; without them this silently
   lies. Highest-priority correctness risk.
3. **Provider schema-dialect subsets** (Gemini OpenAPI subset; OpenAI strict's
   `additionalProperties:false`/all-required). A schema accepted by us may be
   *relaxed* by the provider → we'd claim GUARANTEED falsely. Mitigated by the
   normalizers **rejecting/downgrading** un-representable schemas and by §0.2.
4. **Strict-model coverage drift.** `JSON_SCHEMA_MODELS` is best-effort vs docs
   and will rot, exactly like `VISION_MODELS`/`data-policies.ts`. Mitigation:
   start nearly empty, add an id only behind a VCR fixture; carry the same
   "re-verify before relying" caveat in the file header.
5. **Repair-loop quota/latency burn.** Up to 2 extra real provider calls per
   structured request, debiting the ledger. Capped at 2; `repair_attempts`
   surfaced; consider a policy knob to disable repair for quota-sensitive setups.
6. **Hostile/huge schema** as a DoS vector (deep `$ref` cycles, giant enums).
   Mitigated by size/depth caps in `ResponseFormatSchema` and Ajv compile guards
   at the edge (gateway **and** relay).
7. **Tokzen interaction.** The `prompt`-level coercion message must survive
   compression; inject it in the engine downstream of the gateway's Tokzen pass
   (same reasoning the vision bypass uses). Risk if a future refactor moves
   Tokzen after the engine.
8. **Local providers (ollama/lmstudio).** Structured guarantee depends on the
   *loaded* model, which can't be asserted statically. We default conservative
   and rely on a runtime-detect step (out of scope here) — until then, local =
   best-effort, labeled.
9. **Divergence from OpenAI's `response_format` exactly.** We add `parsed` and a
   non-standard `structured_output` meta and we hard-error on unsupported strict;
   strict-OpenAI-clients may expect a silent best-effort. This is a deliberate
   honesty choice and is documented as a Zintus deviation in the OpenAPI
   `ChatCompletion` description (which already lists deviations at line 848).
