# 02 — Zintus CHAT vs the leading assistant apps (ChatGPT · Claude · Gemini)

Brutal benchmark of Zintus's **chat experience + core capabilities** — features AND UI —
against the mature consumer assistants, as of 2026-06-28. Branch `feat/zintus-10-10`.
Method: read the ACTUAL code per surface (web primary; CLI/desktop parity noted), then
researched current competitor chat UX. **No capability is credited without a real UI path.**
Legend: ✅ real+wired · 🟡 partial/unreachable · ❌ absent.

---

## What Zintus actually has (verified in code)

| Capability | Verdict | Evidence |
|---|---|---|
| Streaming chat, threads, regenerate, stop, incognito, export | ✅ | `apps/web/app/(app)/chat/page.tsx` (streamAssistant, regenerate, stop, newChat menu) |
| Markdown + code blocks + JSON code render + per-msg copy | ✅ | `app/_components/MessageBubble.tsx:211-222`; `Markdown.tsx` (`Markdown`, `CodeBlock`) |
| Image input — web | ✅ | `chat/page.tsx:285-363,600-656`; `@zintus/media processImage` (resize+EXIF strip), 4-img cap, vision guard pre/post-send, regenerate re-send |
| Image input — CLI | ✅ | `apps/cli/src/index.ts:71` `--image` (repeatable, max 4); `commands/chat-content.ts` |
| Image input — desktop | ✅ (now real) | `apps/desktop/app/_components/ChatPanel.tsx:13,66-133` — full `@zintus/media` path. (MATRIX.md still lists "❌ refused" — **stale**; desktop now has parity.) |
| File input | 🟡 text-only | `chat/page.tsx:55-58,336-361` — `.txt/.md/.ts/...` extracted + folded into prompt. No PDF/docx/binary parsing. |
| Voice input | ❌ | No `SpeechRecognition`/`getUserMedia`/`MediaRecorder` anywhere in web/desktop/CLI. |
| Tools / function calling | ✅ built-in only | `chat/page.tsx:386-522`; `lib/web-tools.ts` — calc/datetime/random, bounded 5-round loop, rendered as cards. No user-defined-tool UI, no MCP/connectors in chat. |
| Structured output | 🟡 display-only | `MessageBubble.tsx:43-51,218` auto-detects JSON answers → `CodeBlock`. **No composer path** to request `response_format`/`json_schema` (`chat-client.ts` sends `tools`, never `response_format`). Capability shown in catalog/providers pages but **unreachable from chat**. |
| Route-reason + savings transparency (Phase 6) | ✅ genuinely best-in-class | `packages/engine/src/engine.ts:87-123 buildRouteReason` (honest: cache/failover/privacy/capability-aware) → surfaced as purple chip at message top `MessageBubble.tsx:171-190` + `TransparencyStrip` + `CompressionBadge` (saved-$). |
| Model selection | ✅ | `ProviderPicker.tsx` (provider + 5 strategies: fastest/economy/capability/quality/balanced) + `app/(app)/models/page.tsx` catalog with "Use this model → /chat" (`localStorage zintus:selected-model`, consumed in `chat/page.tsx:394-408`). |
| Memory / projects | 🟡 basic | Memory = on-device `localStorage` string list injected as `<user_memory>` system msg (`lib/memory.ts`). Projects = `localStorage` workspaces (instructions+provider+strategy, `lib/projects.ts`). No auto-extraction, no file-backed projects. |
| Composer hierarchy (Phase 6 cleanup) | ✅ | `chat/page.tsx:1013-1335` — calm: ProviderPicker + single "⚙ More" popover (Search/Tools/Preset/Project); Export moved to header; Incognito under New-chat menu; clean attach + textarea + send row. |

## What the big 3 ship that Zintus does not (2026)

- **Voice:** ChatGPT Advanced/Bidi-1 bidirectional voice; Gemini Live bidirectional audio; (Claude relies on device dictation). Zintus = none.
- **Artifacts / Canvas:** Claude Artifacts (live, runnable, side panel, dedicated artifacts space, persistent state); ChatGPT Canvas; Gemini Canvas (→ Docs/Slides/Colab). Zintus = none (markdown only).
- **Rich files:** all three parse PDFs/docs natively (Claude reads PDFs w/ embedded images; can *create* docx/xlsx/pptx/pdf). Zintus = text-only fold-in.
- **Memory/projects depth:** ChatGPT automatic cross-chat memory; Claude editable memory summaries + file-backed Projects; Gemini Notebooks (50 sources / 500k words). Zintus memory is manual + local-only.
- **First-party tools:** code interpreter, image generation/editing, connectors/MCP. Zintus has web search (✅) + 3 toy built-ins.

---

## Per-axis scores (1-10 + gap to 10)

### 1. Chat UX polish / calm — **8/10** (gap 2)
Composer is genuinely calm post-Phase-6 (one "More" popover, Export in header, Incognito tucked
under New-chat), streaming caret, regenerate/stop/copy/report, prompt cards, honest offline
guidance. **Gap to 10:** no side-panel artifact/canvas workspace, no inline message editing, no
fork/branch threads, fewer refined micro-interactions than ChatGPT/Claude.

### 2a. Multimodal — image input — **8/10** (gap 2)
Real across web+CLI+desktop, EXIF/GPS strip, order-preserving mapper, fail-closed on non-vision
(`factory.ts:562`, `handler.ts:702`), honest "Image analyzed by X", regenerate re-sends bytes.
**More honest** than competitors. **Gap to 10:** PNG/JPEG/WebP only; vision allowlist is narrow
(gemini + 2 OpenRouter Llama-vision ids); **no image generation/editing**; mobile still ❌.

### 2b. Multimodal — voice — **1/10** (gap 9) 🔴
Nonexistent. All three competitors have voice; two are bidirectional. **Single biggest gap.**
Gap to 10: dictation (Web Speech) at minimum; a Live-style voice mode for parity.

### 2c. Multimodal — files/documents — **3/10** (gap 7)
Text-extension fold-in only. No PDF/docx/xlsx/binary parsing — a baseline competitor feature.
Gap to 10: real document blocks (PDF w/ embedded images), and file-backed projects.

### 3. Tools / function-calling UX — **6/10** (gap 4)
Built-in tool loop is well-built (bounded, cards, terminal trace) and web search is real. But
end-user payload is thin (calc/datetime/random), there is **no user-defined-tool UI**, and no
connectors/MCP/code-execution in chat. Consumer apps also hide raw function-calling from
end-users, so this isn't pure parity loss — but they ship far richer first-party tools.
Gap to 10: MCP/connectors in chat, code execution, a real tool catalog (+ optional user tools).

### 4. Structured-output UX — **3/10** (gap 7)
Display-only: auto-renders JSON the model happens to emit. The catalog/providers pages advertise
`json_schema`/`json_object` capability, but **the chat composer offers no way to request it**
(`chat-client.ts` never sends `response_format`). Capability implied, not reachable — an honesty
ding. Gap to 10: a response_format/json_schema request control + schema editor in the composer.
(Note: consumer chat apps don't expose json_schema either — so "10" here means making Zintus's
*own advertised* capability reachable, not matching ChatGPT/Claude chat.)

### 5. Markdown / code rendering — **8/10** (gap 2)
Full markdown, fenced code with copy, JSON-as-code, streaming caret. Solid. **Gap to 10:** no
runnable/editable code (artifact-grade), no diagrams/mermaid, no confirmed LaTeX rendering.

### 6. Model selection — **7/10** (gap 3)
Arguably **ahead** of the big 3 on substance: multi-provider, BYOK, 5 routing strategies,
auto-route, plus a models catalog with "Use this model → chat". **Gap to 10:** model handoff from
catalog is indirect (localStorage), there's no in-composer all-models dropdown, and the
provider picker is still provider-default-keyed in the composer itself.

### 7. Memory / projects — **5/10** (gap 5)
Both exist and are honest, but basic: memory is a manual on-device string list (no
auto-extraction, no management UI in chat), projects carry instructions+routing but **no file
knowledge**, and everything is local-only unless signed in. Competitors offer automatic memory,
editable summaries, and file-backed project/notebook context. Gap to 10: auto-memory + editable
memory viewer, file-backed projects, cross-device sync.

### ★ Transparency / savings — **10/10** (the one genuine 10)
Route-reason ("why this provider/model"), per-response saved-$, privacy-honored badge, and a
full expandable trace. **No competitor surfaces any of this.** This is where Zintus's chat is
unambiguously best-in-class and should be the headline of the experience.

---

## Where Zintus's chat is genuinely 10/10 vs 🟡 vs missing

- **Genuine 10/10:** route-reason + compression-savings + privacy transparency surfacing; honest
  multimodal image handling (EXIF strip, fail-closed, "analyzed by X").
- **🟡 (real but not parity):** chat polish/calm (no canvas), tools (built-in only), markdown
  (no artifacts), model selection (indirect catalog handoff), memory/projects (manual/no files).
- **❌ Missing entirely:** voice input/mode; PDF/document parsing; artifacts/canvas side panel;
  reachable structured-output request UI; user-defined tools / connectors / MCP in chat; image
  generation; auto-memory + file-backed projects.

## Verdict: chat-experience **6.5/10** vs ChatGPT/Claude/Gemini
Zintus's chat is calm, honest, and uniquely transparent (route-reason + savings — a real 10),
with solid multi-provider routing, real cross-surface image input, and clean markdown. It loses
to the mature assistants on breadth: zero voice, text-only files, no artifacts/canvas, an
unreachable structured-output capability, and shallow memory/projects. The transparency moat is
the thing to lead with; voice + files + artifacts are the path to a 10.

---

Sources:
- [MindStudio — ChatGPT vs Claude 2026](https://www.mindstudio.ai/blog/chatgpt-vs-claude-2026-comparison)
- [MindStudio — Gemini Notebooks vs Claude Projects vs ChatGPT Memory](https://www.mindstudio.ai/blog/gemini-notebooks-vs-claude-projects-vs-chatgpt-memory)
- [Unmarkdown — Claude Artifacts vs ChatGPT Canvas vs Gemini Gems](https://unmarkdown.com/blog/claude-artifacts-vs-chatgpt-canvas)
- [Suprmind — Claude Features 2026 (Projects, Artifacts, Memory, MCP, Skills)](https://suprmind.ai/hub/claude/features/)
- [Anthropic — What are Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Eigent — Claude Live Artifacts Guide 2026](https://www.eigent.ai/blog/claude-live-artifacts-guide)
- [OpenAI — ChatGPT Release Notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Releasebot — ChatGPT Updates June 2026](https://releasebot.io/updates/openai/chatgpt)
- [Memeburn — ChatGPT Bidi-1 bidirectional voice](https://memeburn.com/openais-chatgpt-bidi-1-brings-bidirectional-voice-mode/)
- [airtypes — Voice Prompting for ChatGPT, Claude & Gemini 2026](https://airtypes.com/blog/voice-prompting-chatgpt-claude-gemini-guide)
- [DigitalOcean — ChatGPT vs Gemini 2026](https://www.digitalocean.com/resources/articles/gemini-vs-chatgpt)
- Zintus code: `apps/web/app/(app)/chat/page.tsx`, `app/_components/MessageBubble.tsx`, `apps/cli/src/index.ts`, `apps/desktop/app/_components/ChatPanel.tsx`, `packages/engine/src/engine.ts`
