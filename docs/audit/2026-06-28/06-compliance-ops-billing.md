# COMPLIANCE + OPS + BILLING — re-verification (2026-06-28)

Independent re-audit of the 2026-06-26 compliance/ops/billing report against the
**actual** code/config/docs at branch `feat/multimodal-image-input`, HEAD
`6bcd097`. Method: read the source, not the docs — every claim below carries a
commit + `file:line`. Trust-nothing classification:
**FIXED / STILL-OPEN / REGRESSED / NEW**. `[HUMAN]` = blocker that no code change
can close (counsel, certs, store accounts, deploying pages).

Headline: nearly every *codeable* compliance/ops/billing finding from 06-26 is
genuinely FIXED and verified. The residual launch blockers are now almost
entirely `[HUMAN]` (counsel-final legal pages + deployment, encryption export
sign-off, store accounts/certs). Billing/custody stays correctly gated.

---

## BILLING / CUSTODY — correctly gated, verified line-by-line

| 06-26 claim | Status | Evidence |
|---|---|---|
| `MANAGED_KEYS_AVAILABLE=false` | **HOLDS** | `workers/relay/src/tiers.ts:8`. `checkoutAvailability()` returns 503 `managed_keys_unavailable` for starter/growth/scale BEFORE any Stripe call (`tiers.ts:54-73`). Web mirrors: `apps/web/app/pricing/page.tsx` gate + `REFERRAL_PAYOUTS_LIVE=false`. |
| STRIPE_PRICES placeholders | **HOLDS** | `tiers.ts:26-30` all `price_FILL_FROM_STRIPE`; `isStripePriceConfigured()` → 2nd 503 `billing_not_configured`. `createCheckoutSession` also throws on placeholder (`billing.ts:11-13`). |
| No money-movement path | **HOLDS** | grep payout/transfer/Connect/withdraw across `workers/` = empty. `commission_cents` accrues (`billing.ts:252-260`) but nothing disburses; no referral row can even be created while checkout is gated. |
| **P2 — Stripe non-constant-time + no event-id dedup** | **FIXED** (`79dcbde`) | Read `workers/relay/src/billing.ts`. (1) `constantTimeEqual()` (`:125-132`) XOR-accumulates over all bytes, no early return; used in `verifyStripeSignature` (`:158`) instead of `===`. Length pre-check is on the *public* 64-hex HMAC length — safe. (2) Event-id dedup (`:207-211`): `KV.get(stripe_evt:<id>)` → ACK 200 on duplicate; records BEFORE processing; `catch` deletes the marker so a genuinely-failed delivery is retried (`:353-362`). Side effects are independently idempotent (`ON CONFLICT` / `INSERT OR IGNORE`). Replay window (`withinReplayWindow`, 300s) runs after sig, before parse/persist (`:187-189`). HMAC key correctly imported with `['sign']` usage (`:147-153`). Genuinely constant-time + genuinely deduped. |
| **P2 — referral "Earned $X" while gated** | **FIXED** (`bbd7a85`) | `apps/web/lib/billing.ts:42-48` `formatReferralEarned` returns `"Coming soon"` while `REFERRAL_PAYOUTS_LIVE=false` (`:34`), never a dollar figure that implies withdrawable money. |

**Custody verdict unchanged: keep gated.** No custodial system, provider ToS
forbid key reselling/proxying, custody is regulated. Safe v2 path (envelope-
encrypted per-tenant keys + double-entry ledger + Stripe Connect post-KYC +
reconciliation) remains future. `[HUMAN]`: do not flip `MANAGED_KEYS_AVAILABLE`
or go Stripe-live until an audited custody+ledger plane ships.

---

## OPS — backup/restore + rollback now exist and self-verify

| 06-26 finding | Status | Evidence |
|---|---|---|
| **P0 — no backup / no restore drill** | **FIXED** (`93e7105`) | `.github/workflows/backup-relay.yml`: daily 04:17 UTC + manual, exports D1 (`scripts/relay-backup.sh`) + KV dump, then **restore-drills** the fresh dump into scratch SQLite (`scripts/relay-restore-drill.sh`) so an unrestorable backup fails red, uploads 90-day artifact (`if-no-files-found: error`). Repo guard `trustphoneapp/zintus` matches the real `origin`. `[HUMAN]`: set `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets (job no-ops with a warning until then). |
| **P1 — no incident/rollback runbook** | **FIXED** (`93e7105`) | `docs/DR-RUNBOOK.md`: backup scope table (what is/isn't backed up + why), manual backup, monthly restore drill, **production restore** (D1 execute + KV bulk-put + health verify), **D1 Time-Travel** (≤30d PITR), and **`wrangler rollback`** procedure incl. the migration caveat. Proposed SLOs (99.9% / <1% err / p95<2s) + RPO≤24h / RTO minutes. |
| **P1 — `build-apps` CI main-only** (broken web build merges) | **FIXED** (`1d19d98`) | `.github/workflows/ci.yml:6,207-210`: `build-apps` (real `next build`) now runs on `pull_request` AND main; the `if: github.ref==main` gate is gone. |
| CI/Docker production-grade | **HOLDS** | gitleaks gating, docker-smoke non-root assert, k6 p95 gate — unchanged. |
| **P1 — no SLO alerts / status page** | **STILL-OPEN** `[HUMAN]` | DR-RUNBOOK *proposes* SLOs; alert wiring + status page remain `[HUMAN]` (DEPLOY.md). Not codeable without an external monitor/account. |

Net: the two 06-26 ops blockers (backup/restore P0, rollback P1) are closed and
the backup is self-checking, which is stronger than most launch bars.

---

## COMPLIANCE — code controls landed; legal deploy is the remaining `[HUMAN]` wall

| 06-26 finding | Status | Evidence |
|---|---|---|
| **P0(stores) — AI-output report control MISSING in code** | **FIXED** (web/desktop) (`8137fd9`) | `apps/web/app/_components/MessageBubble.tsx:48-59,195` — a "Report" control on assistant messages persists the flag on-device (`zintus:reported-responses.v1`). FEATURE-MATRIX #27 web ✅ is now honest. (Mobile report control is on `feat/mobile-serious-app`, not this branch.) |
| **P0 — legal pages DRAFT + undeployed** | **STILL-OPEN** `[HUMAN-counsel]` | `apps/web/app/privacy/page.tsx:24` and `terms/page.tsx:24` still render `lastUpdated="June 2026 (DRAFT)"` with literal `[TBD]` chips (terms venue `:175`, arbitration `:187`) and "DRAFT pending legal review". Unchanged — this is correctly a counsel + deployment blocker, not codeable. |
| Account deletion real+scoped | **HOLDS** (+ hardened, `aea3c26`) | deletion now also force-disconnects live gateway sessions + cleans referral KV. Built, not deployed (`[HUMAN]`). |
| **P0 — `ITSAppUsesNonExemptEncryption`** | **STILL-OPEN** `[HUMAN-counsel]` | `apps/mobile/app.json:14` sets `false`; `docs/STORE-READINESS.md:79-82` honestly flags x25519-over-standard-primitives is NOT auto-exempt and needs counsel sign-off before relying on it. Correctly a `[HUMAN]` item. |
| App Privacy / Data Safety form submit | **STILL-OPEN** `[HUMAN]` | drafted in docs only; ASC/Play submission + demo gateway/account are `[HUMAN]` placeholders. |

---

## Adjacent security P2s in this scope — verified

| 06-26 P2 | Status | Evidence |
|---|---|---|
| un-redacted client errors | **FIXED** (`9a1e1b0`) | `redactSecrets` now wraps client-facing gateway error bodies + SSE error frames, not just logs: `apps/gateway/src/handler.ts:793,891,1017,1209,1228,1495,1513` (+ `handler.test.ts`). |
| `redact.ts` misses UUID tokens | **FIXED** (relay) (`d4eb53b`) | `workers/relay/src/redact.ts:26-39` adds JWT (3-segment base64url) + key-name-scoped secret redaction (`access_token`/`session_token`/`zintus_session`/… with `{8,}` values — catches UUID-form session tokens) + OAuth `code=/state=`. **Minor divergence (NEW, low):** the router copy `packages/router/src/redact.ts` did NOT get the JWT/UUID/key-name rules — it still only matches prefixed provider keys. Defensible (the router redactor scrubs *provider keys* in gateway BYOK errors, where session UUIDs don't flow; session/OAuth tokens live relay-side), but the two redactors have drifted and the comment headers claim they "mirror" each other. Worth re-converging or documenting the intentional split. |
| security headers only in `vercel.json` | **FIXED** (`04f6a1f`) | moved into `apps/web/next.config.ts` `headers()` (`:8-33`) — HSTS, X-Frame DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP — so they apply on `next start` / any host, not just Vercel. |
| bundle-baked `NEXT_PUBLIC_GATEWAY_TOKEN` | **FIXED** (`bbd7a85`) | `apps/web/lib/gateway.ts:18-23` documents + guards against reintroducing it; `.env.example` updated. |
| CSP `script-src 'unsafe-inline'` | **STILL-OPEN** (documented) | `next.config.ts:22` still `script-src 'self' 'unsafe-inline'`. A nonce-CSP attempt (`5e37241`) was deliberately **reverted** (`082aee5`) because it needs browser verification first. Honestly disclosed in the `04f6a1f` commit body. Not a launch blocker; track. |
| PNA preflight / non-loopback bind | **FIXED** (`1f2bd4f`,`1255f21`) | `apps/gateway/src/handler.ts:324-337` emits `Access-Control-Allow-Private-Network: true` ONLY on an OPTIONS preflight that asks AND whose origin already passed the CORS allow-list; plus refuses a tokenless bind to any non-loopback host. `[HUMAN]` smoke: confirm Chrome PNA + Tauri non-null Origin on real builds (pre-existing). |

---

## Doc-honesty audit — `docs/FEATURE-MATRIX.md` line-by-line

Walked all 29 rows against code. **No remaining false ✅ in this scope.** Spot
checks that previously drifted are now true:

- #19 desktop provider-key entry: matrix says ⚠️ (broken keyring). The fix
  `d0d4e27` (frontend repointed to `invoke("keyring_*")`) has since landed, so the
  ⚠️ is now slightly **pessimistic** vs code — a 04-/05-scope item, flagged for
  cross-surface sync, not a false-positive.
- #27 report-AI web ✅ — verified wired (above).
- #24 image input web/CLI 🟡 — honestly 🟡 (code + tests + build green; keyed
  end-to-end browser→Gemini smoke is the stated `[HUMAN]` gate). Vision
  enforcement + EXIF-strip exist (`350e9c4`,`9c0c79d`,`9c190c6`); matrix correctly
  does **not** claim ✅. Out of deep scope but no honesty violation found.
- Hard-rule section (`:184-228`): `MANAGED_KEYS_AVAILABLE=false`, server-enforced
  503-before-Stripe, no payout code — all re-verified true.

**One stale doc (NEW, minor):** `docs/STORE-READINESS.md:69-71` still lists
"AI-content report control … `[HUMAN]` decide mechanism and wire it" as an open
checkbox, but web + desktop now ship it (`8137fd9`). Defensible because
STORE-READINESS is store/mobile-scoped (mobile report lives on the other branch),
but it understates shipped reality and should note web/desktop coverage.

---

## `[HUMAN]`-only blockers (no code can close these)

- **Counsel:** finalize + deploy privacy & terms (kill DRAFT/TBD); encryption-
  export self-classification (`ITSAppUsesNonExemptEncryption`); provider-reselling/
  custody review before any managed-keys flip.
- **Accounts/certs:** Apple $99 / Play $25 / npm token / Authenticode + Developer
  ID; ASC + Play data-safety form submission; demo gateway/account for review.
- **Infra:** deploy `/account/delete` + legal pages; domain/DNS
  (`www.zintus.ai`/`relay.zintus.ai`); set `CLOUDFLARE_API_TOKEN`/`_ACCOUNT_ID`
  backup secrets; confirm GitHub branch-protection.
- **Hold:** keep `MANAGED_KEYS_AVAILABLE=false` and no Stripe-live until an audited
  custody + double-entry ledger plane exists.

---

## Verdict

Against a brutal 10/10 launch-compliant bar, the **codeable** compliance/ops/
billing debt from 06-26 is essentially retired and independently verified: the
Stripe webhook is genuinely constant-time (`constantTimeEqual`, no early return)
and genuinely idempotent (KV event-id dedup with retry-safe marker release),
`MANAGED_KEYS_AVAILABLE=false` holds server-side before any Stripe call with no
money-movement path anywhere, a self-restore-drilling daily D1+KV backup workflow
and a complete DR/rollback runbook now exist, `build-apps` gates PRs, client-
facing errors are redacted, security headers moved off Vercel-only, PNA/non-
loopback bind are closed, the public bundle no longer bakes the gateway token, and
the AI-output report control is wired on web/desktop — with the FEATURE-MATRIX
true to the line and no remaining false ✅ in scope. What still blocks a store/
global launch is now almost entirely `[HUMAN]`: counsel-final + deployed
privacy/terms (still literal DRAFT with TBD chips), the encryption-export sign-off,
store accounts/certs/form submissions, and the deferred custody plane — plus two
small documented residuals (CSP `unsafe-inline` deliberately un-noncified; the
router vs relay redactor have drifted) and one stale STORE-READINESS checkbox.
Web (BYOK) + CLI remain a credible beta; stores/paid/custody stay correctly gated.
Not 10/10 launch-ready — but the gap is lawyers, certs, and deploys, not code.
