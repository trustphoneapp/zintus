# Design: Tool / Function Calling Across the Zintus Stack

**Date:** 2026-06-28 · **Branch baseline:** `feat/multimodal-image-input` @ `6bcd097`
**Status:** DESIGN ONLY (no code). Implements the P1 gap named in
`docs/audit/2026-06-26/VERDICT.md` §6 — "No tool/function calling" — the single
biggest capability gap vs ChatGPT / Claude / Gemini / Perplexity / Cursor.

**Honesty contract (non-negotiable, from VERDICT §2/§11):** never claim tools work
on a surface where they don't; the capability registry MUST drive routing; a request
that asks for `tools` against a model/provider that can't serve them **hard-errors**
(`unsupported_capability`) — it never silently downgrades to a text-only answer.

---

## 0. TL;DR

1. Tool calling is **modeled exactly like the multimodal-image work already shipped**:
   new content-block variants in `@zintus/types`, a model-aware capability check in
   `packages/providers/src/capabilities.ts` (mirroring `supportsVision`/`VISION_MODELS`),
   a router candidate filter that throws `unsupported_capability` (mirroring the
   `requiresVision` gate at `router/factory.ts:528`), a gateway 422 with honest
   suggestions (mirroring `UNSUPPORTED_VISION_ERROR` at `handler.ts:95`), and a
   client-side surface (mirroring `UnsupportedCapabilityError` at `web/lib/gateway.ts:444`).
2. **Zintus does not execute user tools.** There is no sandbox, and the local-first /
   no-custody ethos means the *client* owns tool execution. The gateway/engine are a
   **stateless pass-through + surfacing layer**: they forward tool definitions to the
   provider, surface `tool_call` blocks back to the client, and accept `tool` /
   `tool_result` turns on the next request. The **multi-turn loop lives in the client**
   (web/CLI), not the engine. (An optional engine-side auto-loop for *server-executable*
   tools is sketched in §7 but is out of scope for v1.)
3. The **one real contract break**: today every layer flattens the provider stream to
   `AsyncIterable<string>` (`RouteStreamResult.stream`, `engine` `wrappedStream`,
   gateway SSE). Tool calls are *structured* and cannot be flattened to text. The stream
   contract must gain a typed tool-call event (`StreamChunk.toolCall`) threaded end to end.
4. **Provider reality:** Zintus ships **no native Anthropic/OpenAI adapter**. The fleet is
   1 Gemini adapter + 11 OpenAI-compatible adapters (Groq, Cerebras, OpenRouter, Mistral,
   DeepSeek, Fireworks, xAI, Cohere-compat, HuggingFace, LM Studio, Ollama). So Zintus
   speaks **two** wire formats for tools: **OpenAI `tools`/`tool_calls`** (shared adapter)
   and **Gemini `functionDeclarations`/`functionCall`/`functionResponse`** (bespoke adapter).
   Anthropic `tool_use`/`tool_result` is reached only *through OpenRouter*, which normalizes
   to OpenAI shape — so Zintus never emits raw Anthropic blocks. The Anthropic mapping is
   documented in §4 anyway, for correctness and for a future native adapter.

---

## 1. Ground-truth findings (read before judging the plan)

### 1.1 Type layer — `packages/types/src/route.ts`
- `ContentBlock = TextContentBlock | ImageContentBlock` — a discriminated union on `type`
  (`route.ts:7-26`). This is the exact extension point: tool blocks become new union members.
- `ChatMessage { role: "system"|"user"|"assistant"; content: string | ContentBlock[] }`
  (`route.ts:28-32`). **No `tool` role exists today** — tool results need either a new role
  or (preferred, see §3.4) a `tool_result` content block carried on a `user` turn, matching
  Anthropic's own model.
- Helpers to mirror: `isContentBlockArray` (`:35`), `textOf` (`:44` — strips non-text; tool
  blocks must be skipped here too), `imageCount`/`hasImages`/`requiresVision` (`:53-71`),
  `sanitizeForLogs` (`:75` — must also elide tool-call args/results from logs).
- `RouteStreamResult { providerId; model; stream: AsyncIterable<string>; privacyHonored? }`
  (`route.ts:151-166`) — **text-only stream**: the contract break.
- `RouteUsage` (`:136`) and `RouteRequest` (`:90-134`) — `RouteRequest` is where a `tools`
  field + `toolChoice` get added (alongside `webSearch`, `temperature`, `maxTokens`).

### 1.2 Stream layer — `packages/types/src/stream.ts`
- `StreamChunk { content?; done?; rateLimit?; usage? }` (`stream.ts:45-50`) — text only.
- `StreamChatOptions { model; apiKey; signal; temperature; maxTokens; cacheHints; webSearch }`
  (`:1-14`) — where `tools`/`toolChoice` get threaded to each provider's `streamChat`.
- `StreamChatResult { stream: AsyncIterable<StreamChunk>; rateLimit?; usage? }` (`:52-56`).

### 1.3 Capability registry — `packages/providers/src/capabilities.ts`
- `ModelCapabilities` **already has `tools: boolean`** (`capabilities.ts:32`) and
  `MODEL_CAPABILITIES` already sets it per default model (`:39-52`) — but the file header
  is explicit (`:11-17`) that "the engine does not yet emit … `tools` … the flags mark what
  each default model COULD do so those features can route correctly **once wired**." This PR
  set is the "once wired."
- `supportsVision(providerId, model?)` (`:94-99`) + the model-specific `VISION_MODELS` set
  (`:75-83`) is the precise pattern to clone as `supportsTools` + `TOOL_MODELS`. The existing
  per-default-model `tools` flag is the fallback when no explicit model is given.

### 1.4 Providers
- `Provider` interface — `packages/types/src/provider.ts:22-34`: `streamChat(messages, options)`.
- Gemini bespoke adapter — `packages/providers/src/providers/gemini.ts`. Note `splitGeminiMessages`
  (`:31`) already maps roles (`assistant`→`model`) and already injects a tool for native search:
  `...(options.webSearch ? { tools: [{ googleSearch: {} }] } : {})` (`:157`). Tool calling adds
  a **second** `tools` entry shape (`functionDeclarations`) and a `functionCall`/`functionResponse`
  round-trip; `parseGeminiSseStream` (`:63`) must learn to yield `functionCall` parts.
- OpenAI-compatible shared adapter — `packages/providers/src/openai-compat.ts`. Already passes
  `tools` for OpenRouter web search (`:84`). Tool calling adds the OpenAI `tools` array +
  `tool_choice`, and `parseOpenAiSseStream` (`packages/providers/src/utils.ts:42`) must learn
  to accumulate `delta.tool_calls` fragments. **One change here lights up 10 providers.**
- Provider fleet & defaults — `packages/providers/src/factory.ts:17-30`; default models in
  `MODEL_CAPABILITIES`. Skeletons (`providers/skeletons.ts`) and Groq (`providers/groq.ts`)
  are thin `createOpenAiCompatProvider` calls — no per-provider tool code needed.

### 1.5 Router — `packages/router/src/factory.ts`
- The **vision gate is the template** (`factory.ts:523-535`):
  ```ts
  if (requiresVision(request.messages)) {
    candidates = candidates.filter((c) => supportsVision(c.id, request.model));
    if (candidates.length === 0) throw new Error("unsupported_capability");
  }
  ```
  A `requiresTools(request)` gate (request carries a non-empty `tools` array) is added directly
  after it with the identical shape, filtering on `supportsTools`.
- Forced provider short-circuit: `selectCandidates` returns the single forced provider
  (`:344-349`) — the gate still applies, so a forced non-tool provider hard-errors (correct).
- The streaming loop flattens to text: `textStream` only yields `chunk.content` (`:645-664`).
  This is where tool-call chunks must also be surfaced (see §3.3, §5).
- Groq tries 70B→8B (`:594`), OpenRouter tries free models (`:596-601`) — failover across
  models is fine for tools as long as every model in the list is tool-capable (it is, per
  the registry); document that the per-provider model fan-out must not fall to a non-tool model.

### 1.6 Engine — `packages/engine/src/engine.ts`
- `routeAndStream` (`:370`) wraps the router; `wrappedStream` (`:573`) concatenates
  `assistantContent` as a **string** and persists it via `conversations.appendMessage`.
  `ThreadMessage.content` is **text-only** (`packages/types/src/conversation.ts:11`).
- Threaded requests run `compileContext` with `newUserMessage: latestUserInput` where
  `latestUserInput = textOf(...)` (`:382`, `:412-423`) — i.e. **the compile path is text-only**;
  the multimodal work *bypasses* it for image requests (see CLI note below). Tool requests must
  bypass it the same way (a `tool_result` carried in history would be flattened to "" by `textOf`
  and lost).
- Implication: **v1 tool calling is stateless/one-shot at the engine** (no thread persistence of
  tool turns), exactly as images are. The conversation that carries tool turns is reconstructed by
  the *client* and sent verbatim as `messages`.

### 1.7 Gateway — `apps/gateway/src/handler.ts`
- `UNSUPPORTED_VISION_ERROR` (`:95-111`): `{error:{type:"unsupported_capability", message,
  required:["vision"], suggestions:[…]}}` returned 422. The tool analog is `UNSUPPORTED_TOOLS_ERROR`.
- Explicit-provider gate (`:626`): if user picked a provider that can't see images → 422 before routing.
- Auto-route gate (`:799`): router throws `"unsupported_capability"` → mapped to 422. Same mapping
  reused for tools.
- `parseMessages` (`:1528`) only accepts `system|user|assistant` roles and `string | ContentBlock[]`
  content — must accept tool content blocks (and, if chosen, a `tool` role).
- Tokzen compression runs on text (`:689-722`) and is **skipped for image requests** (`!hasImages`).
  Tool definitions and tool-call args/results must likewise bypass Tokzen (compressing a JSON Schema
  or a tool result would corrupt it). Gate on `hasImages || hasTools`.
- SSE framing (`:928-1035`) emits `chat.completion.chunk` with `choices[].delta.content`. Tool-call
  deltas need a parallel `choices[].delta.tool_calls` shape (OpenAI-compatible) so generic OpenAI
  SDKs pointed at the gateway still work.
- `X-Zintus-*` response headers (`:805-823`) — add `X-Zintus-Tools` (count) and
  `X-Zintus-Tool-Provider` for the transparency strip, mirroring the vision headers.

### 1.8 Schemas + OpenAPI
- `packages/schemas/src/index.ts`: `ContentBlockSchema` discriminated union (`:46`),
  `ChatMessageSchema` (`:51`), `ChatCompletionRequestSchema` (`:98`). Tool block schemas +
  a top-level `tools`/`tool_choice` are added here; the gateway already `safeParse`s the body.
- `docs/openapi.yaml` is contract-tested by `apps/gateway/src/openapi-spec.test.ts` — it must be
  updated in lockstep (the test fails otherwise).

### 1.9 Clients
- Web: `apps/web/lib/gateway.ts` `streamGatewayChat` (`:459`) parses `GatewayChunk` (`:396`) and
  throws `UnsupportedCapabilityError` (`:444`) on the 422. `apps/web/lib/chat-client.ts` is the
  thin wrapper. Tool calls add tool-call parsing to the SSE consumer + the client-side execute loop.
- CLI: `apps/cli/src/index.ts` (`--image` repeatable collector `:34`, `:62`), and
  `apps/cli/src/commands/chat.ts` (loads images, **deliberately skips diff/codebase context when
  images are present** `:90-110` because the compile path is text-only — tool requests get the same
  treatment). The CLI uses the engine directly (`createAppEngine`), not the HTTP gateway.

---

## 2. Architectural decisions (and why)

| # | Decision | Rationale / honesty tie-in |
|---|----------|----------------------------|
| D1 | **Client-driven tool loop.** The engine/gateway forward tool defs, surface `tool_call`s, and accept tool results on the next turn. They do **not** execute tools or run the loop. | No sandbox exists; local-first/no-custody means the user's machine runs the user's tools. Running user code server-side would be a custody/security regression. Honest: the gateway is a relay, and we say so. |
| D2 | **Capability registry drives routing; hard-error, never downgrade.** A `tools` request filters candidates by `supportsTools`; empty → `unsupported_capability` (422). | Verbatim from VERDICT §2/§11 and the existing vision gate. |
| D3 | **Two wire formats, normalized to one internal shape.** Internal `ToolDefinition`/`ToolCall`/`ToolResult` types are provider-neutral; each adapter maps to OpenAI or Gemini. | Mirrors how `ImageContentBlock` maps to `inlineData` (Gemini) vs OpenAI image parts. Anthropic shape documented but unreachable without a native adapter. |
| D4 | **Stream contract gains a typed tool-call event** (`StreamChunk.toolCall`), threaded router→engine→gateway. The public SSE stays OpenAI-compatible (`delta.tool_calls`). | Tool calls are structured; flattening to a text string (today's `AsyncIterable<string>`) is lossy and dishonest. |
| D5 | **v1 is stateless for tool turns** — no thread persistence; threaded compile is bypassed for tool requests (as it is for images). The client resends full `messages`. | `ThreadMessage` is text-only and `compileContext` flattens via `textOf`; persisting tool turns is a separate, larger change. Documented limit, not a silent drop. |
| D6 | **Tokzen + relay never touch tool payloads.** Compression and the cloud relay skip tool defs/args/results. | Compressing a JSON Schema corrupts it; tool args may carry sensitive data — same class of rule as "image bytes never go to the relay" (`route.ts:13`). |

---

## 3. The internal type model (PR-1)

All additions live in `@zintus/types` so they stay runtime-dependency-free (zod stays in
`@zintus/schemas`). Names chosen to read alongside `TextContentBlock`/`ImageContentBlock`.

### 3.1 Tool definition (request → provider)
```ts
// packages/types/src/tools.ts (new), re-exported from index.ts
/** JSON Schema (draft-2020-12 subset) describing a tool's input object. Kept as an
 *  opaque record — the providers forward it verbatim; Zintus does not validate args. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  /** Stable, model-visible name. ^[a-zA-Z0-9_-]{1,64}$ (intersection of OpenAI/Anthropic/Gemini). */
  name: string;
  /** Prescriptive description — drives when the model calls it. */
  description: string;
  /** Object JSON Schema for the tool input. `additionalProperties:false` + `required`
   *  recommended; required when `strict` is set. */
  parameters: JsonSchema;
  /** Request strict schema adherence where the provider supports it (OpenAI strict tool use /
   *  Anthropic strict:true). Best-effort; ignored by providers that lack it. */
  strict?: boolean;
}

/** How the model may use tools this turn. Maps to OpenAI tool_choice / Anthropic tool_choice /
 *  Gemini functionCallingConfig.mode. */
export type ToolChoice =
  | "auto"          // model decides (default)
  | "required"      // must call at least one tool (OpenAI "required" / Anthropic "any" / Gemini "ANY")
  | "none"          // tools visible but not callable
  | { type: "tool"; name: string }; // force a specific tool
```

### 3.2 Tool-call and tool-result content blocks (response ↔ next request)
Extend the `ContentBlock` union in `route.ts` — the discriminator stays `type`:
```ts
/** A model's request to invoke a tool. Emitted by the assistant turn. `id` is the
 *  correlation handle the client echoes back in the matching ToolResultBlock. */
export interface ToolCallContentBlock {
  type: "tool_call";
  /** Provider-issued id where available (OpenAI tool_call.id / Anthropic tool_use.id).
   *  Gemini issues none — adapters SYNTHESIZE one (`call_<name>_<index>`); see §4. */
  id: string;
  name: string;
  /** Parsed arguments object. NEVER a raw JSON string at this layer — adapters parse
   *  OpenAI's streamed string / read Gemini's object before constructing this. */
  arguments: Record<string, unknown>;
}

/** The client's result for a prior tool_call. Carried on the NEXT request. */
export interface ToolResultContentBlock {
  type: "tool_result";
  /** Must match a prior ToolCallContentBlock.id. */
  toolCallId: string;
  /** Result payload as text (JSON-stringified by the client when structured). */
  content: string;
  /** True when the tool failed — surfaced to the model so it can recover. */
  isError?: boolean;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolCallContentBlock
  | ToolResultContentBlock;
```

### 3.3 Stream event (provider → router → engine → gateway)
Extend `StreamChunk` in `stream.ts` (additive; existing text path unchanged):
```ts
export interface StreamChunk {
  content?: string;
  /** A fully-assembled tool call. Providers MUST emit this only once the call's name +
   *  arguments are complete (adapters buffer OpenAI's partial-JSON deltas; Gemini arrives
   *  whole). Multiple toolCalls in one assistant turn are emitted as separate chunks. */
  toolCall?: ToolCallContentBlock;
  done?: boolean;
  /** Why generation stopped — needed so the loop knows a tool round-trip is required. */
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
  rateLimit?: RateLimitInfo;
  usage?: TokenUsage;
}
```
`StreamChatOptions` gains `tools?: ToolDefinition[]` and `toolChoice?: ToolChoice`.

### 3.4 Helpers (mirror the image helpers)
```ts
export function requiresTools(req: { tools?: ToolDefinition[] }): boolean {
  return (req.tools?.length ?? 0) > 0;
}
/** True when any message carries a tool_call or tool_result block (a continued tool turn). */
export function hasToolTurns(messages: ChatMessage[]): boolean { /* scan blocks */ }
```
`textOf` (`route.ts:44`) is updated to skip `tool_call`/`tool_result` blocks (already skips images).
`sanitizeForLogs` (`route.ts:75`) is updated to elide `arguments`/`content` of tool blocks
(`<tool_call name=… args elided>`), matching the image-byte elision rule.

**Why tool_result rides on a `user` turn (no new `tool` role):** Anthropic's own model puts
`tool_result` blocks inside a `user` message, and the engine/gateway already accept
`user` + `ContentBlock[]`. Adding a `tool` role would ripple through `parseMessages`,
`splitGeminiMessages`, persistence, and every role switch. The OpenAI adapter maps a
`user`-turn `tool_result` block to an OpenAI `{role:"tool", tool_call_id, content}` message;
Gemini maps it to a `functionResponse` part in a `user`/`function` content. **The public HTTP
contract still ALSO accepts the OpenAI-native `{role:"tool", tool_call_id, content}` message**
(normalized to a `tool_result` block at the gateway) so off-the-shelf OpenAI SDKs work unchanged.

---

## 4. Provider-by-provider mapping (where formats diverge)

### 4.1 Request: tool definitions
| | Wire shape | Notes |
|---|---|---|
| **OpenAI-compat** (Groq, Cerebras, OpenRouter, Mistral, DeepSeek, Fireworks, xAI, Cohere-compat, HF, LM Studio, Ollama) | `tools: [{ type:"function", function:{ name, description, parameters } }]`, `tool_choice: "auto"\|"none"\|"required"\|{type:"function",function:{name}}` | `strict` → `function.strict:true`. One mapping in `openai-compat.ts` covers all 11. |
| **Gemini** | `tools: [{ functionDeclarations: [{ name, description, parameters }] }]`, `toolConfig: { functionCallingConfig: { mode:"AUTO"\|"ANY"\|"NONE", allowedFunctionNames?:[name] } }` | `parameters` is an OpenAPI-3 subset (close to JSON Schema; strip unsupported keywords like `$schema`, `additionalProperties` in a normalizer). `googleSearch` tool and `functionDeclarations` can co-exist in the `tools` array. |
| **Anthropic** (reference; via OpenRouter only) | `tools: [{ name, description, input_schema }]`, `tool_choice: {type:"auto"\|"any"\|"tool"\|"none", disable_parallel_tool_use?}` | `strict:true` is a sibling of `name`. Zintus never emits this directly — OpenRouter accepts OpenAI shape and translates. |

### 4.2 Response: tool calls (the hard divergence — streaming)
| | How calls arrive | ID | Args encoding |
|---|---|---|---|
| **OpenAI-compat** | SSE `choices[].delta.tool_calls[]` with `index`, `id` (first fragment), `function.name` (first fragment), `function.arguments` (**partial JSON string fragments across many deltas**). `finish_reason:"tool_calls"`. | provided (`id`) | string, streamed in pieces → adapter must **accumulate by `index`** then `JSON.parse` once `finish_reason` arrives. |
| **Gemini** | A `functionCall` part inside `candidates[].content.parts[]`: `{ functionCall: { name, args } }`. Arrives **whole** (args is a complete object), not token-streamed. `finishReason:"STOP"`. | **none** — adapter synthesizes `call_<name>_<i>`. | object already-parsed. |
| **Anthropic** (reference) | SSE `content_block_start`(`type:"tool_use"`,`id`,`name`) → `input_json_delta` (partial JSON string) → `content_block_stop`; `stop_reason:"tool_use"`. | provided (`id`) | string fragments → accumulate, parse. |

**Concrete adapter work:**
- `utils.ts:parseOpenAiSseStream` (`:42`): extend the parsed-chunk shape to read
  `choices[0].delta.tool_calls`; maintain a `Map<index, {id,name,argsBuffer}>`; on
  `finish_reason==="tool_calls"`, parse each buffer and `yield { toolCall, finishReason:"tool_calls" }`.
  Guard `JSON.parse` (skip-on-malformed, like the existing `try/catch`).
- `gemini.ts:parseGeminiSseStream` (`:63`): the inner `parts` loop currently reads only
  `parts[0].text`; iterate **all** parts, and for a `functionCall` part yield
  `{ toolCall: { id: synth, name, arguments: part.functionCall.args } }` plus
  `{ finishReason:"tool_calls" }` when the candidate's `finishReason` indicates it.

### 4.3 Continuation: tool results (next request)
| | Wire shape for a result |
|---|---|
| **OpenAI-compat** | assistant turn replays `tool_calls`; result is a separate message `{ role:"tool", tool_call_id, content }`. |
| **Gemini** | assistant (`model`) turn replays the `functionCall` part; result is a `{ role:"user"/"function", parts:[{ functionResponse:{ name, response:{ … } } }] }`. Gemini correlates by **name**, not id — adapter maps `toolCallId`→name via the prior call it synthesized. |
| **Anthropic** (reference) | assistant turn replays `tool_use`; result is a `user` turn with `[{type:"tool_result", tool_use_id, content, is_error?}]`. **All** parallel results go in **one** user message. |

`splitGeminiMessages` (`gemini.ts:31`) and the OpenAI message mapper must translate the internal
`assistant` turn carrying `ToolCallContentBlock`s and the `user` turn carrying
`ToolResultContentBlock`s into the per-provider shapes above. Parallel tool results stay in one turn.

---

## 5. The multi-turn tool-execution loop

**Owner: the client.** The gateway/engine are stateless across the loop. One round-trip:

```
┌── client (web/CLI) ─────────────────────────────────────────────────────────┐
│ messages = [ {user, "what's the weather in Paris?"} ]                         │
│ tools    = [ get_weather ]                                                    │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  POST /v1/chat/completions {messages, tools, tool_choice}
                ▼
        gateway → engine.routeAndStream → router (capability gate) → provider.streamChat(tools)
                │  SSE: delta.tool_calls (assembled) + finish_reason:"tool_calls"
                ▼
┌── client ────────────────────────────────────────────────────────────────────┐
│ append assistant turn (with ToolCallContentBlock)                            │
│ execute get_weather(Paris)  ← THE CLIENT RUNS THE TOOL                        │
│ append user turn (with ToolResultContentBlock toolCallId=…)                   │
│ POST again with the SAME tools array → model emits final text → finish:"stop" │
└───────────────────────────────────────────────────────────────────────────────┘
```

Rules baked into the design:
- **Stop condition:** client loops while the last response `finish_reason==="tool_calls"`; stops
  on `"stop"`. A `maxToolRounds` cap (default 8, configurable) prevents an infinite loop —
  surfaced honestly to the user if hit ("stopped after N tool rounds").
- **Parallel calls:** one assistant turn may carry several `ToolCallContentBlock`s; the client
  executes them (concurrently is fine) and returns **all** results in one `user` turn (required
  by Anthropic, accepted by all).
- **Failed tools:** client sets `isError:true` on the `ToolResultContentBlock`; never drops it.
- **Statelessness:** because the engine bypasses thread compile for tool turns (D5), the client
  must send the full running `messages` each round. Threaded mode + tools is rejected with a clear
  error in v1 (or the gateway ignores `thread_id` and logs it), not silently merged.
- **Tokzen/relay:** skipped for any request where `requiresTools || hasToolTurns` (D6).

**Optional future (NOT v1):** an engine-side auto-loop for *server-executable* tools only (e.g. the
existing native web-search flag, or a vetted built-in set). It would live in `engine.routeAndStream`
around the `result.stream` consumer (`engine.ts:573`), execute the built-in, append the result, and
re-invoke the router — never executing user-supplied tools. Explicitly out of scope; called out so
the v1 stream contract (D4) is forward-compatible with it.

---

## 6. Capability-honest hard-erroring (the heart of the contract)

Three honest gates, all mirroring the shipped vision gates:

1. **Explicit provider, gateway-side (fast 422, before routing)** — mirror `handler.ts:626`:
   ```ts
   if (requiresTools(body) && body.provider && !supportsTools(body.provider, body.model)) {
     return json(request, UNSUPPORTED_TOOLS_ERROR, 422);
   }
   ```
2. **Auto-route, router-side** — mirror `factory.ts:528`, added right after the vision gate:
   ```ts
   if (requiresTools(request)) {
     candidates = candidates.filter((c) => supportsTools(c.id, request.model));
     if (candidates.length === 0) throw new Error("unsupported_capability");
   }
   ```
   The gateway already maps `"unsupported_capability"` → 422 (`handler.ts:799`); branch the body on
   whether the request needed vision vs tools (or merge `required: ["tools"]`/`["vision"]`).
3. **Honest, no-upsell error body** — mirror `UNSUPPORTED_VISION_ERROR` (`handler.ts:95`):
   ```ts
   const UNSUPPORTED_TOOLS_ERROR = { error: {
     type: "unsupported_capability",
     message: "Tool / function calling requires a tool-capable provider or model.",
     required: ["tools"],
     suggestions: [
       { provider: "gemini",  reason: "Gemini 2.5 supports function calling." },
       { provider: "groq",    reason: "Llama-3.3-70B on Groq supports tool calls." },
       { provider: "openrouter", reason: "Pick a tool-capable OpenRouter model." },
     ],
   } } as const;
   ```
   No paid nudge, no "upgrade" — just actionable BYOK options, exactly like the vision error.

`supportsTools` (new in `capabilities.ts`, mirroring `supportsVision` `:94`):
```ts
const TOOL_MODELS: Partial<Record<ProviderId, ReadonlySet<string>>> = { /* verified per provider */ };
export function supportsTools(providerId: ProviderId, model?: string): boolean {
  if (model) return TOOL_MODELS[providerId]?.has(model)
            ?? MODEL_CAPABILITIES[providerId]?.tools && model === MODEL_CAPABILITIES[providerId].model
            ?? false; // unknown model → NOT assumed tool-capable
  return MODEL_CAPABILITIES[providerId]?.tools ?? false;
}
```
**Honesty rule:** an unrecognized `model` string is treated as **not** tool-capable (never assume),
identical to `supportsVision`'s narrow stance. Local providers (`ollama`/`lmstudio`) are gated on a
runtime-detected tool-capable model, not asserted statically — same caveat the file already makes
for vision (`capabilities.ts:73-74`). The registry's existing per-default-model `tools` flags
(`huggingface:false`, `cohere:true`, etc.) become live the moment the gate is wired — re-verify them
against provider docs as part of PR-2 (the file header already flags them "best-effort, re-verify").

---

## 7. PR-by-PR plan

Ordered so each PR is independently typecheck-green and shippable; capability flags exist before any
gate reads them; the gate exists before clients can request tools.

### PR-1 — Types: tool blocks, stream event, helpers
- **Files:** `packages/types/src/tools.ts` (new), `route.ts` (extend `ContentBlock`, `RouteRequest`,
  update `textOf`/`sanitizeForLogs`, add `requiresTools`/`hasToolTurns`), `stream.ts` (extend
  `StreamChunk`, `StreamChatOptions`), `index.ts` (re-exports), `conversation.ts` (document that
  `ThreadMessage` stays text-only; tool turns are not persisted in v1).
- **Touchpoints:** `route.ts:7-26`, `:44`, `:75`, `:90-134`; `stream.ts:1-14`, `:45-50`.
- **Risk:** widening `ContentBlock` forces every `switch (block.type)` to handle new members — but
  `textOf`/`sanitizeForLogs`/`splitGeminiMessages`/`userParts` are the only exhaustive consumers; TS
  will flag each. No behavior change yet (nothing emits tool blocks).
- **Tests:** unit for `requiresTools`, `hasToolTurns`, `textOf` (skips tool blocks), `sanitizeForLogs`
  (elides args/results).

### PR-2 — Capability registry: `supportsTools` + `TOOL_MODELS`
- **Files:** `packages/providers/src/capabilities.ts` (add `TOOL_MODELS`, `supportsTools`; re-verify
  every `tools:` flag in `MODEL_CAPABILITIES` against provider docs), `index.ts` (export `supportsTools`).
- **Touchpoints:** `capabilities.ts:39-52` (re-verify flags), `:69-99` (clone the vision block),
  `providers/src/index.ts:33-39` (export).
- **Tests:** `supportsTools(provider)` default-model truth; `supportsTools(provider, knownModel)`;
  unknown model → false; local providers → false.

### PR-3 — Providers: emit & accept tool calls (two adapters)
- **Files:** `packages/providers/src/openai-compat.ts` (send `tools`/`tool_choice`; map internal
  assistant `ToolCallContentBlock`→`tool_calls` and `user` `ToolResultContentBlock`→`{role:"tool"}`),
  `packages/providers/src/utils.ts` (`parseOpenAiSseStream` accumulates `delta.tool_calls`),
  `packages/providers/src/providers/gemini.ts` (`splitGeminiMessages` emits `functionDeclarations` +
  `functionResponse`; `parseGeminiSseStream` yields `functionCall`; synthesize ids; normalize JSON
  Schema → OpenAPI subset), `provider.ts`/`StreamChatOptions` plumb `tools`/`toolChoice`.
- **Touchpoints:** `openai-compat.ts:73-89`; `utils.ts:42-130`; `gemini.ts:16-29`, `:31-61`,
  `:63-127`, `:153-162`.
- **Risk:** OpenAI partial-JSON accumulation is the trickiest piece — buffer by `index`, parse once,
  guard malformed. Gemini schema normalization (drop `$schema`/`additionalProperties`/unsupported
  string formats) needs a small allowlist transform.
- **Tests:** VCR/contract (see §8) per format; unit for the JSON-fragment accumulator and the schema
  normalizer.

### PR-4 — Router: tool capability gate + surface tool chunks
- **Files:** `packages/router/src/factory.ts` (add `requiresTools` gate after the vision gate; thread
  `request.tools`/`toolChoice` into `provider.streamChat`; have `textStream` also surface `toolCall`
  chunks — change `RouteStreamResult.stream` per D4 or carry tool calls on a parallel channel).
- **Touchpoints:** `factory.ts:523-535` (gate), `:604-617` (pass `tools` into `streamChat`),
  `:645-664` (surface `toolCall`/`finishReason`, not just `content`). Ensure per-provider model
  fan-out (Groq 70B→8B `:594`, OpenRouter `:596-601`) never falls to a non-tool model when tools
  requested.
- **Decision point (D4):** either change `RouteStreamResult.stream` to `AsyncIterable<StreamChunk>`
  (clean, but touches every consumer) **or** keep `AsyncIterable<string>` for text and add
  `RouteStreamResult.toolCalls?: AsyncIterable<ToolCallContentBlock>` (smaller blast radius, but two
  channels to drain). **Recommendation: single typed stream** (`AsyncIterable<StreamChunk>`) — it is
  the honest shape and the engine/gateway rewrite is mechanical.
- **Tests:** gate throws `unsupported_capability` when no candidate supports tools; forced non-tool
  provider hard-errors; tool chunks propagate.

### PR-5 — Engine: pass-through + stateless tool turns
- **Files:** `packages/engine/src/engine.ts` (bypass `compileContext` when `requiresTools||hasToolTurns`,
  like images; `wrappedStream` forwards `toolCall` chunks and `finishReason`; do **not** persist tool
  turns — append only the final assistant text, or skip persistence for tool rounds).
- **Touchpoints:** `engine.ts:370-434` (bypass compile), `:573-643` (forward tool chunks; persistence
  guard), `:76-86` (`EngineRouteRequest` gains `tools`/`toolChoice`).
- **Tests:** tool request bypasses compile; tool chunks surface through `EngineStreamResult`; threaded
  tool request does not corrupt history.

### PR-6 — Gateway: request contract + SSE + honest 422
- **Files:** `apps/gateway/src/handler.ts` (`UNSUPPORTED_TOOLS_ERROR`; explicit-provider gate; map
  router `unsupported_capability` with `required:["tools"]`; `parseMessages` accepts tool blocks +
  optional `tool` role; thread `tools`/`tool_choice` into `engine.routeAndStream`; SSE emits
  `delta.tool_calls`; skip Tokzen when `hasTools`; add `X-Zintus-Tools`/`X-Zintus-Tool-Provider`).
- **Touchpoints:** `handler.ts:93-111` (new error const), `:563-628` (gates + tool parse), `:689-722`
  (Tokzen skip), `:744-803` (pass tools), `:805-823` (headers), `:928-1035` (SSE tool deltas),
  `:1528-1558` (`parseMessages`), `corsHeaders` expose-headers list `:314-319`.
- **Tests:** handler-level (Request→Response) for tool round-trip framing, 422 on non-tool provider,
  OpenAI-native `{role:"tool"}` acceptance.

### PR-7 — Schemas + OpenAPI (contract)
- **Files:** `packages/schemas/src/index.ts` (`ToolDefinitionSchema`, `ToolChoiceSchema`,
  `ToolCallBlockSchema`, `ToolResultBlockSchema`; add `tools`/`tool_choice` to
  `ChatCompletionRequestSchema`; widen `ContentBlockSchema`; accept `tool` role in `ChatMessageSchema`
  or a `tool_result` block), `docs/openapi.yaml` (new request fields, `ChatCompletionChunk` tool-call
  delta shape, the `unsupported_capability` 422 example), `apps/gateway/src/openapi-spec.test.ts`
  (kept green).
- **Touchpoints:** `schemas/index.ts:22-56`, `:98-124`; `openapi.yaml` `ChatCompletionRequest`
  (`:771-832`), `ChatCompletionChunk` (`:874-899`), responses (`:139-186`).
- **Tests:** zod accepts valid tool bodies / rejects malformed (bad tool name, non-object params);
  openapi-spec test passes.

### PR-8 — Web client: surface + execute loop
- **Files:** `apps/web/lib/gateway.ts` (`GatewayChunk` parses `delta.tool_calls`; `streamGatewayChat`
  returns tool calls + `finishReason`; reuse `UnsupportedCapabilityError` for tools), `lib/chat-client.ts`
  (loop: execute registered tools, resend with results, cap rounds), a small tool-registry + result
  renderer in the chat UI.
- **Touchpoints:** `web/lib/gateway.ts:396-411` (chunk shape), `:459-603` (tool-call assembly + return),
  `:444` (error already generic — extend message), `web/lib/chat-client.ts:38-75`.
- **Tests:** Playwright/unit for a mocked tool round-trip; 422 renders honest suggestions; no dead UI
  when a non-tool provider is chosen.

### PR-9 — CLI: surface + execute loop
- **Files:** `apps/cli/src/index.ts` (a `--tool <spec>` registration or a built-in demo toolset),
  `apps/cli/src/commands/chat.ts` (skip compile/diff for tool requests as it does for images; run the
  client loop; print tool calls + results honestly), reuse the engine directly.
- **Touchpoints:** `cli/src/index.ts:52-70`; `cli/src/commands/chat.ts:90-110` (the
  "skip context when special content present" branch already exists for images — extend to tools).
- **Tests:** CLI integration for a built-in tool round-trip; honest "no tool-capable provider" message.

---

## 8. Test plan

**Unit (`*.test.ts`, run by the suite — note VERDICT requires typecheck+suite green per fix):**
- Types: `requiresTools`, `hasToolTurns`, `textOf` skips tool blocks, `sanitizeForLogs` elides
  args/results.
- Capabilities: `supportsTools` truth table (default model, known model, unknown→false, local→false);
  re-verified `MODEL_CAPABILITIES.tools` flags.
- Adapters: OpenAI `delta.tool_calls` accumulator (fragmented JSON, multiple parallel calls by
  `index`, malformed-fragment skip); Gemini `functionCall` part extraction + id synthesis; Gemini
  JSON-Schema→OpenAPI normalizer (drops `$schema`/`additionalProperties`).
- Router: tool gate throws `unsupported_capability` with no tool-capable candidate; forced non-tool
  provider hard-errors; tool chunks propagate; private-mode + tools still honest.
- Engine: compile bypass on tool requests; tool chunks forwarded; no thread corruption.

**VCR / contract (mirror existing provider/gateway tests; record once, replay):**
- One recorded tool round-trip per wire format: a Gemini `functionCall` cassette and an
  OpenAI-compat (`groq`) `tool_calls` cassette — request carries `tools`, response carries the call,
  follow-up carries the result, final response is text. Asserts the *adapter* mapping, no live key.
- Gateway handler tests (Request→Response, like `handler.test.ts`): tool round-trip SSE framing
  (`delta.tool_calls`), 422 body for an explicit non-tool provider, OpenAI-native `{role:"tool"}`
  message acceptance, Tokzen-skipped-for-tools assertion (no compression headers on a tool request).
- `openapi-spec.test.ts` stays green against the updated `openapi.yaml`.

**Live smoke (manual, one real key per format — matches VERDICT §9 "live-provider smoke"):**
- Gemini key: real `get_weather` round-trip end to end (web + CLI).
- A Groq/OpenRouter key: same, OpenAI format.
- Negative: force a provider whose default model has `tools:false` (e.g. `huggingface`) → assert the
  honest 422 with suggestions, no text downgrade.

---

## 9. Risks & open questions

| # | Risk / question | Disposition |
|---|---|---|
| R1 | **Stream contract break (D4)** touches router/engine/gateway consumers of `AsyncIterable<string>`. | Recommended single typed stream (`AsyncIterable<StreamChunk>`); rewrite is mechanical and TS-guided. Alternative parallel channel documented if blast radius must shrink. |
| R2 | **OpenAI partial-JSON accumulation** is fiddly (fragments split mid-token, multiple parallel calls). | Buffer by `index`, parse once on `finish_reason`, guard malformed (reuse the existing skip-on-error pattern in `parseOpenAiSseStream`). Cover with the fragmented-JSON unit test. |
| R3 | **Gemini has no call ids / correlates results by name.** | Adapter synthesizes `call_<name>_<i>` on the way out and maps `toolCallId`→name on the way back. Breaks only if a turn has two calls to the *same* tool name — disambiguate with the index suffix. |
| R4 | **Registry `tools` flags are "best-effort" (file header `:11-17`).** Wiring the gate makes wrong flags user-visible. | PR-2 re-verifies every flag against provider docs before the gate ships; unknown models default to not-capable (fail closed). |
| R5 | **No thread persistence of tool turns (D5).** Threaded + tools is a hole. | v1 rejects/ignores `thread_id` for tool requests with a clear signal (not a silent merge). Persisting tool turns = follow-up design (needs `ThreadMessage` to carry blocks). |
| R6 | **Local providers (ollama/lmstudio).** Static registry says no tools; many local models do support them at runtime. | Same stance as vision: gate on a runtime-detected tool-capable model at the gateway, never assert statically. Out of scope for v1 static gate; documented. |
| R7 | **Relay / cloud path.** Tool args/results must never traverse the relay unencrypted (same class as image bytes). | D6: relay skips tool payloads; add a test asserting tool args are absent from any relay-bound payload, mirroring the image-bytes rule. |
| R8 | **No native Anthropic adapter** means the §4 Anthropic mapping is untested in-tree. | Documented as reference + future-proofing; reachable only via OpenRouter's OpenAI-shape translation today. A native Anthropic adapter is a separate provider PR. |
| R9 | **`maxToolRounds` infinite-loop guard** lives in the client, which we don't fully control (third-party OpenAI SDKs). | Gateway is stateless and per-request safe regardless; the cap is a client-UX safety net, surfaced honestly when hit. |
| R10 | **`tool_choice:"required"` semantics differ** (OpenAI `required` vs Anthropic `any` vs Gemini `ANY`). | Normalized in the internal `ToolChoice` type; each adapter maps to its provider's spelling. Documented in §4.1. |

---

## 10. What "done & honest" looks like (acceptance, tied to VERDICT §11)

- `bun run typecheck` and `bun run test` green, with the new unit + VCR/contract tests added per PR.
- The feature matrix (`docs/FEATURE-MATRIX.md`) marks tool calling ✅ **only** on the surfaces it
  actually works (web BYOK + CLI local first), ⚠️/❌ elsewhere — true to the line.
- A `tools` request against a non-tool model/provider **hard-errors** (422
  `unsupported_capability` + suggestions) on every surface — no text downgrade, verified by the
  negative live smoke.
- Capability routing is registry-driven (`supportsTools`/`MODEL_CAPABILITIES`), not brand rank.
- Tool args/results never hit Tokzen, the relay, or the logs (elided by `sanitizeForLogs`).
