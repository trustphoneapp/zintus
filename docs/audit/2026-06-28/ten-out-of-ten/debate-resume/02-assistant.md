# 02 — Chat / Assistant Axis: Brutally-Honest 10/10 Verdict

**Agent 2 of 5. Lens: Zintus chat experience vs ChatGPT · Claude · Gemini.**
Branch `feat/zintus-10-10`. Method: read the ACTUAL code on every surface, ran the
relevant test suites. No ✅ without code + test + a real UI path. The prior audits
(`02-vs-assistants.md`, `FINAL-SCORECARD.md`) PREDATE the MCP / artifacts / voice /
PDF / structured-output work — those are re-verified fresh below.

## Score: **7 / 10** (chat axis vs the big-3)

Up from the audit's 6.5 because artifacts/canvas, server-side MCP, reachable
structured output, PDF input and voice dictation are all REAL and wired (verified,
tests green). Held well short of a literal 10 by: zero image generation, zero code
interpreter, voice that is dictation-only and web-only, artifacts that are a *viewer*
not an *iterative canvas*, shallow local-only memory/projects, and a mobile surface
with no multimodal at all.

---

## What's REAL (verified in code + tests)

| Capability | Surfaces | Evidence |
|---|---|---|
| Artifacts / canvas side panel | web ✅ · desktop ✅ | `apps/web/lib/artifacts.ts:159 extractArtifacts`; rendered `apps/web/app/(app)/chat/page.tsx:274,1130,1220`; sandboxed preview `apps/web/app/_components/ArtifactPanel.tsx:169-180` (`sandbox="allow-scripts"`, no `allow-same-origin`); desktop `apps/desktop/app/_components/ChatPanel.tsx:50,56` |
| MCP / connectors (server-side, real tool loop) | web ✅ · desktop ✅ · mobile ✅ | client config `apps/web/lib/mcp-config.ts:158 activeMcpServersForChat`; gateway HOSTS clients `apps/gateway/src/mcp-registry.ts`, executes `apps/gateway/src/mcp-bridge.ts:164 executeMcpToolCall`, bounded 8-round loop `apps/gateway/src/handler.ts:519,899-1028`; mobile `apps/mobile/lib/mcp-config.ts` + `apps/mobile/app/index.tsx:246,476` |
| Structured output (`json_object`) reachable from composer | web ✅ | toggle `chat/page.tsx:256,1130-area`; sent `:577 responseFormat`; `chat-client.ts:103,135` |
| PDF input (CSP-safe, on-device) | web ✅ | `apps/web/lib/extract-pdf.ts` (pdfjs, main-thread fake-worker, no eval/WASM); wired `chat/page.tsx:43,444-449` |
| Voice dictation (Web Speech) | web ✅ | `apps/web/lib/use-speech-recognition.ts`; `chat/page.tsx:949-958` |
| Image input | web ✅ · desktop ✅ · CLI ✅ | `chat/page.tsx:399` (`@zintus/media`); desktop `ChatPanel.tsx:14,72`; CLI `--image` |
| Streaming/regenerate/stop/markdown/code/route-reason | all | per prior audit, still intact |

Tests: `bun test` over artifacts/mcp-config/extract-pdf/use-speech-recognition/
image-attachments = **57 pass / 0 fail**. MCP server-side loop has its own
`mcp-bridge.test.ts` / `mcp-registry` coverage.

---

## Where the claims DON'T hold up (brutal)

1. **Artifacts is a viewer, not Claude's iterative canvas.** `extractArtifacts`
   only *classifies and slices the model's own text* (`artifacts.ts:10-12`). There is
   **no edit-this-artifact round-trip**, no "revise the artifact" re-prompt, no version
   history, no live state. You can open/preview/download — you cannot iterate. That is
   the core of Canvas/Artifacts and it's absent.

2. **Voice is dictation-only AND web-only.** No `SpeechRecognition` in desktop src
   (`apps/desktop/app` / `apps/desktop/lib` = 0 hits), none on mobile, nothing
   bidirectional. ChatGPT Advanced/Bidi voice and Gemini Live are real-time audio;
   Zintus has speech-to-text in one browser. Axis-low.

3. **Mobile has NO multimodal.** `apps/mobile` has zero image-picker / `@zintus/media`
   (grep = 0), no voice, no PDF, no artifacts. Mobile chat = text + MCP + tools +
   route-reason only. The surface where consumers actually live is the weakest.

4. **Desktop parity gaps:** image + artifacts + MCP yes; **PDF and voice NOT wired**
   (no `extractPdf`/`SpeechRecognition` in desktop src). Codeable — the libs exist on web.

5. **Structured output is shallow:** only a `json_object` boolean. **No `json_schema`
   editor** anywhere in the composer (`grep json_schema` in chat page / chat-client = 0),
   no schema-validated rendering. The catalog advertises `json_schema`; chat can't request it.

6. **Memory/projects are manual + local-only.** `memory.ts` = a localStorage string
   list injected as a system message; `projects.ts` = localStorage workspaces, no file
   knowledge. No auto-extraction, no editable memory viewer, no file-backed projects,
   no cross-device sync. Far behind ChatGPT auto-memory / Claude Projects / Gemini Notebooks.

7. **No image generation, no code interpreter anywhere** (grep across app/lib/engine =
   0). These are now table-stakes for ChatGPT/Gemini. Zintus's "tools" are still
   calc/datetime/random built-ins + web search + user MCP.

8. **No inline message editing, no branch/fork threads** (`grep editMessage|branch|fork`
   in chat page = 0). Big-3 all let you edit a turn and re-run a branch.

---

## What the big 3 ship that Zintus still lacks
Image generation/editing · code interpreter/sandbox execution · advanced/bidirectional
voice · automatic + editable memory · file-backed projects/notebooks · iterative
artifacts (edit + versions) · native mobile image+voice · inline edit / branch threads.

## Where Zintus is genuinely ahead (but off-axis)
Route-reason + per-response savings + privacy-honored transparency is a real 10 — but
that's Agent-1/transparency territory, not the assistant-parity axis I'm scoring.

---

## Top 3 CODEABLE gaps (ranked by 10/10 leverage)

1. **Make artifacts iterative (edit → revise → version).** The panel exists on web +
   desktop; add an "Edit / Revise" affordance that re-sends the artifact as context with
   a revise instruction and keeps a version stack. Converts a viewer into a real Canvas —
   the single biggest perceived-parity jump for the least new infra.

2. **Cross-surface multimodal wiring:** desktop PDF + desktop voice dictation (both libs
   already on web — pure wiring into `ChatPanel.tsx`), and mobile image input via
   `expo-image-picker` → existing `@zintus/media` path. Closes the most visible
   "it's missing on my device" holes. (Native mic/camera permission + EAS build = [HUMAN].)

3. **Structured-output depth + (stretch) image-gen routing.** Add a `json_schema` editor
   in the composer so the advertised capability is fully reachable, plus a table/tree
   render of JSON answers. Higher-leverage-but-heavier sibling: route to an image-capable
   model in the catalog and render the returned image (closes the #1 competitive feature
   gap; gated by a provider/BYOK image model).

---

## [HUMAN] launch gates on the chat axis (do not ignore)

- **Mobile native image + voice** — requires `expo-image-picker`/camera permissions,
  native mic, EAS/signed build, and on-device testing. Cannot be claimed from code.
- **Live LLM end-to-end run with a real key** — artifacts, MCP tool loop, structured
  output and route-reason are code-verified but their *answer quality* is unverified;
  no-custody means this needs a user key on a real browser/device.
- **CSP / real-browser verification** — sandboxed-iframe artifact preview, pdfjs
  main-thread extraction, and Web Speech dictation are proven by unit tests + code
  reasoning only; confirm in a deployed browser with the production CSP.
- **Advanced/bidirectional voice** — real-time device audio streaming; beyond dictation,
  needs audio infra + device.
- **App-store / permission review** for mobile mic + camera.

---

*Verdict: chat axis = 7/10. Real, honest, and meaningfully improved (artifacts, MCP,
PDF, structured, dictation), but a literal 10 needs iterative artifacts, image-gen,
code-interpreter, real voice, deep memory, and — above all — a mobile surface that can
actually see and hear.*
