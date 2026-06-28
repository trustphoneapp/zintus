# Cross-Surface Launch Re-Audit — 2026-06-28

A post-fix re-run of the [2026-06-26](../2026-06-26/) war-room against current
`main` (`6bcd097`): **12 parallel agents** — 6 independent re-verifications of the
original scopes (read-only on source, each classifying every prior P0/P1/P2 as
FIXED / STILL-OPEN / REGRESSED / NEW with `file:line`) + 6 forward designs for the
unbuilt capabilities — plus an orchestrator cross-check that re-read the disputed
files rather than trusting any single agent.

| File | Scope |
|---|---|
| [VERDICT.md](VERDICT.md) | Cross-checked 11-section synthesis + verdict + corrections log |
| **Re-verification** | |
| [01-core-runtime.md](01-core-runtime.md) | engine, router, providers, media/multimodal, memory, cache, schemas, ledger |
| [02-gateway-relay-security.md](02-gateway-relay-security.md) | gateway + relay no-custody proof, managed-keys gate, backup/restore |
| [03-web.md](03-web.md) | apps/web UX, markdown, image UI, a11y, billing gate, honesty |
| [04-mobile.md](04-mobile.md) | iOS + Android branch reality (80/7), streaming, cleartext, EAS |
| [05-desktop-cli.md](05-desktop-cli.md) | Tauri keyring (code-fixed), signing, menu + CLI npm/`--image`/cloud |
| [06-compliance-ops-billing.md](06-compliance-ops-billing.md) | legal/store, Stripe, ops/DR, doc honesty |
| **Forward design** | |
| [07-design-tool-calling.md](07-design-tool-calling.md) | tool/function calling — 9-PR plan (headline gap) |
| [08-design-structured-output.md](08-design-structured-output.md) | structured/JSON output — 6-PR plan, 3-state capability |
| [09-design-csp-nonce.md](09-design-csp-nonce.md) | CSP nonce reland — webpack-dev root cause + staged rollout |
| [10-design-desktop-cert.md](10-design-desktop-cert.md) | desktop per-OS runtime-cert + signing; keyring cross-lib risk |
| [11-design-mobile.md](11-design-mobile.md) | mobile rebase + `expo/fetch` streaming + cleartext + EAS, 7 PRs |
| [12-design-multimodal-polish.md](12-design-multimodal-polish.md) | latest-image-focus, cross-surface image UI, provider coverage |

**Ground truth:** `bun run test` exit 0, **0 failures**, ~919 pass.

**Bottom line:** still **not** 10/10 global-launch ready — but the codeable
P0/P1/P2 batch genuinely landed and survived independent re-verification. No-custody
is now proven against code; multimodal is real (was "vapor"); Private-Mode honesty
is typed and tested. The remaining gaps are **capability** (tool calling + structured
output absent) and **distribution** (desktop/mobile need real device builds; legal +
signing + stores are `[HUMAN]`) — not bugs or dishonest docs. Web (BYOK) + CLI are a
credible **beta+**; desktop, mobile, stores, and paid/custody stay correctly gated.
See VERDICT.md → "Corrections applied" for the 8 places this run corrected the
founding summary (mobile is 80/7 not ~47; redact drift is router-only; keyring
cross-lib risk; a false-*incomplete* doc drift; CSP root cause; etc.).
