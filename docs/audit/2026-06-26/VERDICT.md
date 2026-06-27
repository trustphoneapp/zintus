# Zintus Global-Launch War-Room — Verdict (2026-06-26)

*Branch `feat/cross-surface-parity`. 6 parallel audit agents + a human cross-check.
This is the **corrected** verdict — several claims in the first synthesis were
overstated and have been fixed here (see "Corrections applied").*

**Ground truth (verified, not doc-trusted):** `bun run typecheck` exit 0; full
`bun run test` exit 0, **0 failures** (743 pass by the runner's own aggregate;
exact total not asserted — capture from CI). Tokzen compression eval passes at 0%
accuracy delta.

Per-agent detail: `01-core-runtime.md` … `06-compliance-ops-billing.md`.

---

## 1. Verdict: global launch ready? **NO**

Not as a 10/10 multi-surface product. Readiness is highly uneven by surface, and
the project's own honesty contract had drifted false (now corrected by PR-1).

- **Strong, real, rare:** the BYOK/local-first core — engine, router, quota
  ledger, gateway security (~8.5/10; browser CSRF/denial-of-wallet genuinely
  closed, all bypass attempts 403'd), **proven no-custody** (zero `decrypt`/
  `x25519` hits in relay; managed-keys server-gated with a 503 *before* Stripe;
  no money-movement code exists).
- **Sinks a launch:** desktop BYOK key entry is broken; mobile's real app isn't on
  this branch and its on-device streaming is likely broken; three table-stakes
  capabilities (tool calling, multimodal, structured output) are entirely absent;
  Private Mode silently leaks to "unknown"-training providers; legal pages are
  DRAFT and undeployed; no relay backup/restore exists.

**Honest path:** Web (BYOK) + CLI on the local path are the only surfaces near a
credible *beta* — after the Private-Mode honesty fix and the markdown/favicon
polish. Desktop, mobile, stores, paid, and cloud are gated.

## 2. 10/10 definition
Same flow on every surface (UI → local gateway → chosen provider) with no dead
buttons / fake renders / silent degradation; capability-honest routing (real
model→{vision,tools,json,context} registry; hard-error, never silent downgrade);
literal-truth privacy (Private Mode honored or labeled "not honored — used X");
competitive capabilities (tools+MCP, multimodal, structured outputs, cited
research); trustworthy distribution (signed/notarized desktop, store-submittable
mobile, live legal pages, backed-up + restore-drilled cloud); docs true to the line.

## 3. Competitor benchmark
Zintus uniquely owns **multi-provider routing/failover**, **BYOK/local-first
no-custody**, and a **provable cost-savings ledger** — none of ChatGPT / Claude /
Gemini / Perplexity / Cursor offer these. It loses on every *capability* axis
(tool calling, multimodal, structured output, agentic coding) and every *polish*
axis (self-contained desktop/mobile apps, store presence, rich markdown).

## 4. Feature matrix (honest)
See the corrected `docs/FEATURE-MATRIX.md` (PR-1). Headlines: web markdown ⚠️
(fake), desktop provider-key entry ⚠️ (broken), tool/multimodal/structured ❌
stack-wide, mobile column = `feat/mobile-serious-app` (not this branch).

## 5. P0 — launch blockers
1. **Desktop key entry broken** — `lib/tauri.ts` calls the uninitialized
   `tauri-plugin-keyring-api` plugin; the shipped Rust `keyring_*` commands
   (`lib.rs:11-34`, in the invoke handler) are never called; plus no key→gateway
   sync (service `com.zintus.desktop` ≠ gateway `zintus`). Desktop not standalone.
2. **Mobile not shippable on this branch** — basic-only here; on-device streaming
   likely broken (no RN `ReadableStream` polyfill, `lib/chat.ts:74`); Android
   cleartext unset; no consent gate. Rich app is on `feat/mobile-serious-app`.
3. **Private Mode silent leak** — `"unknown"`-training providers not filtered
   (`providers/data-policies.ts:131`) + best-effort keeps training providers
   (`router/factory.ts:461`), with no "not honored" signal.
4. **Legal DRAFT + undeployed** + no AI-output report control on web/mobile
   (`web/app/privacy/page.tsx:24`, `terms/page.tsx:24`).
5. **No relay backup/restore** for D1 + KV (no export/rehearsal anywhere).
6. **Desktop unsigned (all OS); Windows cannot sign** (`signCommand` absent);
   macOS un-notarized. [HUMAN]
7. **(Resolved by PR-1)** Doc/contract honesty drift — ≥4 false ✅ + the desktop
   x25519 fiction. Fixed in FEATURE-MATRIX / STORE-READINESS / RELEASE-CHECKLIST.

## 6. P1 — serious
No tool/function calling; no multimodal; no structured/JSON output; brand-rank
"capability" routing (`priority.ts:4`) not model-capability. Web fake markdown +
no code-copy + missing favicon/manifest + no stop in Compare/Research. Gateway
LAN-IP-without-token not refused (`auth.ts:180`); account-delete doesn't
force-disconnect live gateway sessions; validate-key path puts plaintext keys on
operator infra (was matrix-omitted). Memory default "semantic" = keyword hash
(`embeddings.ts:26`) + wrong-fact extraction (`extract.ts:25`). CLI Bun-only;
`cloud status/logout` misreport. Desktop no native menu + fake Find + unverified
export. Ops: no incident/rollback runbook; `build-apps` CI is main-only.

## 7. P2 — polish
tokzen ratio scoping; failed-request debits request budget; OTel synthetic span
offsets; Stripe non-constant-time + no event-id dedup; un-redacted client errors;
CSP `unsafe-inline` + headers only in `vercel.json`; bundle-baked
`NEXT_PUBLIC_GATEWAY_TOKEN`; a11y focus rings + consent-dialog trap; inert desktop
updater; referral "Earned $X" shown while gated; `redact.ts` misses UUID tokens;
TPM over-reserve at fixed 1024 output (`factory.ts:149`).

## 8. Roadmap by PR (codeable order, per owner's directive)
1. ✅ **PR-1 honesty truth-up** (this commit's predecessor).
2. **Private-Mode honesty** — filter `"unknown"`-training + `privacyHonored` signal.
3. **Relay backup/restore** — D1/KV export workflow + restore-drill doc.
4. **Gateway LAN exposure** — refuse non-loopback host without token.
5. **Web markdown** — real renderer + per-code-block copy + favicon/manifest.
6. **Capability registry** — `providers/capabilities.ts` + wire routing.
7. **Account deletion** — force-disconnect gateway sessions + KV cleanup.
8. **Desktop keyring** — repoint frontend to `invoke("keyring_*")` (needs Rust build).
9. **Mobile** — branch decision + streaming polyfill + cleartext + consent.
10. **Desktop signing** — certs + `signCommand` + notarize. [HUMAN]
11. **Capabilities** — tool calling + multimodal + structured output (multi-PR).

## 9. Tests / builds / device checks
Live-provider smoke (one real key per path); desktop Rust build per OS (keyring,
PTY, export, native menu, Tauri-origin/PNA, Gatekeeper/SmartScreen); mobile EAS
**release** build (Android cleartext, on-device streaming, deep-link, iPad);
Playwright web flows; [HUMAN] Chrome PNA + Tauri non-null Origin.

## 10. Human-only blockers
Counsel (finalize+deploy privacy/terms; `ITSAppUsesNonExemptEncryption`;
provider-ToS/custody review); Apple/Play/npm accounts + Developer ID + Authenticode
certs; deploy legal+deletion pages; domain/DNS; demo gateway for review; confirm
GitHub branch-protection; **keep `MANAGED_KEYS_AVAILABLE=false`** until an audited
custody+ledger plane ships; Xcode + a Rust build to certify desktop.

## 11. Final launch gate
typecheck+suite green (+ new tests per fix); matrix true-to-the-line; every
downloadable surface works standalone (no dead/fake); Private Mode literally
honest; legal finalized+live + AI-report wired; relay backed up with a rehearsed
restore + incident runbook; desktop signed+notarized clean-machine; mobile
store-submittable; paid/custody stays gated; capability requests hard-error never
silently downgrade.

---

## Corrections applied (vs the first synthesis)
1. Desktop keyring: the Rust backend **exists** (`lib.rs:11-34`); the bug is the
   frontend calling the wrong (uninitialized-plugin) path — *not* "no backend."
2. Icons: **multi-resolution but placeholder-grade** (`.ico` 6 sizes ~2 KB,
   `.icns` ~12.6 KB) — not "fake," and not the stale "299 B/321 B stubs."
3. Web project `strategy`: the apply-path works; the **web form exposes no
   strategy control** (always `null`) — not a fully "dead field."
4. `docs/multimodal-image-plan.md`: absent here but **exists on
   `feat/mobile-serious-app`** — branch drift, not vapor.
5. Test count stated as **0 failures** (not an asserted "~740+"/"768").
6. The first synthesis's "scratchpad/agent-*.md" pointer was session-temp, not
   repo-relative; the reports are persisted **here** instead.
