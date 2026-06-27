# COMPLIANCE + OPS + BILLING agent report (adc76e5b7f1a3efa1)

## COMPLIANCE — DO NOT SHIP TO STORES; web/CLI beta only
- **P0** Legal DRAFT not live: `apps/web/app/privacy/page.tsx:24` + `terms/page.tsx:24` render `lastUpdated="...(DRAFT)"`, literal TBD chips (privacy: DPO/EU-rep §1, retention §5, SCCs §9; terms: venue §9, arbitration §10), verbatim "DRAFT pending legal review". Worse than none for GDPR/store.
- Account deletion REAL+scoped+correct: `account/delete/page.tsx` public route (no auth wall), `DeleteAccountWidget.tsx:14-17,40-50` resolves user server-side, sends no id → can only delete caller. Built but NOT deployed (`docs/store/SECRETS.md:101`).
- **P0(stores)** AI-output report control MISSING in code (grep empty). Docs admit `STORE-READINESS.md:67-69`.
- App Privacy/Data Safety drafted in docs only; ASC/Play form submit = [HUMAN]. Demo gateway/account = `[HUMAN]` placeholders in review-notes.md.
- CANNOT LAUNCH UNTIL: privacy+terms counsel-final+deployed [HUMAN-counsel]; /account/delete deployed; AI-report wired; ITSAppUsesNonExemptEncryption confirmed by counsel (x25519 NOT auto-exempt, STORE-READINESS.md:71-82); demo gateway+ASC/Play forms [HUMAN].

## OPS — strong CI/Docker, NO backup/restore, NO incident plan
- CI good (`.github/workflows/ci.yml`): typecheck:9, gitleaks GATING + bun audit non-gating:42-52, docker-smoke boots image + asserts non-root uid:269-273, k6 load (PR), diff-cov report-only:335. Caveat: `build-apps` (real next build) MAIN-ONLY:210 → broken web build merges then fails post-merge. Branch-protection = [HUMAN] confirm.
- Docker production-grade: base digest-pinned `Dockerfile:12`, multi-stage, non-root `USER bun`:86, HEALTHCHECK:93. `release-gateway.yml` smoke-gates /health before GHCR push:56-74.
- Deploy reproducible: relay wrangler stamps SHA (OPS.md:17-21), Vercel auto main, DEPLOY.md verification + exposed-gateway hardening.
- **P0 NO backup/NO restore drill**: grep backup/restore/DR/RPO/RTO across docs/scripts/.github = nothing. D1 zintus-relay = users/subs/referrals/sessions; KV = referral-code→user. No wrangler d1 export, no KV export, no rehearsal. Unrehearsed restore ≠ backup.
- **P1** NO incident/on-call/rollback runbook (`PRODUCTION-ARCHITECTURE.md:148` lists rollback as TODO; wrangler rollback undocumented).
- **P1** Alerting opt-in Sentry/OTel only; no SLO alerts, no status page (`DEPLOY.md:130-132` [HUMAN]).
- SLOs proposed: relay /health 99.9%, err<1%, p95<2s (k6 enforces p95<2s/<5%err).

## BILLING/CUSTODY — correctly GATED, keep gated
- `workers/relay/src/tiers.ts:8` MANAGED_KEYS_AVAILABLE=false; checkoutAvailability():54-73 returns 503 managed_keys_unavailable BEFORE Stripe, enforced `index.ts:953-956`. STRIPE_PRICES all `price_FILL_FROM_STRIPE` placeholders:26-30 → 2nd 503 billing_not_configured. Web mirrors `pricing/page.tsx:17` MANAGED_KEYS_AVAILABLE=false, "Coming soon", disabled, handleCheckout early-return:112.
- No money moves: referral.ts gen/resolve only; commission_cents/pct tracked `schema.sql:69-85`, confirmed 30d via invoice.paid (`billing.ts:236-240`), but grep payout/transfer/Connect/withdraw EMPTY. Zero disbursement path.
- Why gated: no custodial system; provider ToS forbid reselling/proxying keys (core business risk); custody=regulated. Safe v2: per-tenant envelope-encrypted keys (KMS/HSM), double-entry append-only ledger, Stripe Connect post-KYC, monthly reconciliation, per-provider ToS review. Keep false until audited custody plane.

## HUMAN-ONLY: counsel (privacy/terms finalize, encryption-export, provider-reselling/custody review); Apple $99/Play $25/npm token/Authenticode+Developer ID certs; deploy legal+deletion pages; confirm branch-protection; domain/DNS www.zintus.ai + relay.zintus.ai; no managed-keys/Stripe-live until audited custody+ledger.
