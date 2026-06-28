# RED TEAM — Efficiency + Honesty charges (feat/tool-calling)

Date: 2026-06-28. Challenger brief. 987 tests pass; these charges target what the
tests do **not** assert: per-call CPU/allocation in the hot provider/proxy paths,
and copy/docs that claim a capability the shipped *surface* can't deliver.

Each charge: `file:line` · scenario/measurement · severity · proposed change.
A blue rebuttal follows; charges are written to be falsifiable.

---

## EFFICIENCY

### E1. `toOpenAiMessages` makes 4 passes + 2 array allocations per block-array message
`packages/providers/src/openai-compat.ts:111-128`

Scenario: every message whose `content` is a `ContentBlock[]` (image/tool turns)
is scanned four separate times:
- `content.filter(tool_result)` (line 111) — alloc array #1
- `content.filter(tool_call)` (line 114) — alloc array #2
- `textOf(content)` (line 117) — full iteration
- `content.some(b => b.type === "image")` (line 128) — full iteration

Measurement: a turn with `N` blocks → `4N` block visits + 2 throwaway arrays,
done synchronously while building the request body on the send path. Plain-string
turns short-circuit at line 106, so this only bites multimodal/tool turns — but
those are exactly the largest payloads.

Severity: **Low** (N is small per turn; not a loop over history). Real but bounded.

Proposed change: one `for` pass that collects `toolResults`, `toolCalls`,
`hasImage`, and joined `text` into locals; drop the two `.filter` allocations.

### E2. `splitGeminiMessages` builds the tool-name map unconditionally + double-filters the array
`packages/providers/src/providers/gemini.ts:172-196`

Scenario: `buildToolNameMap(messages)` (line 173 → 101-111) walks **every** message
and **every** nested content block on **every** request — even a plain text chat
with zero `tool_result` blocks, where the resulting Map is never read. Then
lines 174-187 and 186-196 filter the same `messages` array twice
(`role === "system"` then `role !== "system"`), allocating two arrays and making
two full passes.

Measurement: a 50-turn text conversation → ~50 message + nested-block visits for a
Map that stays unused, plus 2 more full array passes. Cost scales with history
length, and runs once per streamed request.

Severity: **Low–Medium** (grows with conversation length; pure waste when no tools
are present, the common case).

Proposed change: short-circuit — only build the name map when
`messages.some(m => isContentBlockArray(m.content) && m.content.some(b => b.type === "tool_result"))`.
Partition system/non-system in a single loop.

### E3. `parseOpenAiSseStream` accumulates tool-call args via repeated string `+=`
`packages/providers/src/utils.ts:109` (`acc.args += delta.function.arguments`)

Scenario: a single large tool-call argument JSON is streamed as many small SSE
fragments; each fragment does `acc.args += fragment`. Worst-case repeated
concatenation is super-linear; for a multi-KB argument spread over dozens of
deltas this re-copies the growing buffer each delta.

Severity: **Low** (V8 ropes mitigate; bounded by argument size). Noted for
completeness — the accumulation path itself is otherwise clean.

Proposed change: buffer fragments in a `string[]` per index and `join("")` once in
`drainToolCalls`.

### E4. `proxy.ts buildCsp` rebuilds the full directive array on every request
`apps/web/proxy.ts:36-83` (called at line 92 in `proxy()`)

Scenario: the CSP is identical for every request **except** the `nonce-…` token,
yet `buildCsp` allocates a 5-element `scriptSrc` array, `.filter(Boolean)`,
`.join`, then a 13-element directive array and a second `.join` — on **every**
matched page request (the matcher covers all non-static, non-API routes).

Measurement: per request: 1 `crypto.randomUUID()` + `btoa` + 2 array allocs +
`filter` + 2 `join`s + a full `new Headers(request.headers)` clone (line 116). The
static 12/13 directives never change between requests.

Severity: **Low** (cheap relative to render; but it is per-navigation, fixed waste).

Proposed change: precompute the static directive list (and the `script-src`
prefix/`IS_DEV` suffix) once at module load; per request only interpolate the
nonce into the one `script-src` entry and `join`. `IS_DEV`/`REPORT_ONLY` are
already module constants — extend that to the whole static body.

### E5. `capabilities.ts` "repeated lookups" — weak charge, disclosed
`packages/providers/src/capabilities.ts:125-210`

`supportsVision` / `supportsTools` / `structuredOutputLevel` each re-index
`MODEL_CAPABILITIES[providerId]` and a `Set.has`. These are O(1) hash lookups on
tiny fixed maps; calling all three for one route is ~6 O(1) ops. **No meaningful
inefficiency** — flagged only to pre-empt the "repeated lookups" framing: the cost
is negligible and not worth a memo/cache that would add staleness risk.

---

## HONESTY

### H1. Web "Tool calling" is a library capability, NOT a user-reachable chat feature — marketing implies it is
`apps/web/components/marketing/Features.tsx:36-40` ("Tool calling … routes only to
models that support function calling") + `:65-70` ("CLI + Web + Desktop … all
driven by one BYOK config") and `apps/web/app/pricing/page.tsx:24` (FREE_FEATURES
"Tool calling, JSON & image input") + `:27` ("CLI + Desktop + Web").

Reality on the web chat surface:
- The chat page's send path uses `streamChat` whose only output hook is
  `onChunk: (text: string) => void` (`apps/web/lib/chat-client.ts:48`). It surfaces
  **text only** — there is no tool-call callback.
- `MessageBubble` is rendered at `apps/web/app/(app)/chat/page.tsx:734` with **no**
  `toolCalls` and **no** `structured` prop; a repo-wide grep for `toolCalls=` /
  `structured=` returns **zero** call sites.
- `MessageBubble.tsx:191-210` *can* render tool-call cards / a "Structured output"
  block, but nothing on the chat surface ever feeds them. The composer also exposes
  no way to define tools and never sends `tools`.

So tool-call reassembly exists and is unit-tested at the lib level
(`apps/web/lib/gateway.ts:495-516`, `accumulateToolCallDeltas`/`finalizeToolCalls`),
but a web *user* cannot define a tool or see a tool call. Marketing copy ("Tool
calling", listed under a "CLI + Web + Desktop" product) and the FEATURE-MATRIX line
"Tool / function calling — now present on **Web**" read as an end-user web feature.

Severity: **Medium–High**. This is the matrix's own cautionary pattern ("a surface
may only show ✅ when wired end-to-end … not when the UI merely exists",
`docs/FEATURE-MATRIX.md:256-259`) — here the component exists but is unwired on the
only web chat surface.

Proposed change: either wire the chat path to pass `result.toolCalls` into
`MessageBubble`, or qualify the copy to "Tool calling (CLI + gateway API)" and
downgrade the matrix "Web" tool-calling claim to 🟡 "gateway/lib only, no chat UI".

### H2. Pricing/marketing imply Tool calling + JSON + **Image input** work on **Desktop**; they do not
`apps/web/app/pricing/page.tsx:23-28` lists, in one Free-tier block, "Tool calling,
JSON & image input" **and** "CLI + Desktop + Web". `Features.tsx:48-52` ("Image
input … Send images to vision-capable models") sits in the same grid as
":65-70 CLI + Web + Desktop".

Reality (`docs/FEATURE-MATRIX.md`): "**Desktop/mobile have no tool UI**"
(line 116); "**Multimodal image input** — proven on **web + CLI** … Desktop/mobile
image UI is still absent (❌)" (lines 121-123); matrix row #24 image input Desktop =
❌. So three of the headline capabilities are web/CLI-only, but the pricing bullet
pairs them with a "CLI + Desktop + Web" surface line — a reader concludes desktop
does images/tools/JSON.

Severity: **Medium**. Same end-to-end-claim rule as H1.

Proposed change: scope the bullet ("Tool calling, JSON & image input — CLI + Web")
or footnote desktop as chat-only for these.

### H3. `capabilities.ts` header doc is stale and now actively FALSE
`packages/providers/src/capabilities.ts:10-17`

The doc block states: "As of 2026-06 the engine **does not yet emit image parts,
`tools`, or `response_format`**; the `vision`/`tools`/`json` flags mark what each
default model COULD do so those features can route correctly **once wired**."

This is contradicted by the same branch: tools, structured output, and image parts
**are** wired and tested (`docs/FEATURE-MATRIX.md:106-123`; `openai-compat.ts`
emits `tools`/`tool_choice`/`response_format` at lines 377-381; `gemini.ts` emits
`functionDeclarations`/`responseSchema`). A reader of this file is told the
features are unwired when they ship. Internal doc, but it is exactly the kind of
"silently claims the wrong state" the audit polices — in the wrong direction.

Severity: **Medium** (misleads maintainers; risks gating logic being left dead).

Proposed change: update the header to "tools/structured/image ARE wired as of
2026-06-28; flags describe API capability, runtime now uses them."

### H4. "Sub-5ms routing" is an unqualified hard performance number
`apps/web/components/marketing/Features.tsx:18-22` ("Sub-5ms routing … no extra
network hop, no proxy in the middle").

Unlike every savings figure on the site (all carefully labeled "estimate", see H6),
this is a precise latency guarantee with no measurement citation, no "typical", no
"on our benchmark". The repo's routing fast-path (`@zintus/router` quota check) may
well be sub-5ms, but the number is asserted as fact to every visitor with nothing
behind it in the changed code.

Severity: **Low–Medium** (precision implies a benchmark that isn't shown).

Proposed change: soften to "in-process routing (no network hop)" or cite the
benchmark; drop the specific "5ms" unless a test asserts it.

### H5. "Structured output: Ask for JSON and get it." over-promises for non-Gemini
`apps/web/components/marketing/Features.tsx:42-46`

Headline "Ask for JSON and get it." reads as a guarantee. The body **does** correct
it ("Schema-constrained … where the provider guarantees it (Gemini), best-effort
JSON mode elsewhere"), and `capabilities.ts:55-60` is conservative
(`json_object`/`none` for most). So the qualifier exists, but the bolded promise
contradicts the "best-effort" body for ~9 of 11 providers.

Severity: **Low**. Borderline — the body saves it.

Proposed change: headline "Ask for JSON" (drop "and get it") to match the
best-effort reality.

---

## HONESTY — CHECKS THAT PASS (no charge; pre-empting blue points)

- **CSP is NOT described as verified anywhere.** `apps/web/proxy.ts:50-51`
  explicitly says "Verify the real policy against `next build && next start`, never
  `next dev`," and `docs/FEATURE-MATRIX.md:124-127` states "**NOT yet
  browser-verified** — the in-browser check … is the remaining [HUMAN] step." This
  is correctly honest. ✅ No violation.
- **Savings numbers are labeled estimates** everywhere they appear:
  `TransparencyStrip.tsx:79` (tooltip "Estimated savings…"), `:110` ("~… est"),
  `dashboard/page.tsx:291` ("estimate — free-tier tokens valued at list pricing"),
  `Features.tsx:57` ("estimated savings"). ✅ No violation.
- **No false Vision badge.** `providers/page.tsx:54-67` `CapabilityBadges` drives
  the Vision chip from `MODEL_CAPABILITIES[providerId].vision`, which is `true` only
  for Gemini's default; OpenRouter's vision-capable models are deliberately kept
  off the provider **default** (`capabilities.ts:98-114`). Chips reflect best-effort
  doc-scraped API capability without a "runtime may differ" caveat, but no chip
  asserts vision on a non-vision default model. ✅ Minor at most.
- **Paid tiers honestly gated.** `pricing/page.tsx:17,113,225-231` guard checkout
  behind `MANAGED_KEYS_AVAILABLE = false` and render "Coming soon"; referral copy
  (`dashboard/page.tsx:513-518`) says payouts "can't be withdrawn yet." ✅ Consistent
  with the hard-rule audit.

---

## Priority for blue rebuttal
1. **H1** (web tool calling not user-reachable) — strongest; concrete unwired path.
2. **H2** (desktop image/tools/JSON implied by pricing) — matrix self-contradiction.
3. **H3** (capabilities.ts header now false).
4. **E2 / E4** (unconditional Gemini name-map; per-request CSP rebuild) — real, low.
