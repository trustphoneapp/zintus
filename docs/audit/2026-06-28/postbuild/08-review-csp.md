# Post-build review: relanded nonce CSP (`apps/web`)

Date: 2026-06-28
Branch: `feat/tool-calling`
Scope: `apps/web/proxy.ts`, `next.config.ts`, `app/layout.tsx`, `components/marketing/ThemeProvider.tsx`
Design ref: `docs/audit/2026-06-28/09-design-csp-nonce.md`
Mode: READ-ONLY review. In-browser behaviour is **NOT** verified here — that is the remaining [HUMAN] step (design §6).

---

## Summary verdict

The four-file reland matches the design and the Next.js nonce-CSP recipe. Source is sound on all six checks. The one concrete hazard found is **not in source** but in the working tree: a **stale `.next/` build artifact still carries the old static CSP**, which would double-set CSP if `next start` is run without a fresh `next build`.

---

## (1) Is `'unsafe-eval'` provably absent from the production CSP? — CORRECT (with build-time caveat)

`apps/web/proxy.ts:22` `const IS_DEV = process.env.NODE_ENV !== "production";`
`apps/web/proxy.ts:58` `IS_DEV ? "'unsafe-eval'" : ""` (then `.filter(Boolean)`).

Trace: `proxy.ts` is Next middleware/proxy code. Next inlines `process.env.NODE_ENV` at **build time**. `next build` (and `next start`, `next build --webpack` per `package.json:8`) force `NODE_ENV=production`, so `IS_DEV` is statically replaced with `false`, the ternary folds to `""`, and `'unsafe-eval'` is dead-code-eliminated from the production bundle. It cannot appear at runtime in a production build. Verified no other `'unsafe-eval'` source in the directive list (`proxy.ts:53-77`).

- CORRECT for the standard pipeline.
- RISK (low, by-design fail-open direction): the predicate is `!== "production"`, so any build where `NODE_ENV` is unset or `"test"` would *include* `'unsafe-eval'`. Standard `next build`/Vercel always set `production`, so this only bites a non-standard build invocation. A fail-closed form (`=== "development"`) would be strictly safer but is not required to pass.

## (2) Exactly ONE Content-Security-Policy header? — CORRECT (source); RISK in working tree

- Source: CSP removed from `next.config.ts` (only the five non-nonce static headers remain, `next.config.ts:14-26`; explanatory comment `:8-13`). The single CSP is set once on the response at `proxy.ts:118`. `vercel.json` carries no headers (build config only). Grep across `*.ts/*.tsx/*.json` found no other CSP emitter. So a clean build emits exactly one CSP header on document responses.
- RISK / MUST-REBUILD: `apps/web/.next/routes-manifest.json:41-44` (build dated Jun 28 01:51) still contains the **old** static header `script-src 'self' 'unsafe-inline'`. This is a stale artifact from a pre-change build (current `next.config.ts` no longer produces it). If anyone runs `next start` against this stale `.next/` without rebuilding, `headers()` would emit the old enforcing CSP **and** `proxy.ts` would emit the nonce CSP → two CSP headers → browser enforces the intersection → nonced scripts silently blocked. A fresh `next build` regenerates the manifest without CSP and resolves this. The verifier MUST `next build` (not just `next start`) before browser testing.

## (3) Static-prerender vs per-request nonce — CORRECT (load-bearing); MUST-BROWSER-VERIFY

`app/layout.tsx:80` `const nonce = (await headers()).get("x-nonce") ?? undefined;` in an `async` `RootLayout` opts the whole tree into dynamic rendering, so the live per-request nonce is stamped instead of a baked build-time value. Confirmed **no** route opts back into static: grep for `export const dynamic`, `revalidate`, `generateStaticParams`, `force-static`, PPR across `app/` returned nothing.

- CORRECT today, but this is load-bearing: any future `force-static`/PPR route would ship stale-nonce HTML and break under enforcement (design §3.B / §10). Worth a CI guard note.
- MUST-BROWSER-VERIFY: that scripts actually carry the matching nonce and no route white-screens — only observable in a real browser against a prod build.

## (4) `'strict-dynamic'` + `'self' https:` fallback — CORRECT

`proxy.ts:53-61` builds `script-src 'self' 'nonce-<n>' 'strict-dynamic' https:` (+ dev-only `'unsafe-eval'`). This is the recommended CSP3 belt-and-suspenders form: CSP3 browsers honor `'nonce-…' 'strict-dynamic'` and ignore `'self'`/`https:` for scripts; CSP1/2 browsers ignore `'strict-dynamic'` and fall back to `'self' https:`. Ordering and grammar are correct.

## (5) Nonce predictability — CORRECT

`proxy.ts:86` `const nonce = btoa(crypto.randomUUID());`. `crypto.randomUUID()` is a CSPRNG v4 UUID (~122 bits entropy); base64 is a reversible encoding that neither adds nor removes entropy but yields a valid CSP base64 token matching Next's nonce grammar. Fresh per request (generated inside `proxy()` per call). 122 bits is far above any practical guessing threshold. Note: the nonce is not a secret — it is published in the response CSP header and script tags; its only requirement is per-request unguessability, which is met.

## (6) Forwarding CSP on the REQUEST header — CORRECT (no meaningful leak)

`proxy.ts:111-113` sets `x-nonce` and `content-security-policy` on a cloned request `Headers`, passed via `NextResponse.next({ request: { headers } })`. These are internal forwarded request headers consumed by App Render (`getScriptNonceFromHeader`) — they are not response headers and are not echoed to the client. No code forwards `x-nonce`/the request CSP to an external origin (relay fetches are unaffected). Even if the nonce were exposed it is non-secret. No leak.

---

## Other observations (non-blocking)

- Redirect path `proxy.ts:96-103` returns the `/login` redirect **before** setting any CSP, so 302 responses carry no CSP header. Acceptable (redirects have no script-bearing body).
- `CSP_REPORT_ONLY` flag (`proxy.ts:29`, `:88-90`) is wired correctly for staged rollout: the **enforcing** CSP name is always forwarded on the request (so Next still reads the nonce) while the response header name flips to `…-Report-Only`. Matches design §5.
- Redundant-header cleanup from design §8 was applied: `proxy.ts` no longer re-sets the static security headers; `next.config.ts` is the single source for those.
- Matcher (`proxy.ts:122-126`) excludes `_next/static`, `_next/image`, `favicon.ico`, `api/` — keeps CSP off cacheable assets, applies to document/RSC requests. Correct.

## Remaining [HUMAN] step — explicitly NOT verified here

Per design §6, the following are observable only in a real browser against `next build && next start` (never `next dev`), and are **NOT** claimed verified by this review: actual nonce stamping on framework + `next-themes` scripts, zero `script-src` violations across all ~30 routes, no theme FOUC, exactly one CSP header on the wire, per-request nonce freshness, and Safari/Firefox strict-dynamic fallback. Rebuild first (see check 2).
