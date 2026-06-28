# Zintus 10/10 — Honest RE-SCORE of the moved axes (2026-06-28)

*Scope: re-score ONLY the three axes that should have moved since `VERDICT.md`
(branch `feat/zintus-10-10`). Every claimed improvement was VERIFIED IN CODE, not
trusted from commit messages. Read-only pass — no source edits.*

## Verification results (claim-by-claim)

### A1 — Web structured-output toggle — ✅ REAL, end-to-end
- `apps/web/app/(app)/chat/page.tsx:216` persisted `jsonEnabled` toggle (localStorage),
  rendered as a `{}` JSON button (`:1149`), passed as
  `responseFormat: jsonEnabled ? { type: "json_object" } : undefined` to `streamChat` (`:448`).
- `apps/web/lib/chat-client.ts:125` forwards `responseFormat` → `apps/web/lib/gateway.ts:736`
  puts `response_format: params.responseFormat` **into the request body**.
- Gateway consumes it: `apps/gateway/src/handler.ts:1073` (`responseFormat: body.response_format`),
  with strict-schema handling at `:918`/`:1248`. Desktop had it first (`apps/desktop/lib/chat-client` parity).
- Verdict: the web↔desktop inversion is genuinely closed; the catalog "JSON" chip is now reachable.

### A2 — Route-reason on CLI + desktop, quota fabrication removed — ✅ REAL
- Desktop: `apps/desktop/lib/gateway.ts:522` parses `route_reason` → `meta.routeReason`;
  `apps/desktop/app/_components/MessageBubble.tsx:209-226` renders the "why this provider/model" headline.
- CLI: `apps/cli/src/commands/chat-content.ts` `formatTurnSummary` emits provider·model, `why:`,
  tokens in/out, cost (`$0 (free tier)` not a fake charge), and quota — wired into
  `apps/cli/src/commands/chat.ts:233` (`routeReason: result.routeReason`). Not dead code.
- **Fabricated 1,000,000 quota is GONE** from both: CLI `router.ts:37` uses `quotaLimit: status.tokensLimit ?? null`
  (comment at `:13` explicitly cites removing the `1_000_000` placeholder); desktop `providers.ts:11`/`:47`
  `quotaLimit: number | null` → `QuotaBar.tsx:39/72` renders **"limit unknown"** when null.
  The remaining `1_000_000` hits in catalog/pricing/limits are real context-windows / per-1M pricing /
  published per-provider free-tier ceilings — NOT a fabricated universal denominator.
- Mobile note: mobile `QuotaBar` uses real published `PROVIDER_LIMITS` (`@zintus/router/limits`), also honest.

### B3 — Durable activity store — ✅ REAL
- `apps/gateway/src/activity-store.ts` — bun:sqlite, WAL, owner-only `0600`, 30-day prune, idempotent
  `recordActivity` (ON CONFLICT upsert), `listActivity` with filters.
- `GET /v1/activity` reads the store FIRST (`handler.ts:1945-1963`) and **falls through** to the
  in-memory trace ring on empty/error (`:1973-1987`) — honest `has_more`, `retention_days` surfaced.
- Write hook fires at turn completion: `recordTurnActivity` called at `:1264` and `:1485`
  (streaming + non-streaming paths); best-effort, swallows errors, honest nulls + `cost 0` free-core.

### C1 — Voice input — ✅ REAL, honest
- `apps/web/lib/use-speech-recognition.ts` — `window.SpeechRecognition ?? webkitSpeechRecognition`,
  returns `{ supported, listening, transcript, error, ... }`.
- Mic button gated on `speech.supported` (`page.tsx:1363`); unsupported browsers get a **disabled**
  button + "needs a Chromium-based browser" tooltip (`:1382`) — not a broken control.
- Honest privacy disclosure: tooltip states "Chrome sends audio to Google; no audio reaches Zintus"
  (`:1368`). Audio never touches the gateway (composer dictation only).

### B1 — Catalog breadth — ✅ REAL (37, not ~37 inflated)
- `packages/providers/src/catalog.ts` — **37 model entries** (`{ id:` count). Prior verdict: 23 routable.
- `catalog.test.ts:63-66` enforces `vision`/`tools`/`structuredOutput` MIRROR `capabilities.ts` for
  every entry; `:90` enforces a positive list price equals the catalog source (null/0 = unverified,
  no fabrication); `:141` requires every priced pair to appear in the catalog. Honesty holds.

**No claimed improvement FAILED verification.** All five are real and wired end-to-end.

## RE-SCORE (vs prior verdict)

| Axis | Prior | New | One-line justification |
|---|:--:|:--:|---|
| **Cross-platform consistency** | 5/10 | **7/10** | Route-reason now web+desktop+CLI; structured web+desktop+CLI+gateway; quota honest on all four surfaces — but mobile has none of the three flagships (no route_reason / response_format / SpeechRecognition found in `apps/mobile`). 3 of 4 surfaces parity; **mobile is the sole remaining drag.** |
| **Chat experience vs assistants** | 6.5/10 | **7.5/10** | +reachable structured-request UI on web (end-to-end to gateway), +voice dictation (honest privacy + unsupported handling). Still text-only files, **no artifacts/canvas**, no agentic apply. |
| **Router / marketplace vs OpenRouter** | 6/10 | **7/10** | +durable sqlite activity (read-first, fallback, 30-day, write hook) replaces in-memory; +catalog 23→37 routable. Still **37 vs 400+**; no BYOK priority/fallback keys; no live latency/throughput/uptime stats. |

## What STILL blocks 10/10
1. **Mobile parity** — the serious app lacks route-reason, structured toggle, and voice (the [HUMAN] rebase track). Single biggest consistency blocker.
2. **BYOK priority + fallback keys** — OpenRouter parity; not present.
3. **Files / artifacts / canvas** — chat is text + image only; no PDF/file ingestion, no artifacts pane.
4. **Agentic loop + apply-diff** — CLI `--tools` still prints, doesn't execute against Cursor.
5. **Research depth** — single-pass; no multi-pass cross-verify / structurally-bound citations.
6. **Catalog breadth** — 37 routable « 400+; no live latency/throughput/uptime marketplace stats.

## Bottom line
Three honest movers: **consistency 5→7, chat-experience 6.5→7.5, router 6→7.** All
verified in code; nothing failed. The moat (10) and route-reason transparency (10)
are unchanged. Mobile parity is now the clearest, most-leveraged remaining gap.
