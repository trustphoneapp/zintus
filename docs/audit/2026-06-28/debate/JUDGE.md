# Adversarial Debate — Judge's Ruling (2026-06-28)

A 2-round red/blue debate over the post-build tool-calling + structured-output +
multimodal + CSP work. Red team filed numbered charges (`red-*.md`); blue team read
and rebutted each (`blue-*.md`); this is the adjudication + what was applied.
Final state after fixes: **typecheck clean, 1031 tests, 0 fail.**

## Applied (charges that survived rebuttal)

| # | Charge | Verdict | Fix |
|---|---|---|---|
| STR-1 | Strict json_schema returns **200 on the default STREAMING path** (422 only on stream:false) | CONFIRMED CRITICAL | Pre-stream 422: handler checks `wantsStrictSchema && !valid` before opening the SSE stream (engine buffers structured output, so validity is known). |
| TOOL-1 | OpenAI-native assistant `tool_calls`/`content:null` can't round-trip (schema strips it) | CONFIRMED HIGH (not "loop impossible" — Zintus-native content blocks already work) | `OpenAiToolCallSchema` + nullable content w/ refine; `parseMessages` normalizes to internal tool_call blocks. |
| STR-3 | Gemini `normalizeSchema` drops `oneOf`/`pattern`/length → typeless → 400 | CONFIRMED HIGH | Allow-list → strip-list; `oneOf`→`anyOf`; constraints retained; bare-`$ref` left intact. |
| TOOL-3 | Strict tool `parameters` sent raw → 400 | CONFIRMED HIGH (opt-in) | Apply `normalizeOpenAiStrictSchema` to a tool's params when `strict`. |
| STR-2 | `normalizeOpenAiStrictSchema` forces optionals `required` without `null` | CONFIRMED (latent) | Widen optional-field `type` with `"null"`. |
| TOOL-4 | Cache guard uses `requiresTools`, not `hasToolTurns` (continuation turn cached) | CONFIRMED MED | Guard read+write on `hasToolTurns` too. |
| E2 | Gemini tool-name map built unconditionally per request | CONFIRMED (worth it) | Lazy: only when tool turns present. |
| H1/H2 | Marketing/pricing claim tool calling on **Web + Desktop** UI (it's API/CLI-only) | CONFIRMED (honesty) | Scoped copy to "API & CLI"; FEATURE-MATRIX web tools/structured → 🟡, desktop ❌. |
| H3 | `capabilities.ts:10-17` comment says engine "does not yet emit tools/…" (false) | CONFIRMED | Comment rewritten. |

## Refuted / tempered
- **TOOL-1 "loop impossible / CRITICAL"** → tempered to HIGH: the Zintus-native
  `tool_call`/`tool_result` content-block shape validates and routes end-to-end (the
  web client uses it); only the OpenAI-native top-level-`tool_calls` shape was broken.
- **TOOL-2 "persist toolCalls to fix threaded loop"** → PARTIAL: persistence isn't
  the blocker; the `message+thread_id` entrypoint is string-only. Logged, not fixed
  (would need a separate threaded-tools design).
- **E5** (some efficiency claim) → withdrawn by red team.
- **CSP "unverified" honesty** → red team CONCEDED it's correctly labeled unverified.

## Deferred (LOW, logged not fixed)
`extractJsonObject` first-balanced-span hijack on adjacent JSON; repair-loop context
duplication; dead eager `extractJsonObject` pass; FIFO (not LRU) validator-cache
eviction; Gemini synth-id reset per stream. None affect correctness on the common
path; candidates for a follow-up cleanup PR.

## Takeaway
The debate earned its keep: it caught **STR-1**, a CRITICAL honesty/contract bug the
earlier independent-review pass had marked "verified, no change needed," and forced
the marketing copy to match reality — while also refuting/tempering the weaker
charges instead of rubber-stamping them.
