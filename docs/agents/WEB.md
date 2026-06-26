# WEB Agent

**Owns:** `apps/web/` (one Next.js app, two surfaces)
**Risk:** MEDIUM — UI bugs, not data bugs.

> ⚠️ **Scope:** this doc describes `main`. The branch
> `feat/deep-feature-plan-design-system` (PR #10) has a larger design-system
> rewrite (`globals.css`, providers page, tokens) **not yet merged** — don't
> document it as current until it lands.

## Source of truth
| Fact | Where |
|---|---|
| Marketing nav links | `apps/web/components/marketing/Navbar.tsx` |
| Theme toggle | `apps/web/components/marketing/ThemeToggle.tsx` + `ThemeProvider.tsx` |
| Brand accent | `apps/web/app/globals.css` (and `--marketing-accent`) |
| Dashboard reads gateway | `apps/web/lib/gateway.ts` |
| Managed-keys checkout gate | `workers/relay/src/index.ts` (`MANAGED_KEYS_AVAILABLE`) |
| Robots/sitemap/site config | `apps/web/app/{robots,sitemap}.ts`, `apps/web/lib/site.ts` |

## Surfaces
**Marketing (public):** `/ /pricing /docs /download /privacy /terms /security /changelog /about /contact`
**Product (auth-gated):** `/dashboard /dashboard/billing /chat /providers /settings`

## Decisions you must NOT reverse

### Brand + theme
Accent is violet `#7C3AED` (`Hero.tsx` uses `rgba(124,58,237,…)`); also exposed as
`--marketing-accent`. A **theme toggle exists** (`ThemeToggle.tsx`, top-right
navbar) backed by `ThemeProvider.tsx`. Do not remove or relocate it.

### Navigation anchors are root-relative — verified, do not revert
`Navbar.tsx` section links use `/#how-it-works`, `/#features`, `/#providers`,
`/#faq`, `/#install` — **with the leading `/`**. Bare `#features` breaks when the
user is on `/pricing` (it anchors within the wrong page). This was a real bug;
keep the `/#…` form.

### Managed keys = "coming soon" (checkout disabled)
The relay checkout returns **`503 managed_keys_unavailable`** for the paid tiers
(`workers/relay/src/index.ts`, gated by `MANAGED_KEYS_AVAILABLE = false` in
`tiers.ts`). Pricing shows "Coming soon", not a live Stripe checkout. Do NOT
re-enable without actually building managed keys first.

### Legal pages are DRAFT
`/privacy`, `/terms`, `/security` carry a **"⚠️ DRAFT — pending legal review"**
banner and `[TBD]` placeholders. A lawyer must review before the banner comes
off. Do not remove it. (`/.well-known/security.txt` exists for disclosure.)

### Dashboard reads `/v1/status`, not `/health`
`apps/web/lib/gateway.ts` pulls provider/quota/savings from the **auth-gated
`/v1/status`** — `/health` has no provider data (see GATEWAY.md).

### No personal data / PII in source
Contact uses role addresses (`hello@`/`support@`/`security@zintus.ai`), not a
personal email. `apps/web/lib/seo.test.ts` guards against that regressing.

## Before you start
1. `cd apps/web && bun run build` must succeed first (baseline).
2. Check both surfaces (marketing + product) and dark mode.

## When you're done
- [ ] `cd apps/web && bun run build` — 0 errors
- [ ] `bun run typecheck` — 0 errors
- [ ] Theme toggle still present; anchors still `/#…`
- [ ] PR opened, not merged (Vercel auto-deploys on merge to `main`)
