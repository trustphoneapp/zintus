# BLUE TEAM — Rebuttal to RED desktop tool-calling parity charges

Adjudicated against the actual code on `feat/desktop-parity`. Each charge is ruled
CONFIRMED / REFUTED / PARTIAL with proof. Source read-only; this is the only file
written.

---

## 1. Tool turns not persisted; next turn ships a malformed conversation — **CONFIRMED**

The mechanism is real and I traced it end-to-end.

- **Store can't hold structured turns.** `store.ts:41` — `content: string`. The
  persisted thread (`partialize`, `store.ts:214-217`) keeps only `content` +
  display-only `toolCalls`. No `tool_call` / `tool_result` blocks survive.
- **The loop spawns a fresh assistant bubble per round and never writes the
  structured turn to the store.** `ChatPanel.tsx:201-218` pushes the
  assistant(text+tool_call) and user(tool_result) turns into the local `convo`
  array ONLY. `:221-223` does `createChatMessage("assistant", "")` →
  `appendMessage(next)`. So after one calculator round with no preamble text the
  store thread is:
  ```
  user("what is 1234 * 5678?")
  assistant("")        // round-0 bubble: tool_call only, content stayed ""  (:157 only sets streamedText)
  assistant("…7006652")// round-1 bubble: final text
  ```
  The empty-content round-0 bubble is conditional (empty only when the model emits
  no preamble before the tool call), but the **two adjacent assistant bubbles are
  unconditional** — there is no user turn between them in the store.
- **The next send maps ALL store rows verbatim.** `ChatPanel.tsx:259-263`:
  `...messages.map((m) => ({ role: m.role, content: m.content }))` then appends the
  new user turn. Desktop forwards **no `threadId`** (`chat-client.ts:47-70` has no
  threadId field; `gateway.ts:385` receives `undefined`), so the client store is
  the only history and it is lossy.

Outgoing body on the 2nd user turn:
`[user, assistant(""), assistant("…7006652"), user("add 1 to that")]` — empty
assistant text + two adjacent assistant roles + tool_call/tool_result blocks gone.

**Is it actually fatal at the provider?** Yes — nothing downstream sanitizes it.
The engine repair path only *adds* alternating turns for structured output
(`engine.ts:631-639`); it does not normalize inbound history. Gemini's adapter maps
each message 1:1 to `{role: model|user, parts}` with **no merge of adjacent
same-role turns and no drop of empty parts** (`gemini.ts:210-220`). So the
malformed sequence reaches Gemini, which requires strict role alternation and
non-empty parts → rejection. OpenAI/Anthropic likewise reject empty/adjacent
assistant turns. Lenient providers silently lose tool context. CONFIRMED.

**Honest caveat (not a refutation, but a parity correction):** RED claims "web
does NOT have this." Web is protected by `threadId` ONLY on non-tools turns. On a
**tools** turn web *also* sends the full unsanitized history regardless of
threadId — `chat/page.tsx:635-641` (`threadId == null || toolsEnabled ? [...leading,
...history] : ...`) and `history` at `:588-594` maps every row with no
`&& content` filter. So the same defect lives in the web reference's tools path.
This makes #1 a *shared* tool-feature bug, not a desktop-only regression — but it
is still unambiguously present on desktop (every second turn, no threadId escape
hatch), so the charge stands.

**Minimal fix (recommended — option (a), shared sanitizer):** add one helper used
by both `doSend` and `regenerate` when building the outbound `history`:
```ts
function buildSendHistory(messages: ChatMessageUi[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && !m.content.trim()) continue; // drop empty turns
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${m.content}`.trim();         // merge adjacent
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
```
This guarantees a valid alternating, non-empty conversation and fixes #1 and #2 in
one place. It still *loses* the structured tool context (the store never had it),
so the durable fix is option (b): widen `ChatMessageUi.content` to
`string | ContentBlock[]` and persist the assistant tool_call turn + synthetic
tool_result turn. Recommend shipping (a) now (cleanest, one helper, no schema
change) and tracking (b) for true multi-turn tool fidelity — and applying the same
sanitizer to web's tools path.

---

## 2. `regenerate` lacks the `&& m.content` filter — **CONFIRMED**

`ChatPanel.tsx:301-303`:
```ts
const history = messages.slice(0, idx).map((m) => ({ role: m.role, content: m.content }));
```
No content filter. Web reference `chat/page.tsx:701` does
`.filter((message) => message.id !== assistant.id && message.content)`. Confirmed
divergence. After a tool round, Regenerate replays
`[user, assistant("")]` (the dangling empty tool-round bubble), reproducing #1 with
a single click. RED's secondary point also holds: `regenerate` only resets the last
assistant bubble (`:305`); intermediate empty tool-round bubbles are orphaned in the
thread permanently. CONFIRMED.

**Fix:** subsumed by the `buildSendHistory` sanitizer above (drops empty assistant
rows + merges adjacent), applied in `regenerate` instead of the raw `.map`.

---

## 3. Desktop drops the structured `422 unsupported_capability` — **CONFIRMED**

`gateway.ts:393-398` throws a bare
`Error(body?.error?.message ?? "Gateway error ${status}")` for every non-OK
response. Web reference `web/lib/gateway.ts:607-628` branches on
`response.status === 422 && body.error.type === "unsupported_capability"` →
`UnsupportedCapabilityError(message, required, suggestions)`, and the chat page
renders message + "Try a different provider" list (`chat/page.tsx:486-496`).
Desktop has no `UnsupportedCapabilityError`, no 422 branch, and `MessageBubble`
renders only the bare string. The `suggestions[]` are lost. CONFIRMED (MED).

**Fix:** port `UnsupportedCapabilityError` + the 422 branch into desktop
`gateway.ts` and render `suggestions` in `ChatPanel`/`MessageBubble`.

---

## 4. Hand-rolled SSE loop less hardened than web's `readSseData` — **CONFIRMED (latent / LOW, accurately rated)**

All three sub-claims verified:
- **Unguarded `JSON.parse`** — `gateway.ts:441` `JSON.parse(payload)` with no
  try/catch, inside the `while` whose post-loop `finalizeToolCalls` is at `:482`.
  A throw unwinds before finalize → accumulated tool calls lost. Web wraps it
  (`web/lib/gateway.ts:70-75`, `catch { continue }`).
- **`buffer.split("\n")`** — `gateway.ts:429`. Web uses `split(/\r\n|\r|\n/)`
  (`:64`). CRLF leaves a trailing `\r` (currently masked by `.trim()` at `:436`).
- **`startsWith("data: ")` + `slice(6)`** — `gateway.ts:433,436` requires the
  trailing space; web uses `startsWith("data:")` + `slice(5)` (`:67-68`). A
  spec-valid spaceless `data:{…}` frame is skipped → "ended without provider
  metadata" throw at `:478`.

RED is honest that the live gateway always emits valid JSON, `data: ` + space, LF
(`handler.ts:1168` etc.), so none trigger today. This is a robustness/parity
regression, not a live crash. CONFIRMED, correctly self-rated LOW (MED if framing
changes or a relay re-chunks).

**Fix:** extract web's `readSseData` to a shared package and reuse it.

---

## 5. `void refresh()` fires a full provider snapshot every tool round — **CONFIRMED (LOW)**

`ChatPanel.tsx:168` — `void refresh()` is inside `for (round = 0; round <=
MAX_TOOL_ROUNDS; ...)` (loop opens `:145`). `refresh()` →
`fetchProviderSnapshot()` hits `/v1/status` (`store.ts:115-123`). A 5-round loop
issues up to 6 `/v1/status` round-trips per user message just to refresh the rail.
Web's per-round call is the lighter `loadLastTrace()` and is gateway-gated
(`chat/page.tsx:413-415`). CONFIRMED (efficiency, LOW).

**Fix:** move the `void refresh()` to after the loop (single refresh per send).

---

## Summary verdict

| # | Charge | Verdict | Severity |
|---|--------|---------|----------|
| 1 | Tool turns unpersisted → malformed next-turn history | **CONFIRMED** (shared with web's tools path) | HIGH |
| 2 | `regenerate` missing `&& m.content` filter | **CONFIRMED** | HIGH |
| 3 | Drops structured 422 unsupported_capability | **CONFIRMED** | MED |
| 4 | Hand-rolled, under-hardened SSE loop | **CONFIRMED** (latent) | LOW |
| 5 | `refresh()` per tool round | **CONFIRMED** | LOW |

All five charges hold. The one correction to RED: #1 is not desktop-unique — web's
`toolsEnabled` send path ships the same unsanitized full history
(`chat/page.tsx:639`), so the fix belongs in both. Recommended #1 fix: a shared
`buildSendHistory` sanitizer (drop empty-content assistant rows + merge adjacent
same-role turns) used by `doSend` and `regenerate` now; widen
`ChatMessageUi.content` to `string | ContentBlock[]` and persist tool blocks for
true multi-turn fidelity later.
