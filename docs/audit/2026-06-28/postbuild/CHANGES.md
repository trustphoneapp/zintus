# Post-audit changes — 2026-06-28

Short, caveated summary of what was built/changed **after** the 2026-06-28 audit
snapshot. Claims here are deliberately narrow — see the linked review files for the
open items each one carries.

## Built post-audit (capabilities)

- **Tool / function calling** — Web + CLI + gateway (BYOK). Provider streaming
  (`packages/providers/src/utils.ts`), Gemini `functionResponse` round-trip, and
  gateway 422-on-unsupported are tested. **No desktop/mobile tool UI** — the
  gateway and CLI serve tools, but no desktop/mobile surface exposes them.
- **Structured / JSON output** — Web + CLI + gateway (BYOK). Engine validate→repair
  and gateway strict-422 are tested. Conservative capability table (only Gemini is
  `json_schema`). Open honesty items remain in `06-review-structured-output.md`
  (e.g. `guaranteed`/`served_level` over-claim) — owned by the engine agent, not
  this change.
- **Multimodal image (vision)** — proven on web + CLI, and now **maps to OpenRouter
  vision models**. **Desktop/mobile image UI is still absent (❌).** Note the vision
  fan-out RISK in `01-core-runtime.md` (§1) — owned by the factory/engine agent.
- **CSP nonce** — relanded in `apps/web/proxy.ts` (per-request nonce, Report-Only
  toggle, dev-only `'unsafe-eval'`).

## Hardening fixes applied in this change (file:line)

1. **Ajv `validatorCache` bounded** — `packages/schemas/src/index.ts` (~237). Added a
   200-entry cap with oldest-entry eviction; failed-compile memoization preserved.
   Addresses the unbounded-cache RISK in `06-review-structured-output.md`.
2. **CSP `'unsafe-eval'` fail-closed** — `apps/web/proxy.ts:22`. `IS_DEV` is now
   `NODE_ENV === "development"` (was `!== "production"`), so `'unsafe-eval'` can only
   appear under an explicit dev build. Production path unaffected. Per
   `08-review-csp.md` §1 RISK.
3. **Router redactor drift fixed** — `packages/router/src/redact.ts`. Ported the
   relay redactor's JWT + named-token + OAuth `code`/`state` rules and added
   UUID-shaped-token redaction; tests added in `redact.test.ts`. Per
   `01-core-runtime.md` §5.
4. **CLI `loadTools` hardening** — `apps/cli/src/commands/chat.ts`. `parameters` must
   now be a plain object (rejects `null` and arrays).
5. **Web SSE tool-call accumulation tested** — extracted pure
   `accumulateToolCallDeltas` / `finalizeToolCalls` helpers in
   `apps/web/lib/gateway.ts`, unit-tested in `apps/web/lib/gateway.test.ts` and wired
   into the suite. Closes the gap flagged in `11-coverage-honesty.md`.

## Test status

971 tests were green before this change. The targeted suites for the files touched
here pass (`packages/schemas/src`, `packages/router/src/redact.test.ts`,
`apps/cli/src/commands/chat-content.test.ts`, `apps/web/lib/gateway.test.ts`) and
`@zintus/web` typecheck is clean. New tests added: router redact JWT/UUID/named-token
(3) + web SSE reassembly (5).

## Open items — explicitly NOT claimed done

- **CSP is NOT browser-verified.** The in-browser check against
  `next build && next start` (nonce stamping, single CSP header, no
  `script-src` violations) is the remaining **[HUMAN]** step — see `08-review-csp.md`
  §60-62. Do not mark CSP "done/verified".
- **Desktop/mobile image UI and desktop/mobile tool UI do not exist.**
- Structured-output and vision-fan-out honesty items in
  `06-review-structured-output.md` / `01-core-runtime.md` are owned by other agents
  (engine, factory, providers) and are **not** addressed by this change.
