# Zintus 10/10 — FINAL Re-Benchmark Scorecard (2026-06-28)

*Capstone of the path-to-10 push. Branch `feat/zintus-10-10`. Every committed
improvement was **verified in code** (read-only) — not trusted from commit messages
or summaries — and the relevant test suites were re-run green. This supersedes
`RE-SCORE.md` by folding in the mobile-parity, BYOK-fallback, catalog-37, and
PDF-input work that RE-SCORE explicitly deferred.*

## Verdict: 10/10? **NO — honest overall ≈ 7.5/10.** Two axes are genuine 10s.

Zintus moved from a credible **beta+ (~6.5)** to a strong, unusually consistent and
honest **~7.5**. The moat and transparency remain uncopyable 10s. The remaining drag
is depth (agentic, research), breadth (37 « 400+ models), and a few mobile/table-stakes
gaps. **Nothing claimed FAILED verification — all 9 committed items are real and wired.**

---

## A. Claim-by-claim verification (cite file:line) — all ✅

### A1 — Web structured-output toggle — ✅ REAL, end-to-end
`chat/page.tsx:221` persisted `jsonEnabled` (localStorage `:229`), rendered as a JSON
toggle `:1192`, sent as `responseFormat: jsonEnabled ? { type:"json_object" } : undefined`
`:487` → `chat-client.ts:125` → `gateway.ts:736` (`response_format` in body) → gateway
handler. The web↔desktop inversion is closed; the catalog "JSON" chip is reachable.

### A2 — Route-reason on CLI + desktop + NO fabricated 1,000,000 quota — ✅ REAL
- Desktop: `gateway.ts:522-523` parses `route_reason`→`meta.routeReason`;
  `MessageBubble.tsx:209-226` renders the "why this provider/model" headline.
- CLI: `chat-content.ts:146 formatTurnSummary` emits `why:` `:155`, tokens, honest
  cost, and quota; wired in `chat.ts`. Quota line renders **"(limit unknown)"** when
  null `:112` — no fabricated denominator.
- **Fabrication grep (cli+desktop+mobile *source*) = clean.** The only `1_000_000`
  hits are `cli/serve.ts:49` (a `1.2M` number formatter) and a `router.ts:13`
  *comment* documenting the placeholder's removal. Tests assert no `"1000000"`
  (`chat-content.test.ts:189,235`).
- Mobile: `messages.ts:126` parses `route_reason`; renders at `index.tsx:471`.
- **Route-reason now spans web+desktop+CLI+mobile** (grep: 2 source files each).

### B1 — Catalog 23→37 — ✅ REAL (exactly 37 / 12 providers)
`catalog.ts` `SEEDS` = **37 entries** across **12 providers** (gemini×6, mistral×8,
cohere×5, groq×4, cerebras×3, openrouter×3, deepseek×2, fireworks×2, xai/hf/lmstudio/
ollama×1). `catalog.test.ts:63-67` asserts `vision/tools/structuredOutput` **mirror
`capabilities.ts`** for every entry; `:87` enforces price `null` or `>0` (no invented
prices); `:149` requires every priced pair to exist in the catalog. **17 pass / 1084
expects.** Flags mirror allowlists; prices null where unverified — confirmed.

### B2 — BYOK priority + fallback keys — ✅ REAL, additive, failover-safe
- Keychain: `storage.ts` `getKeys/setKeys` (`:225/:247`) store fallbacks in a sidecar
  `${providerId}::fallbacks` account `:12-13`; `setKey` clears the fallback tail so the
  single-key shape is unchanged `:199`.
- Router: `factory.ts:298 keysFor` returns the ordered list (per-request keys, then
  keychain primary+fallbacks). The walk at `:757-790` retries the **same provider+model
  on a PRE-stream 401/403 only** `:783`, else throws to the existing failover path
  **unchanged**. Comment + code confirm: *"With zero or one key the loop runs exactly
  once → behavior is identical to the single-key path"* (`attemptKeys = apiKeys.length>0
  ? apiKeys : [undefined]` `:757`). **Additive confirmed; failover tests 27 pass / 0 fail.**

### B3 — Durable sqlite activity store — ✅ REAL
`activity-store.ts` — `bun:sqlite` + WAL `:76`, 30-day prune-on-open `:78/101`,
`recordActivity`/`listActivity`. `/v1/activity` reads the store **first** `handler.ts:1945`,
falls through to the in-memory trace ring on empty/error `:1974`, surfaces honest
`has_more` + `retention_days` `:1960`. Write hook `recordTurnActivity` fires on both
streaming `:1264` and non-streaming `:1485` completion. **10 pass / 0 fail.**

### C1 — Web voice (dictation) — ✅ REAL, honest
`use-speech-recognition.ts` wraps `window.SpeechRecognition ?? webkitSpeechRecognition`;
wired in `chat/page.tsx:852` with mic toggle, error→calm notice `:860`, and a disabled
mic + tooltip on unsupported browsers `:1412`. Honest privacy disclosure (Chrome streams
audio to Google; nothing reaches Zintus). Dictation-only — not bidirectional voice.

### C2 — PDF input (CSP-safe) — ✅ REAL, wired into chat
`extract-pdf.ts` — pdfjs-dist v6, **no eval, no `new Worker()`** (registers
`globalThis.pdfjsWorker` to force main-thread "fake worker"), no WASM — CSP-safe by
construction; a scanned PDF yields an honest empty result, never fabricated text. Wired
in `chat/page.tsx:38,366`; the file `accept` includes `application/pdf` `:1363`.

### Mobile parity — ✅ route_reason + structured + tools all landed
`lib/messages.ts:126` (route_reason), `:156` (`response_format`); `lib/builtin-tools.ts:261
runBuiltinToolLoop` (verbatim port of the CLI loop); `app/index.tsx:30,175,471` (tools
import, jsonMode→responseFormat, route-reason render). **chat + builtin-tools tests: 14 pass.**

### CLI tools EXECUTE — ✅ (built-ins only)
`builtin-tools.ts:261 runBuiltinToolLoop` + `:192 executeBuiltinToolCall` actually run
the tools and feed results back (bounded rounds), called at `chat.ts:210`. **7 pass.**
**Caveat:** only 3 side-effect-free tools (calculator/current_datetime/random_number) —
**no file writes, no apply-diff** (grep for `writeFile`/`applyDiff` = 0). This closes the
"`--tools` prints, doesn't execute" ding but does **not** make it an agent.

### Honesty fixes (the two MUST-FIX from `04-consistency-honesty.md`) — ✅ both landed
- `pricing/page.tsx:459` now reads **"Payouts are coming soon"** (no "Paid out monthly
  via Stripe"); managed-key CTAs disabled "Checkout coming soon" `:322`.
- `Hero.tsx:9` `INSTALL_CMD = "bun install -g zintus"`; terminal shows `zintus@0.2.0` `:99`.

**Net: 9 of 9 claimed items verified real + complete. Zero failed verification.**
Built-in tools, structured output, and route-reason now genuinely span
**web + desktop + CLI + mobile.**

---

## B. FINAL re-score (vs the original `VERDICT.md`)

| Axis | Original | **Final** | Δ | One-line justification |
|---|:--:|:--:|:--:|---|
| **Moat** (Tokzen ledger / no-custody / cap-quota-privacy intel) | 10 | **10** | 0 | Unchanged; still uncopyable — no competitor has the triad |
| **Transparency / route-reason** | 10 | **10** | 0 | Hardened: the "why" headline now spans all 4 surfaces, not web-only |
| **Honesty discipline** | 9 | **9** | 0 | Both must-fixes landed + fabricated quota removed everywhere; held off 10 by the 43 unwired "Add your key" catalog rows (softened, not resolved) |
| **Router / marketplace** (vs OpenRouter) | 6 | **7** | +1 | +durable sqlite activity, +catalog 23→37, +**real BYOK priority/fallback** (was a "coming soon" stub). Still 37 « 400+, no live latency/throughput/uptime, no per-key introspection, BYOK fallback UI unpolished |
| **Chat experience** (vs ChatGPT/Claude/Gemini) | 6.5 | **7.5** | +1 | +reachable structured request, +voice **dictation**, +**real PDF text** (CSP-safe). Still no artifacts/canvas, no image-gen, no MCP/connectors, dictation≠bidirectional voice |
| **Research** (vs Perplexity) | 6 | **6** | 0 | No depth work landed: still single-pass 1/3/5, prompt-instructed `[n]` citations |
| **Agentic** (vs Cursor) | 3 | **4** | +1 | CLI `--tools` now EXECUTES — but only 3 safe built-ins; **no file edits / apply-diff / agent loop / IDE**. The chasm to Cursor is intact |
| **Cross-platform consistency** | 5 | **8** | +3 | route-reason + structured + tools + honest quota now uniform across web+desktop+CLI+mobile; mobile is no longer the lesser app. Held off 10 by mobile lacking **image input + voice**, and catalog/voice being web-only |

**Honest OVERALL: ≈ 7.5 / 10** (up from ~6.5). Two genuine 10s (moat, transparency);
one near-10 (honesty); a solid consistency 8; the rest 6–7.5; agentic the lone 4.

### Is Zintus 10/10 yet? **No.** What still blocks it:
1. **Agentic depth (4/10)** — no apply-diff / multi-file edits / agent loop / IDE. Widest gap.
2. **Research depth (6/10)** — single-pass, no cross-verify, citations prompt-instructed.
3. **Catalog breadth (router 7/10)** — 37 routable « OpenRouter 400+; no live provider stats.
4. **Chat table-stakes (7.5/10)** — no artifacts/canvas; voice is dictation-only; PDF text-only.
5. **Mobile last-mile (consistency 8/10)** — no image input, no voice, no catalog surface yet.

---

## C. Final remaining gaps to 10/10 — bucketed

### (a) Codeable-but-large (no device/cert/biz dependency)
- **Agentic apply-diff + agent loop** — file writes, coordinated multi-file edits,
  repo-navigation tools the model drives, run/verify feedback. (3→reframe-or-build.)
- **Research depth** — iterative multi-pass deepening, cross-verification/conflict
  flagging, structurally-bound (assign-during-assembly) citations, source ranking. (6→8.)
- **Catalog 37 « 400+** — many more verified-routable models; per-provider price spread;
  ideally measured latency/throughput/uptime feeding selection. (router 7→9.)
- **BYOK fallback UI polish** — the engine + keychain are real; the cockpit still needs a
  multi-key ordering editor + per-key validation to match OpenRouter's surface.
- **Artifacts/canvas + richer memory/projects** for chat parity (7.5→9).

### (b) Needs device / browser / live verification (cannot be settled in CI)
- **Mobile voice** native module + **mobile image input** on a real device.
- **CSP browser-verify** of the PDF + voice paths in the production CSP (eval/WASM/worker).
- **Expo/EAS device builds** for the serious mobile app; on-device streaming.
- **Signed/notarized native desktop builds.**

### (c) Business / [HUMAN]
- **Live billing** (managed-key checkout is correctly gated "coming soon" today).
- **Referral payouts** (`REFERRAL_PAYOUTS_LIVE=false`; "Payouts coming soon" is honest).
- **Legal / app-store** submission + review (mobile + desktop distribution).

---

## D. Bottom line
The path-to-10 push delivered exactly what it claimed: **9/9 items real, wired, and
test-green, with zero failed verifications.** The biggest mover is cross-platform
consistency (5→8) — route-reason, structured output, and built-in tools now span all
four surfaces, so Zintus finally reads as "one Zintus" at the ceiling, not just the
footer. Router (6→7), chat (6.5→7.5), and agentic (3→4) each moved one notch on real
features; research is unchanged. **Zintus is a strong, honest, uniquely transparent
~7.5/10 — not yet 10/10.** The remaining distance is depth (agentic/research), breadth
(catalog), and a device/business last mile — concrete, mostly codeable, and gated by the
moat that makes it a real category rather than a clone.
