# Cross-Surface Launch Audit — 2026-06-26

A brutal global-launch-readiness war-room run on `feat/cross-surface-parity`:
6 parallel read-only audit agents + a human cross-check. Each agent challenged
the existing honesty docs, found what tests don't cover, benchmarked against
ChatGPT/Claude/Gemini/Perplexity/Cursor, and reported P0/P1/P2 with exact
`file:line`.

| File | Scope |
|---|---|
| [VERDICT.md](VERDICT.md) | Corrected 11-section synthesis + verdict + corrections log |
| [01-core-runtime.md](01-core-runtime.md) | engine, router, providers, tokzen, memory, cache, schemas + multimodal/ledger |
| [02-gateway-relay-security.md](02-gateway-relay-security.md) | gateway + relay/validate-key threat model, no-custody proof |
| [03-web.md](03-web.md) | apps/web UX, honesty, a11y/SEO/headers, billing gate |
| [04-mobile.md](04-mobile.md) | iOS + Android (branch reality, ATS/cleartext, EAS blockers) |
| [05-desktop-cli.md](05-desktop-cli.md) | Tauri desktop (keyring, signing, menu) + CLI (npm safety, --json) |
| [06-compliance-ops-billing.md](06-compliance-ops-billing.md) | legal/store compliance, CI/Docker/backup/ops, billing-custody design |

**Bottom line:** not global-launch ready. Strong BYOK/local-first core; gated
paid/custody (correctly); blocked on desktop key flow, mobile branch + on-device
streaming, capability gaps (tools/multimodal/structured), Private-Mode honesty,
legal deployment, and relay backup/restore. Verdict was corrected after a human
cross-check (see VERDICT.md → "Corrections applied").

PR-1 (docs honesty truth-up) landed the same day, correcting ≥4 false ✅ in the
FEATURE-MATRIX and deleting the desktop x25519 fiction in STORE-READINESS.
