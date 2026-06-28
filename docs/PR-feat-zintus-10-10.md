# feat: Zintus 10/10 — MCP, tool calling, artifacts, cross-platform parity

A production-grade, local-first AI router. 126 commits. Suite green (0 failures);
typecheck clean across web/desktop/mobile. No `main` changes. Payments are
non-functional placeholders (no live Stripe); core stays free; no key custody.

## What shipped

**Router + foundation**
- Per-model catalog (37 verified-routable models) → `/v1/models` + `/v1/pricing`.
- Route-reason on every response (which provider/model and why) — web, desktop, CLI, mobile.
- Provider cockpit (status, why-unavailable, next action) + a public `/catalog`.
- `/v1/activity` (durable 30-day sqlite store) + `/v1/key` developer endpoints.
- BYOK priority + fallback keys (local keychain, no custody; additive — single-key path unchanged).
- Structured output + tools across web, desktop, CLI, mobile.
- Voice dictation (web), PDF input (CSP-safe), artifacts/canvas (web + desktop).
- `zintus agent` — a sandboxed coding agent (read/search + gated apply-edit; traversal and symlink-escape blocked; 26 security tests).
- Deeper research — cross-verification passes + structurally-bound citations.

**MCP (Model Context Protocol)**
- `@zintus/mcp` client on the official SDK (stdio + SSE + Streamable HTTP).
- Gateway hosts MCP (registry + cache), `/v1/mcp/discover`, and a server-side bounded tool loop. MCP traffic stays off the relay.
- All four surfaces (web, desktop, CLI, mobile) configure servers + use them in chat. Type-only import on web/desktop/mobile, so no SDK enters those bundles.
- `zintus agent` + MCP: the agent hosts MCP directly (Bun) and runs file tools + any MCP tool in one loop.
- MCP tools combined with model routing across your configured providers.

**Honesty fixes**
- Removed fabricated `1,000,000` quota denominators (CLI + desktop now show "limit unknown").
- Referral payout → "coming soon"; Hero install `npm` → `bun` + version `0.2.0`.
- Catalog growth dropped every model not verifiable against provider docs.

## Verified
~1,400 tests pass (0 fail) across 112 files; typecheck clean. Self-assessed score
~7.5/10 — not 10/10. Detail in `docs/audit/2026-06-28/ten-out-of-ten/`.

## Not in scope — device / business / [HUMAN]
In-browser CSP verify (PDF + artifact iframe); live MCP/agent/research runs; mobile
image + voice (native modules); EAS/signed native builds; live billing + payouts;
legal/store. Tracked in `docs/audit/2026-06-28/ten-out-of-ten/PATH-TO-10.md` +
`docs/RELEASE-HARDENING.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
