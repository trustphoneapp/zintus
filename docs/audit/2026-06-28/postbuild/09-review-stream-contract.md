# 09 — Streaming-Contract Review: Tool Calling + Structured Output

Branch `feat/tool-calling`. Scope: the decision to keep `RouteStreamResult.stream`
as `AsyncIterable<string>` and add a PARALLEL live `toolCalls` array + a buffered
structured-output path, instead of changing `stream` to `AsyncIterable<StreamChunk>`.

Verdict: **SOUND overall.** The parallel-channel design is correct given how every
consumer actually drains, the buffered path preserves side-effects, and the new
`StreamChunk` fields are additive/backward-compatible. Two real gaps (tools⊕structured
drop; convention-not-type invariant) are IMPROVE, not blockers.

---

## (1) Parallel-channel `toolCalls` — SOUND (no partial-read hazard in practice)

The "live array, read after drain" contract is documented at
`packages/types/src/route.ts:302-316` and the data-flow is single-drain end-to-end:

- **Producer (router):** `packages/router/src/factory.ts:738` allocates
  `collectedToolCalls`, pushes inside the `for await` over `result.stream`
  (`factory.ts:754-756`), and returns the SAME array reference on the result
  (`factory.ts:842-847`). The array is only mutated while the text generator is
  being consumed.
- **Forwarder (engine):** `packages/engine/src/engine.ts:844` forwards
  `result.toolCalls` BY REFERENCE; `wrappedStream` (`engine.ts:776-835`) iterates
  the router stream, so draining the engine stream drains the router stream, which
  fills the array. The engine's own cache-skip read of `result.toolCalls`
  (`engine.ts:798`) happens inside the `finally`/post-loop, i.e. after drain — same
  populated reference the gateway sees.
- **Consumers — all read AFTER drain:**
  - Gateway non-stream: `apps/gateway/src/handler.ts:988-993` drains, THEN reads
    `result.toolCalls` at `handler.ts:1010`.
  - Gateway stream: drains via manual iterator `handler.ts:1103-1137`, THEN reads
    `result.toolCalls?.length` at `handler.ts:1144`.
  - CLI: drains `handler`'s analog at `apps/cli/src/commands/chat.ts:181-183`, THEN
    reads at `chat.ts:189`.

**Can a consumer read `toolCalls` empty/partial?** Only by violating the documented
"drain first" rule — no in-repo consumer does. Because the producer mutates a single
array reference under a single drain and every reader gates on completion of that
drain, there is no TOCTOU and no copy-staleness. SOUND.

Residual risk (IMPROVE, `route.ts:316`): the invariant is convention, not type-
enforced. An `AsyncIterable<string>` gives a reader no signal that the side-channel
is complete; a future consumer that peeks early gets a silently-partial array. See
recommendation (4).

## (2) Buffered structured-output path preserves side-effects — SOUND

`engine.ts:520-666`. `dispatchAndDrain` (`engine.ts:530-550`) fully drains each
dispatch, so the router's drain-tail fires exactly as on the streaming path:
`recordUsage` success, `onUsage`, `clearCooldown`, sticky-session set, and the
`status:"success"` attempt event (`factory.ts:762-795`) all run. Re-dispatch for
repairs reuses the SAME `onAttempt` (`engine.ts:502-509`, passed at `:541`), so every
attempt — including repairs — accumulates on one trace. Persistence parity:
assistant message + `updateMemoryAfterTurn` (`engine.ts:604-615`), `completeTrace`
(`:627-629`), and `exportRequestTrace` with real `attemptEndsMs` (`:630-638`) mirror
the normal path (`engine.ts:783-833`). Cache is intentionally skipped both read and
write (`:511-519`) — correct, since unvalidated/non-conforming text must not be
replayed. The single-chunk replay (`engine.ts:641-648`) keeps `.stream` consumers
byte-shaped. SOUND.

Minor (IMPROVE): `onUsage` fires once PER dispatch, so on a repaired turn the gateway's
`capturedUsage` reflects only the LAST dispatch, under-reporting total tokens billed
across repair round-trips. Honest per-call, but not cumulative.

## (3) Channel × `privacyHonored` interaction — SOUND

`privacyHonored` is computed per winning attempt (`factory.ts:851-854`) and forwarded
independently of `toolCalls` (engine `:851`, structured `:655`). The three channels
(`stream`, `toolCalls`, `privacyHonored`) never alias. On the structured path
`privacyHonored` correctly tracks the FINAL dispatch's winner (`engine.ts:655` reads
`structuredResult`, reassigned on each repair at `:586-587`) — honest after provider
hops. Gateway surfaces it on both paths (`handler.ts:922-923`, `:1074`, `:1200`)
without coupling to tool-call presence. No bad interaction.

## (4) Cleaner shape — recommendation

Keep the parallel array (blast-radius argument is valid: changing `stream`'s element
type touches ~50 mocks + every provider/consumer). To remove the convention-only
footgun, make completion type-observable WITHOUT changing the text element type:
add a sibling `toolCallsComplete?: Promise<ToolCallContentBlock[]>` that resolves when
the generator finishes (router resolves it in the `finally` at `factory.ts:834-839`;
engine forwards/chains it). Readers that must not race can `await` it; existing readers
that already drain-then-read are unaffected. This is additive, ~3 sites, and converts
"read after drain" from a comment into an awaitable contract. RECOMMENDED (IMPROVE).

Also IMPROVE — **tools ⊕ structured output silently drops tool calls.** The structured
branch (`engine.ts:520-666`) never reads or forwards `structuredResult.toolCalls`; a
request carrying BOTH `tools` and a non-text `responseFormat` returns `toolCalls:
undefined`. Either forward them or hard-error the combination at the router gate
(alongside the existing capability gates `factory.ts:578-601`) so the drop isn't silent.

## (5) `StreamChunk.toolCall`/`finishReason` backward-compat — SOUND

Both fields are optional additions (`packages/types/src/stream.ts:62-75`). A chunk
carries `content` XOR `toolCall`; the text path is untouched. The router aggregator
(`factory.ts:743-761`) branches on `chunk.usage` / `chunk.toolCall` / `chunk.content`
independently and simply IGNORES a chunk that carries only `finishReason` or `done`,
so `finishReason` never needs to propagate through the string stream — it is a
provider-layer signal consumed where tool calls are drained. Providers emit the new
fields additively: OpenAI-compat `packages/providers/src/utils.ts:186-208,243-249`
(accumulate fragments → `drainToolCalls` → `finishReason`), Gemini
`packages/providers/src/providers/gemini.ts:242-269` (synthesizes `call_<name>_<idx>`
ids, maps STOP/MAX_TOKENS/SAFETY). The web SSE parser (`apps/web/lib/gateway.ts:583-
662`) and the `test-utils` mock (`packages/test-utils/src/index.ts:131-143`, content-only
chunks) both remain valid — the mock emits no tool/finish fields and still type-checks.
Suite 971 green is consistent with additive-only changes. SOUND.

---

### Classification summary

| # | Area | file:line | Class |
|---|------|-----------|-------|
| 1 | Parallel `toolCalls`, no partial-read | route.ts:316; factory.ts:738,842; engine.ts:844; handler.ts:1010,1144 | SOUND |
| 1b | Invariant is convention, not type | route.ts:316 | IMPROVE |
| 2 | Buffered structured preserves side-effects | engine.ts:520-666 | SOUND |
| 2b | `onUsage` not cumulative across repairs | engine.ts:541; handler.ts | IMPROVE |
| 3 | `privacyHonored` × channels | factory.ts:851; engine.ts:655 | SOUND |
| 4a | `toolCallsComplete` promise | factory.ts:834 (new) | IMPROVE |
| 4b | tools ⊕ structured drops tool calls | engine.ts:520-666 | IMPROVE (latent HAZARD) |
| 5 | `StreamChunk` additive fields | stream.ts:62-75; utils.ts:186-249; gemini.ts:242-269 | SOUND |
