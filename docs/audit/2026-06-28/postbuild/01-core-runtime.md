# Post-build verification — Core runtime (tool calling + structured output + image mapper)

*Branch `feat/tool-calling`. READ-ONLY on source. Verified against the 10/10
capability-honesty bar. Files live under `packages/*/src/` (not the bare paths the
brief used). Scope: `packages/types/src/route.ts`,
`packages/providers/src/capabilities.ts`, `packages/router/src/factory.ts`,
`packages/router/src/redact.ts`, with cross-reads of `stream.ts`, `utils.ts`,
`openai-compat.ts`, and the relay redactor.*

---

## Verdict summary

| # | Question | Class |
|---|----------|-------|
| 1 | Tools / strict-schema routing hard-errors when unsupported | **OK** |
| 1b | Vision routing honesty under the openrouter model fan-out | **RISK** |
| 2 | `structuredOutput` conservatism (only gemini json_schema) | **OK** |
| 3 | Parallel `toolCalls` channel — ordering / leak | **OK** |
| 4 | Code-efficiency | **INEFFICIENT** (minor only) |
| 5 | `redact.ts` misses UUID / JWT / named tokens (prior drift) | **RISK** (unfixed) |

---

## (1) Capability honesty — tools & strict-schema: OK; vision fan-out: RISK

**Tools — OK.** Two-layer gate, correctly fail-closed:
- Candidate filter `factory.ts:578-585` — drops non-tool candidates via
  `supportsTools(id, request.model)`; throws `unsupported_capability` if none.
- Per-provider model fan-out re-filter `factory.ts:671-679` — when tools are
  requested, `modelsToTry` is filtered by `supportsTools(provider.id, model)`, so
  the groq 70B→8B / openrouter free-model failover can never silently land on a
  non-tool model. `supportsTools` itself fails closed on unknown models
  (`capabilities.ts:164-173`). This is the correct discipline.

**Strict-schema — OK.** `factory.ts:593-601` filters to
`structuredOutputLevel(...) === "json_schema"` and hard-errors. Only gemini
qualifies, and gemini has no model fan-out, so the missing per-model re-filter on
the strict path is currently moot (note below).

**Vision fan-out — RISK (silent downgrade reachable).** The vision gate exists at
the candidate level (`factory.ts:562-569`, `supportsVision(id, request.model)` +
hard-error) — but, unlike tools, there is **no per-model re-filter on
`modelsToTry`**. With the *new* `VISION_MODELS.openrouter` entries
(`capabilities.ts:110-113`), an explicit request for an openrouter vision model
(`meta-llama/llama-3.2-90b-vision-instruct`) makes openrouter a legitimate vision
candidate. The fan-out then builds
`modelsToTry = [visionModel, ...OPENROUTER_FREE_MODELS]` (`factory.ts:662-668`).
If the first (vision) attempt fails with a failover-eligible error and is not the
last model (`factory.ts:918-920`), the loop continues to a **non-vision** free
model (llama-3.3-70b:free, gemma, mistral-7b) and re-sends the image blocks to it.
`toOpenAiMessages` emits `image_url` parts for any block-array turn and explicitly
relies on the router gate (`openai-compat.ts:93-96`) — so the malformed/blind
request goes out rather than erroring. This is exactly the "never silently
downgrade" rule the bar forbids. **Fix:** mirror the tools re-filter — when
`requiresVision(request.messages)`, filter `modelsToTry` by
`supportsVision(provider.id, model)` (and `continue`/release if empty), the same
shape as `factory.ts:671-679`. Narrow trigger (explicit openrouter vision model +
first-attempt failover) but a real capability-honesty hole.

*Minor note:* the strict-schema path has the same missing `modelsToTry` re-filter;
harmless today (only single-model gemini qualifies) but should be added if any
fan-out provider is ever promoted to `json_schema`, to stay future-proof.

## (2) structuredOutput conservatism — OK

`MODEL_CAPABILITIES` (`capabilities.ts:61-74`) marks **only gemini** `json_schema`;
every native-JSON provider is `json_object`; cohere/huggingface/lmstudio are
`none`. `JSON_SCHEMA_MODELS` (`capabilities.ts:181-189`) lists only the gemini
family. `structuredOutputLevel` fails closed on unknown models
(`capabilities.ts:199-210`). `json` stays a faithful derived
`structuredOutput !== "none"` across the table. Conservative and internally
consistent — correct.

## (3) Parallel toolCalls channel — OK (sound)

- **No leak.** `collectedToolCalls` is allocated fresh per attempt inside the
  model loop (`factory.ts:738`) and the returned `toolCalls` references that same
  per-attempt array (`factory.ts:846-847`). Each failover builds a new result, so
  no array is shared across attempts/requests.
- **Ordering.** The generator pushes `chunk.toolCall` in stream-arrival order
  (`factory.ts:754-756`); upstream, `drainToolCalls` emits in sorted `index` order
  (`utils.ts:53-87`), so multi-call ordering is deterministic, and malformed args
  degrade to `{}` rather than killing the stream.
- **Contract honesty.** Text path stays byte-identical — a chunk carries `content`
  OR `toolCall` (`stream.ts:70-71`); the live-array "read AFTER draining" contract
  is documented at `route.ts:302-316`. `sanitizeForLogs` elides tool_call args and
  tool_result content (`route.ts:219-224`). Sound.

## (4) Code-efficiency — INEFFICIENT (minor only)

- `factory.ts:27-55`: the `resolveResponseFormat` function and its `import type`
  block are interleaved between import groups (the `import type { TokenUsage }` at
  line 55 sits *after* a function body). Valid (imports hoist) but messy — move the
  function below all imports.
- `structuredOutputLevel` is computed in the candidate filter (`factory.ts:596`)
  and again per-attempt inside `resolveResponseFormat` (`factory.ts:40`); likewise
  `requiresTools(request)` is called at 578 and 671. All O(1) and cheap — not worth
  caching, noted for completeness.
- No redundant allocations or hot-path waste found in the tool/structured paths.

## (5) redact.ts UUID/JWT drift — RISK (still unfixed in the router copy)

The router redactor `packages/router/src/redact.ts:12-28` still matches **only
prefixed provider keys** (csk-/sk_live_/…/hf_) and stops there. The relay copy
(`workers/relay/src/redact.ts:25-39`) has since gained **JWT** (`eyJ…` three-segment),
**named session/OAuth tokens** (`access_token|refresh_token|session_token|
zintus_session|…`), and **OAuth `code=`/`state=`** redaction (the `d4eb53b` fix).
The two "mirrored" redactors have **drifted** — prior audit finding #4 is **NOT
fixed** in the router. This matters because the router copy is the one actually
applied to provider error messages before they hit the persisted trace
(`factory.ts:825,869`); a provider 401 body echoing a Google `id_token`/JWT or a
session token would pass through un-redacted. *(Neither copy matches a bare UUID
standalone — acceptable, since bare UUIDs collide with non-secret thread/user ids;
the real gap is the missing JWT + named-token rules.)* **Fix:** port the relay's
extra `.replace(...)` rules into the router redactor (or extract one shared module).
