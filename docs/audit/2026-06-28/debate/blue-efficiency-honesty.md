# BLUE TEAM — Rebuttal to Efficiency + Honesty charges (feat/tool-calling)

Date: 2026-06-28. Adjudicated against the actual code on branch. Read-only review.
Verdict key: **CONFIRMED** (real, with fix) / **REFUTED** (proof it's bogus) /
**PARTIAL** (real kernel, overstated framing).

---

## HONESTY (these matter most)

### H1 — Web "Tool calling" is library plumbing, not a user-reachable chat feature
**Verdict: CONFIRMED.**

Traced the full web send path:
- `apps/web/lib/chat-client.ts:38-72` — `streamChat` is the ONLY wrapper over
  `streamGatewayChat`. Its param object (lines 38-49) has **no `tools` field** and
  its only output hook is `onChunk: (text: string) => void` (line 48). It returns
  `StreamChatResult` (lines 22-31) which carries **no `toolCalls`**.
- `streamGatewayChat` *does* accept `tools?` (`apps/web/lib/gateway.ts:560`) and
  *does* return `toolCalls?` (line 574, finalized at 695/705) — so the library layer
  is fully wired and unit-tested. But `chat-client.ts:58-72` never forwards a `tools`
  argument and discards `result.toolCalls` (it spreads `result` but the typed
  `StreamChatResult` surface drops it; nothing reads it).
- All THREE web chat surfaces call the same wrapper and none passes tools:
  `chat/page.tsx:346`, `terminal/page.tsx:199`, `compare/page.tsx:90`. The
  `chat/page.tsx:361` callback is `onChunk: (text) => updateMessage(...)` — text only.
- `MessageBubble` is rendered at `chat/page.tsx:734-743` with only
  `message`/`isStreaming`/`onRegenerate` — **no `toolCalls`, no `structured`** prop.
  A repo grep for `toolCalls=`/`structured=` JSX call sites returns zero.
- `MessageBubble.tsx:91-118,191-210` *can* render `ToolCallCard`s and a JSON block,
  but nothing on any chat surface feeds those props. The composer offers no way to
  define a tool and never sends `tools`.

So a web *user* cannot define a tool or see a tool-call card. Red's trace is
accurate. This is exactly the matrix's own cautionary rule
(`docs/FEATURE-MATRIX.md:256-259`: "✅ only when wired end-to-end (UI → gateway →
provider), not when the UI merely exists").

Now the claims:
- `Features.tsx:36-40` "Tool calling — Define tools once… routes only to models that
  support function calling" sits in the same product grid as `:65-70`
  "CLI + Web + Desktop … all driven by one BYOK config". Reads as an end-user web+
  desktop feature.
- `pricing/page.tsx:24` FREE_FEATURES "Tool calling, JSON & image input" paired with
  `:26` "CLI + Desktop + Web".
- `docs/FEATURE-MATRIX.md:106` "Tool / function calling — now present on **Web** + CLI
  + gateway (BYOK)". The supporting text underneath is honest (it cites *SSE
  reassembly unit-tested* and *gateway serves tools*), but the bare word "Web"
  violates the file's own end-to-end rule, since there is no web chat UI.

**Minimal honest fix (no need to build web tool UI now):**
- Features.tsx tool-calling body: scope to delivery surface — e.g. append "Available
  via the CLI and gateway API; web chat UI is on the way." OR retitle the product row
  honestly.
- pricing FREE_FEATURES: change `"Tool calling, JSON & image input"` →
  `"Tool calling & JSON (CLI + API), image input (Web + CLI)"`, or split the bullet.
- FEATURE-MATRIX:106 downgrade the web tool claim to 🟡 "gateway/lib only — reassembly
  tested, no chat UI". (The matrix prose already half-says this; make the headline
  word match.)

### H2 — Pricing/Features imply Tool calling + JSON + Image input work on Desktop; they don't
**Verdict: CONFIRMED.**

- `pricing/page.tsx:20-28` lists "Tool calling, JSON & image input" (line 24) in the
  **same Free block** as "CLI + Desktop + Web" (line 26). A reader concludes all three
  run on desktop.
- `Features.tsx:47-52` "Image input — Send images to vision-capable models" shares the
  grid with `:65-70` "CLI + Web + Desktop".
- Reality, per the project's own matrix:
  `docs/FEATURE-MATRIX.md:114-115` "**Desktop/mobile have no tool UI**";
  `:121-123` "Multimodal image input — proven on **web + CLI** … **Desktop/mobile
  image UI is still absent (❌)**"; structured output likewise "Web + CLI + gateway"
  only (`:117`). I confirmed there is no desktop tool/image/JSON UI — the matrix is
  internally consistent that these are web/CLI-only, and the pricing bullet
  contradicts it.

**Minimal honest fix:** scope the pricing bullet — `"Tool calling, JSON & image input
— CLI + Web"` — or footnote desktop as text-chat-only for these three. Do not list
them under a "CLI + Desktop + Web" umbrella unqualified.

### H3 — capabilities.ts header doc is now actively FALSE
**Verdict: CONFIRMED (clear-cut).**

`packages/providers/src/capabilities.ts:10-17` still asserts: "As of 2026-06 the
engine **does not yet emit image parts, `tools`, or `response_format`** … so those
features can route correctly **once wired**." That is false on this very branch:
- `openai-compat.ts:344` builds a `tools` array, `:378` emits `tool_choice`, `:380`
  emits `response_format`.
- `gemini.ts:342` emits `functionDeclarations`, `:365-367` `responseMimeType` /
  `responseSchema`.
- Image parts: `toOpenAiMessages` emits ordered multimodal content parts
  (`openai-compat.ts:140-147`) and `gemini.ts:128-129` emits `inlineData`.

The doc tells a maintainer the features are dead-pending-wiring when they ship —
exactly the "silently claims the wrong state" failure the audit polices, pointed the
wrong way (risk: someone deletes the now-live gating as "unused").

**Minimal honest fix:** replace lines 11-14 with: "As of 2026-06-28 the engine DOES
emit image parts, `tools`/`tool_choice`, and `response_format` (see openai-compat.ts
& gemini.ts). These flags describe each default model's **API** capability and the
router uses them to gate/route those live features." Keep the best-effort/re-verify
caveat.

### H4 — "Sub-5ms routing" unqualified hard number
**Verdict: PARTIAL.**

`Features.tsx:18-22` does assert a precise "Sub-5ms" latency with no benchmark cite,
while every *savings* figure on the site is scrupulously labeled "estimate" (red's own
H6 list; verified at `TransparencyStrip.tsx`, `Features.tsx:57`). The inconsistency is
real and the number implies a benchmark not shown in the changed code. But severity is
genuinely low: it describes an in-process quota check (no network hop), which is
plausibly sub-ms; it is a marketing latency claim, not a correctness/honesty claim
about a shipped capability (unlike H1-H3). Worth a one-word softening, not a blocker.

**Optional fix:** "In-process routing (no network hop)" or add "typical". Low priority.

### H5 — "Ask for JSON and get it." over-promises for non-Gemini
**Verdict: PARTIAL / borderline-REFUTED.**

The bolded headline `Features.tsx:44` "Ask for JSON and get it." is stronger than the
reality for ~9/11 providers — but the **same body sentence** immediately corrects it:
"Schema-constrained decoding where the provider guarantees it (Gemini), best-effort
JSON mode elsewhere" (`:45`), and `capabilities.ts` structured levels are conservative
(`json_object`/`none` for most). The qualifier is present and adjacent, so this does
not rise to a dishonest claim. Cosmetic at most.

**Optional fix:** drop "and get it" from the headline to match the body. Lowest
priority; not required for honesty.

---

## EFFICIENCY

### E1 — `toOpenAiMessages` 4 passes + 2 array allocs per block-array message
**Verdict: CONFIRMED (real) — but NOT worth fixing now.**

Accurate read of `openai-compat.ts:111-128`: `.filter(tool_result)` (111),
`.filter(tool_call)` (114), `textOf` (117), `.some(image)` (128) — four passes over
`content`, two throwaway arrays. Plain-string turns short-circuit at line 106, so this
only hits multimodal/tool turns. Red itself rates it **Low** and correct: `N` =
blocks-per-turn (single digits), not history length; runs once per request. The
current code is readable and type-narrowed. A single-loop rewrite is fine if touched,
but the win is negligible and the existing form is clearer. **Skip unless refactoring
anyway.**

### E2 — `splitGeminiMessages` unconditional name-map + double filter
**Verdict: CONFIRMED — the conditional skip is the one efficiency item worth doing.**

`gemini.ts:172-196`: `buildToolNameMap(messages)` (173 → 101-110) walks every message
and every nested block on EVERY Gemini request, even a plain text chat with zero
`tool_result`s, where the Map is never read (`userParts` only consults it inside the
`tool_result` branch, `:131-145`). Then `:174-185` and `:186-196` filter `messages`
twice (`role === "system"`, then `role !== "system"`). Cost scales with conversation
length — the common case (no tools) pays full price.

This one actually grows with history and runs per streamed request, so unlike E1/E4 it
is the most defensible. Red's proposed guard is sound: only build the map when some
message carries a `tool_result` block; partition system/non-system in one pass.
**Worth fixing — low effort, removes per-request waste that scales with history.**

### E3 — tool-call arg accumulation via `+=`
**Verdict: REFUTED-as-actionable (CONFIRMED-trivial).** Red flags it Low itself.
`utils.ts:109` `acc.args += delta.function.arguments` — V8 rope-strings make this
effectively amortized; bounded by one argument's size, not history. The `string[] +
join` rewrite adds code for no measurable gain. **Not worth it.**

### E4 — `proxy.ts buildCsp` rebuilds full directive array per request
**Verdict: CONFIRMED (real) — marginal; do it only as a tidy-up.**

`apps/web/proxy.ts:36-83`: every matched page request allocates the 5-elem `scriptSrc`
array + `.filter(Boolean)` + `.join`, then the 13-elem directive array + `.join`. Only
the `nonce-…` segment varies; `IS_DEV`/`REPORT_ONLY` are already module constants
(27/34). The static body genuinely could be precomputed once at module load, leaving
per-request work = one nonce interpolation + one join. The charge is correct.

But weight it honestly: this is a few small allocations next to a full SSR render and a
`new Headers(request.headers)` clone (line 116) that dwarfs it. **Low value.** Fine to
precompute the static prefix/suffix for cleanliness, but it is not a meaningful
latency win. Optional.

### E5 — capabilities.ts "repeated lookups"
**Verdict: REFUTED (red withdrew it).** Red explicitly self-disclosed this as a
non-charge: O(1) hash lookups on tiny fixed maps, ~6 ops per route. Agreed — no fix; a
memo would only add staleness risk. No action.

---

## Summary verdicts

| # | Charge | Verdict |
|---|--------|---------|
| H1 | Web tool calling not user-reachable; copy implies it is | **CONFIRMED** |
| H2 | Desktop image/tools/JSON implied by pricing | **CONFIRMED** |
| H3 | capabilities.ts header now false | **CONFIRMED** |
| H4 | "Sub-5ms routing" unqualified | **PARTIAL** (low) |
| H5 | "Ask for JSON and get it" | **PARTIAL** (body saves it) |
| E1 | toOpenAiMessages 4 passes | **CONFIRMED**, not worth it |
| E2 | Gemini name-map unconditional | **CONFIRMED**, worth fixing |
| E3 | tool-arg `+=` | trivial, skip |
| E4 | CSP rebuild per request | **CONFIRMED**, marginal |
| E5 | capabilities lookups | **REFUTED** (withdrawn) |

**Must-correct honesty claims (copy, not new UI):** H1, H2, H3 — scope tool-calling /
structured-output / image copy to its true delivery surface ("CLI + gateway API" for
tools/JSON, "Web + CLI" for images), downgrade the FEATURE-MATRIX web tool headline to
🟡, and rewrite the capabilities.ts header to say the features ARE wired.
**Efficiency worth doing:** E2 only (per-request waste that scales with history).
E1/E4 optional tidy-ups; E3/E5 skip.
