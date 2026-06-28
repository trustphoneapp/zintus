# Zintus 10/10 initiative — OpenRouter-grade router + MCP + cross-platform parity

Makes Zintus a credible, honest, OpenRouter-grade **local-first AI router** with a moat
no competitor has, takes the verified product score from **~6.5 → ~7.5/10**, and adds
**MCP** (the Claude-Desktop/Cursor flagship) on top of multi-provider routing.

121 commits. Suite green (0 failures); typecheck clean across web/desktop/mobile.
No `main` changes. Payments stay non-functional placeholders (no live Stripe);
core stays free; no key custody.

## What's in it

**OpenRouter-grade foundation (Phases 0–8 + path-to-10)**
- Per-model **catalog** (37 verified-routable models) → rich `/v1/models` + `/v1/pricing`.
- **Route-reason** on every response ("why this provider/model") — surfaced on **web · desktop · CLI · mobile**.
- Provider **cockpit** (status, why-unavailable, best-next-action) + a public `/catalog`.
- **`/v1/activity`** (durable 30-day sqlite store) + **`/v1/key`** developer endpoints.
- **BYOK priority + fallback keys** (local keychain, no custody; additive — single-key path byte-identical).
- **Structured output** + **tools** now span **web · desktop · CLI · mobile** ("one Zintus").
- **Voice** dictation (web), **PDF** input (CSP-safe), **artifacts/canvas** (web + desktop).
- **`zintus agent`** — a sandboxed coding agent loop (read/search + gated apply-edit; traversal/symlink-escape blocked, 26 security tests).
- **Deeper research** — cross-verification passes + structurally-bound citations.

**MCP (Model Context Protocol) — feature-complete end-to-end**
- `@zintus/mcp` client on the official SDK (stdio + SSE + Streamable HTTP).
- Gateway **hosts** MCP (registry + cache), `/v1/mcp/discover`, and a **server-side bounded tool loop** (browsers can't spawn stdio; keeps MCP traffic off the relay).
- Web **settings/mcp** UI (add/test/enable servers) + **chat integration** (tool calls/results stream into chat; "🔧 N tools active").
- The unique combination: **MCP tools + the best/cheapest model across 12 providers.**

**Honesty fixes (found by the competitor-debate / audits)**
- Killed fabricated `1,000,000` quota denominators (CLI + desktop → "limit unknown").
- Referral "paid monthly via Stripe" → "coming soon"; Hero `npm`→`bun` + version `0.2.0`.
- Catalog growth rejected every model it couldn't verify against provider docs.

## Verified scorecard (independent re-benchmark, code-checked)
Moat **10** · Transparency **10** · Honesty **9** · Consistency **8** (+3) ·
Chat **7.5** · Router **7** · Research ~7 · Agentic ~5–6 · **Overall ~7.5/10** — honestly *not* 10/10.
Full detail: `docs/audit/2026-06-28/ten-out-of-ten/` (VERDICT, FINAL-SCORECARD, RE-SCORE).

## Testing
~1,340 tests pass (0 fail) across 107 files; `bun run typecheck` clean. Every PR was
verified green before commit; the agent-loop sandbox + BYOK auth-retry path were
reviewed by hand.

## Not in scope — [HUMAN]/device/business (documented, never faked)
In-browser CSP verify (PDF + artifact iframe); live MCP/agent/research runs; mobile
**image + voice** (native modules) + Tauri native save dialog; EAS/signed native builds;
live billing + referral payouts; legal/store. Tracked in
`docs/audit/2026-06-28/ten-out-of-ten/PATH-TO-10.md` + `docs/RELEASE-HARDENING.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
