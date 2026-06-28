# RED TEAM — Desktop tool-calling parity (feat/desktop-parity)

Adversarial review of the desktop port that brought tool calling to parity with web.
Scope: `apps/desktop/lib/{gateway,chat-client,store,web-tools}.ts`,
`apps/desktop/app/_components/{ChatPanel,MessageBubble}.tsx`, compared to the
`apps/web` reference. Source is READ-ONLY; this is the only file written.

Ground truths established before charging (so the blue team can check them):

- Gateway SSE writer emits frames as `` `data: ${JSON.stringify(payload)}\n\n` ``
  (`apps/gateway/src/handler.ts:1168,1207,1220,1243,1266,1270`) — i.e. a literal
  `data: ` **with a space**, LF-terminated, one JSON object per line.
- Desktop `ChatMessageUi.content` is **`string` only** (`store.ts:41`); the
  persisted thread store therefore *cannot* hold `tool_call` / `tool_result`
  content blocks.
- Desktop `chat-client.streamChat` **does not forward `threadId`** to the gateway
  (`chat-client.ts:59-70`), so every desktop turn is reconstructed entirely from
  the client-side store — there is no server-side thread as a backstop.
- The single-turn happy path *is* wired end-to-end (toggle → `tools` in body →
  `accumulateToolCallDeltas`/`finalizeToolCalls` → cards in `MessageBubble`
  (`ChatPanel.tsx:494`) → `executeWebToolCall` → feed-back → answer). The defects
  below are in durability across turns / regenerate, robustness, and a couple of
  divergences from web.

---

## 1. CRITICAL/HIGH — Tool turns are not persisted; the *next* turn ships a malformed conversation (empty + adjacent-assistant messages, tool context gone)

**Files:** `ChatPanel.tsx:140-224` (ephemeral `convo`), `store.ts:41` (`content: string`),
`ChatPanel.tsx:259-263` & `:301-303` (history rebuilt from the store).

**Mechanism.** Inside `runTurn`, the `tool_call`/`tool_result` blocks are pushed
only into the local `convo` array (`ChatPanel.tsx:201-218`) — they are **never**
written to the store. The store keeps only `content: string` plus a display-only
`toolCalls` array. A tool round also spawns a *fresh* assistant bubble per round
(`ChatPanel.tsx:221-223`), so after one tool round the persisted thread is:

```
user("…")
assistant("")        // round-0 bubble: model only emitted a tool_call → content ""
assistant("answer")  // round-1 bubble: final text
```

Every later send rebuilds history straight from these store rows
(`ChatPanel.tsx:261` / `:301-303`):
`messages.map(m => ({ role: m.role, content: m.content }))`.

**Concrete failing scenario.**
1. Enable Tools, ask `"what is 1234 * 5678?"` → calculator runs, answer renders. ✅
2. Ask a follow-up `"add 1 to that"`.
3. The outgoing `/v1/chat/completions` body now contains
   `[…, {role:"assistant",content:""}, {role:"assistant",content:"… 7006652"}, {role:"user",content:"add 1 to that"}]`:
   - an **empty-content assistant** message,
   - **two adjacent assistant** messages with no user turn between them,
   - and the `tool_call`/`tool_result` blocks **absent**, so the model has lost
     all record of what it called and what came back.

Anthropic rejects empty text blocks ("text content blocks must be non-empty") and
requires alternating roles; OpenAI 400s on an empty/!tool assistant turn. Best
case (a lenient provider) the model silently loses tool context and answers wrong.

Web does **not** have this in normal use because it carries a `threadId` and the
gateway/engine owns the canonical thread (incl. tool turns) for continued turns
(`web/app/(app)/chat/page.tsx:375,394,635-641`). Desktop is gateway-*stateless*
and forwards no `threadId`, so the client store is the *only* history — and it is
lossy. The "stateless ⇒ nothing to drop" comment (`ChatPanel.tsx:124-131`) is
exactly backwards: statelessness makes the persistence gap fatal, not free.

**Why tests miss it:** the 1047 tests cover `web-tools` and SSE accumulation in
isolation; none exercise a *second* user turn after a tool round.

**Severity:** HIGH (CRITICAL on Anthropic/OpenAI routes).

**Fix:** persist the structured turn. Either widen `ChatMessageUi.content` to
`string | ContentBlock[]` and store the assistant tool_call turn + a synthetic
tool_result turn, or (cheaper) when rebuilding history, drop empty-content
assistant rows and reattach `toolCalls`+results as blocks. Minimum stop-gap: skip
empty-content messages when building `history` (see #2).

---

## 2. HIGH — `regenerate` diverges from web: it does NOT filter empty-content messages, so it re-sends the dangling tool-round bubble

**File:** `ChatPanel.tsx:296-307`. **Web reference:** `chat/page.tsx:697-702`
filters `.filter(m => m.id !== assistant.id && m.content)` — explicitly dropping
empty-content rows. Desktop's `regenerate` does
`messages.slice(0, idx).map(m => ({ role: m.role, content: m.content }))` with
**no `&& m.content` filter**.

**Scenario.** After a tool round (thread = `user, assistant(""), assistant(ans)`),
hit Regenerate. `lastAssistant` is the round-1 bubble; `history` =
`[user, assistant("")]`. The model is asked to continue from an **empty assistant
turn**, with the tool_call/tool_result context gone. Same malformed-conversation
failure as #1, now reachable with a single click on the demo turn.

Also note `regenerate` only resets the *last* assistant bubble; the intermediate
empty tool-round bubble(s) are **orphaned** in the thread permanently and re-sent
on every subsequent turn.

**Severity:** HIGH.

**Fix:** mirror web — `.filter(m => m.id !== lastAssistant.id && m.content)` when
building the regenerate history, and drop the orphaned intermediate tool-round
bubbles (or fold them into a single assistant turn).

---

## 3. MED — Desktop drops the gateway's structured `422 unsupported_capability` error (web renders message + provider suggestions)

**File:** `gateway.ts:393-398` throws a generic
`Error(body?.error?.message ?? "Gateway error …")`. **Web reference:**
`web/lib/gateway.ts:607-630` parses the `422 {error:{type:"unsupported_capability",
required, suggestions}}` into `UnsupportedCapabilityError`, and the chat page
renders the honest message + "Try a different provider" suggestion list
(`chat/page.tsx:486-496`).

**Scenario.** Enable Tools, force an explicit non-tool-capable provider via the
Override select. Gateway returns the documented `422` (see the `tools` param doc
at `gateway.ts:349-351`). Desktop surfaces a bare error string and loses the
`suggestions[]` that tell the user which provider to switch to. Honest but
strictly worse than web; an actionable error becomes a dead end.

**Severity:** MED.

**Fix:** port `UnsupportedCapabilityError` + the 422 branch into desktop
`gateway.ts`, and render its `suggestions` in `ChatPanel`/`MessageBubble`.

---

## 4. MED → LOW — Desktop SSE loop is hand-rolled and less hardened than web's `readSseData`; a single bad frame aborts the whole stream (losing already-accumulated text *and* tool calls)

**File:** `gateway.ts:422-476`. Differences vs web's `readSseData`
(`web/lib/gateway.ts:49-82`):
- **`JSON.parse(payload)` is NOT wrapped in try/catch** (`gateway.ts:441`). Web
  does `try { JSON.parse } catch { continue }` and skips the frame. On desktop a
  single malformed/partial `data:` frame throws, unwinds the whole `while` loop
  before `finalizeToolCalls` runs (`gateway.ts:482`), and the turn dies — any
  tool calls already accumulated are lost.
- **`buffer.split("\n")`** only — web uses `split(/\r\n|\r|\n/)`. CRLF/CR streams
  would leave a trailing `\r` (currently masked only because the payload is
  `.trim()`-ed at `:436`).
- **`startsWith("data: ")` + `slice(6)`** requires the trailing space; web uses
  `startsWith("data:")` + `slice(5)`. A spaceless (but spec-valid) `data:{…}`
  frame is silently skipped by desktop → "stream ended without provider metadata"
  throw at `:478-480`.

**Live-fire status (honest):** the current gateway always emits valid JSON,
`data: ` with a space, and LF (`handler.ts:1168` etc.), so **none of these trigger
today**. This is a robustness/parity regression, not a live crash — rated
accordingly so it isn't over-sold.

**Severity:** LOW (latent; MED if the gateway's framing ever changes or a relay
re-chunks frames).

**Fix:** reuse a shared hardened reader (extract web's `readSseData` to a shared
package) instead of re-implementing a stricter, unguarded parser per app.

---

## 5. LOW — `void refresh()` fires a full provider-status fetch on *every* tool round

**File:** `ChatPanel.tsx:168` — inside the `for (round …)` loop. `refresh()` calls
`fetchProviderSnapshot()` (gateway `/v1/status`). A 5-round tool loop issues up to
6 `/v1/status` round-trips per user message purely to refresh the provider rail.
Web's per-round call is the lighter `loadLastTrace()` and is gateway-gated
(`chat/page.tsx:413-415`); desktop pulls the heavier full snapshot each round.

**Severity:** LOW (efficiency).

**Fix:** refresh provider status once after the loop completes, not per round.

---

## Honesty verdict on FEATURE-MATRIX "Desktop ✅ (built-in tools)"

The claim is **true for a single user turn**: the toggle is wired, `tools` reach
the gateway, deltas accumulate, cards render in the desktop `MessageBubble`
(`ChatPanel.tsx:494`, `MessageBubble.tsx:185-199`), tools execute locally
(eval-free calculator — CSP-safe, `web-tools.ts:23-80`), and results feed back in
a bounded ≤5-round loop. The ✅ **overstates durability**: per #1/#2 the feature
breaks on the *next* turn and on *Regenerate* because the structured tool turns are
never persisted and empty/adjacent-assistant messages are shipped to the provider.
A calibrated matrix line would read "Desktop ✅ single-turn; multi-turn/regenerate
loses tool context (no persisted tool blocks)".

## Non-charges (checked, parity holds — pre-empting blue-team rebuttals)

- Tool-call **rendering** is correctly wired (`toolCalls` persisted via store
  `partialize`, passed to `MessageBubble`, rendered as cards). ✅
- **No tool-arg log leakage**: desktop has no terminal-line logging of
  `JSON.stringify(arguments)` (web logs to its in-app terminal pane, not console).
- Calculator uses a recursive-descent evaluator, **no `eval`/`Function`** —
  CSP-safe. ✅
- `toolChoice` unset on both desktop and web `streamAssistant` — parity, not a bug.
- The **stateless full-history** claim is literally true (desktop sends full
  history every turn); the problem is the history is *incomplete* (#1), not that
  it's stateless.
