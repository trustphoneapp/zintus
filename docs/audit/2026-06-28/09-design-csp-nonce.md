# Design: Land a working nonce-based CSP for `apps/web`

Date: 2026-06-28
Branch: `feat/multimodal-image-input` @ `6bcd097`
Author: security design architect
Status: DESIGN (no source changed by this doc)

---

## 0. TL;DR

A nonce-based CSP for `script-src` was attempted in `5e37241` and reverted in
`082aee5` ("needs live-browser iteration"). The implementation was **structurally
correct and Next.js-idiomatic** — per-request nonce in `proxy.ts`, forwarded on
the request header so the App Router stamps it onto framework scripts, plus
`'strict-dynamic'` and a nonce passed to `next-themes`. The most likely reason it
"broke in browser" is **not** a flaw in the production wiring; it is the
**local `next dev --webpack` iteration loop**: webpack dev uses `eval()` for HMR /
React Refresh and injects non-nonced dev scripts, so `script-src 'nonce-…'
'strict-dynamic'` (no `'unsafe-eval'`) floods the console with violations and the
app appears broken on `localhost:3000`. A secondary, production-real risk is the
**static-prerender ↔ per-request-nonce mismatch** across the ~30 mostly-static
routes.

The fix is not a code rewrite — it is a **disciplined rollout**: ship the nonce
CSP in **Report-Only** first, verify in real Chrome against a **production build
(`next build && next start`), not `next dev`**, then flip to enforcing. This doc
specifies the exact wiring, file:line touchpoints, the dev-mode carve-out, the
verification checklist, and the staged plan.

Headers portability (the audit's second CSP-adjacent P2) is **already resolved**:
`vercel.json` no longer carries headers (it is build config only), and the static
headers live in `next.config.ts`. Keep CSP in `proxy.ts` (it must be per-request)
and the static headers in `next.config.ts`. Do **not** move anything back to
`vercel.json`.

---

## 1. Ground truth — what exists today (post-revert)

### Stack
- **Next.js 16.2.9**, **App Router** (`apps/web/app/**`, root `app/layout.tsx`).
- Build/dev forced onto **webpack**, not Turbopack:
  - `apps/web/package.json:7` → `"dev": "next dev --port 3000 --hostname 127.0.0.1 --webpack"`
  - `apps/web/package.json:8` → `"build": "next build --webpack"`
  - `apps/web/package.json:9` → `"start": "next start"`
- Request interceptor is **`apps/web/proxy.ts`** (Next 16 renamed the
  `middleware` convention to `proxy`; same `config.matcher` contract — see comment
  `proxy.ts:3-5`).

### Where headers live today
- **`apps/web/next.config.ts:7-24`** — static security headers via `headers()`
  (`next.config.ts:33-35`), applied to `source: "/(.*)"`. This includes the
  **current CSP with `script-src 'self' 'unsafe-inline'`** at `next.config.ts:20-23`.
- **`apps/web/proxy.ts:6-11`** — a **duplicate** subset of static headers
  (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`) re-set on the response in `proxy.ts:29-32`. These overlap
  with `next.config.ts` (harmless duplication, but note it).
- **`apps/web/vercel.json`** — build config only (`buildCommand`, `framework`,
  `installCommand`). **No headers.** The audit's "headers only in vercel.json"
  P2 (`docs/audit/2026-06-26/03-web.md:19`) is **already remediated**.

### Inline-script surface (what a strict `script-src` must account for)
Searched `app/`, `components/`, `lib/`:
- **No `next/script`** usage.
- **No `dangerouslySetInnerHTML` / inline `<script>`** in app code.
- **No third-party scripts** (no gtag/GA, no `@vercel/analytics`, no PostHog,
  Clarity, Hotjar — the only "clarity"/"analytics" hits are CSS comments / copy).
- **No `eval(` and no `new Worker(`** in app code.
- The only inline scripts in the rendered HTML are therefore:
  1. **Next.js framework scripts** — the bootstrap/runtime `<script>` and the
     RSC flight-data inline scripts (`self.__next_f.push(...)`). Next nonces these
     automatically when it can read a nonce from the request CSP header.
  2. **`next-themes` anti-FOUC inline script** — emitted by `ThemeProvider`
     (`apps/web/components/marketing/ThemeProvider.tsx`), used by the root layout
     at `app/layout.tsx:81`. `next-themes` accepts a `nonce` prop and stamps it
     onto that script.

This is a **near-ideal app for nonce CSP**: zero third-party JS, one library inline
script with first-class nonce support. The hard part is purely the dev loop and
the static-render interaction — both addressed below.

### Route inventory (static-render risk)
~30 routes under `app/**` (full list verified). **None** declare
`export const dynamic`, `revalidate`, `generateStaticParams`, or PPR. By default
they are **statically prerendered at build time**. This is the crux of the
production correctness concern (§3.B).

---

## 2. Exactly what the reverted commit did (`5e37241`)

Four files, all correct in shape:

1. **`apps/web/proxy.ts`** — added `buildCsp(nonce)` and, in `proxy()`:
   - `const nonce = btoa(crypto.randomUUID());`
   - `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`, kept
     `style-src 'self' 'unsafe-inline'`, all other directives identical to the
     static CSP.
   - Forwarded on the **request**: `requestHeaders.set("x-nonce", nonce)` and
     `requestHeaders.set("content-security-policy", csp)`, then
     `NextResponse.next({ request: { headers: requestHeaders } })`.
   - Set on the **response**: `response.headers.set("Content-Security-Policy", csp)`.
2. **`apps/web/next.config.ts`** — **removed** the CSP entry from the static
   `securityHeaders` array (left the other five static headers). Correct: a frozen
   static header cannot carry a per-request nonce, and you must not emit **two**
   CSP headers (browsers enforce the intersection → silent breakage).
3. **`apps/web/app/layout.tsx`** — made `RootLayout` `async`, read
   `const nonce = (await headers()).get("x-nonce") ?? undefined;`, passed
   `<ThemeProvider nonce={nonce}>`.
4. **`apps/web/components/marketing/ThemeProvider.tsx`** — threaded `nonce` into
   `next-themes`' `<NextThemesProvider nonce={nonce}>`.

**Assessment:** This matches the official Next.js nonce-CSP recipe almost exactly
(middleware/proxy generates the nonce, forwards the CSP on the request so
`app-render`'s `getScriptNonceFromHeader` can read it, sets the CSP on the
response for enforcement). The wiring is sound. What it lacked was a **dev-mode
carve-out** and a **Report-Only verification stage** — i.e., the things that make
it survive live-browser iteration.

---

## 3. Root-cause hypotheses: why it "broke in browser"

Ranked by likelihood given the evidence.

### A. (Most likely) Tested against `next dev --webpack`, which needs `'unsafe-eval'` and emits non-nonced dev scripts
The owner's note is "needs live-browser iteration" and the dev command is
`next dev --webpack` on `127.0.0.1:3000`. In **webpack dev mode**:
- **HMR / React Fast Refresh use `eval()`** to evaluate hot modules. The attempted
  `script-src` has **no `'unsafe-eval'`**, so Chrome logs:
  `Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an
  allowed source of script in the following Content Security Policy directive…`
  — repeatedly, and Fast Refresh stops working.
- Dev-only injected scripts (the webpack-hmr client, the dev overlay) are not
  always nonced the way the production bootstrap is. Under **`'strict-dynamic'`,
  the `'self'` and host allowlist are *ignored* for `<script>`**, so any
  dev script that lacks the nonce is **blocked outright** → the page looks broken,
  the error overlay may itself fail to load, and it is easy to conclude "the nonce
  CSP doesn't work."

This single factor explains a frustrating live-iteration loop on localhost even
though the **production** path is fine. The fix is to **not enforce the strict CSP
in dev** (or add `'unsafe-eval'` in dev only) and to **verify against
`next build && next start`** (§6).

### B. (Real, production) Static prerender ↔ per-request nonce mismatch
With `'strict-dynamic'`, **every** script must carry the request nonce (or be
loaded by something that does). For a **statically prerendered** route the HTML —
including its inline framework scripts — is generated **at build time, with no
request and therefore no nonce** (or a build-time placeholder). At runtime the
response CSP header carries a **fresh per-request nonce**, which does not match
the baked HTML → **all scripts blocked → blank/dead page**.

Next.js mitigates this by treating "a nonce is present in the request CSP header"
as a signal to **dynamically render** the route so the live nonce is stamped in.
The attempt also pulled `headers()` into the **root layout** (`app/layout.tsx`),
which **opts the entire tree into dynamic rendering** — this is what makes the
nonce land correctly. But that has two consequences worth designing around:
- It is **load-bearing**: if a future route opts back into static/ISR/PPR (e.g.,
  someone adds `export const dynamic = 'force-static'` or PPR is enabled), that
  route will ship build-time HTML with a stale nonce and break under enforcement.
- It is a **perf/cost regression**: ~30 currently-static marketing routes become
  dynamically rendered, losing full-page CDN/static caching. This is the genuine
  tradeoff of nonce CSP and must be acknowledged (§4).

If the attempt was *also* spot-checked in production mode and a route slipped
through static, it would manifest as exactly the "white screen, all scripts
refused" symptom.

### C. (Possible) Double CSP header / intersection
If during iteration the CSP was momentarily present in **both** `next.config.ts`
(static, `unsafe-inline`) **and** `proxy.ts` (nonce), the browser enforces the
**intersection** of the two policies. Two `script-src` lists where one has
`'unsafe-inline'` and the other has `'nonce-…' 'strict-dynamic'` do **not** union;
the result is effectively the most restrictive interpretation and can block the
nonced scripts unexpectedly. The final committed diff removed CSP from
`next.config.ts`, so this was likely avoided — but it is a classic trap to guard
against during iteration (only **one** layer may emit CSP).

### D. (Low) Nonce grammar / encoding
`btoa(crypto.randomUUID())` yields standard base64 (may contain `+`, `/`, `=`).
Next's nonce regex (`/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/`) accepts these, and the
CSP base64 grammar permits them, so this is **not** a likely breakage. (Minor
nit: prefer a 16-byte random → base64 over `btoa(uuid)` for entropy clarity, but
not required.)

**Conclusion:** The implementation didn't break because it was wrong; it broke
because it was **iterated in the wrong environment (dev/webpack) and enforced
before being observed in Report-Only**. Both are process fixes.

---

## 4. The correct Next.js-idiomatic approach (target design)

Keep the `5e37241` structure; add the two things it lacked (dev carve-out +
Report-Only staging) and harden the edges.

### 4.1 Nonce generation — in `proxy.ts` (correct location)
Per-request nonce, base64, Web-standard globals only (proxy runs on the Edge-style
runtime — no `Buffer`):

```
const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
// or keep btoa(crypto.randomUUID()) — both pass Next's nonce grammar
```

### 4.2 Propagation — forward CSP on the request, set on the response
This is the Next.js contract and the attempt did it right:
- `requestHeaders.set("content-security-policy", csp)` → App Render's
  `getScriptNonceFromHeader` reads the nonce and stamps Next's bootstrap +
  flight-data scripts.
- `requestHeaders.set("x-nonce", nonce)` → server components can read it via
  `await headers()` (the layout passes it to `next-themes`).
- `NextResponse.next({ request: { headers: requestHeaders } })`.
- `response.headers.set("Content-Security-Policy", csp)` (or
  `Content-Security-Policy-Report-Only` during staging — §5) for actual
  enforcement.

### 4.3 Framework + library inline scripts
- **Next framework scripts:** nonced automatically from the request CSP header. No
  code needed beyond 4.2.
- **`next-themes`:** pass `nonce` from layout → `ThemeProvider` → `next-themes`
  (exactly `5e37241`'s `app/layout.tsx` + `ThemeProvider.tsx` changes). Required,
  because under `'strict-dynamic'` an un-nonced anti-FOUC `<script>` is blocked →
  theme flash + console violation.

### 4.4 `'strict-dynamic'` with a back-compat fallback
Use:
```
script-src 'self' 'nonce-<n>' 'strict-dynamic' https:;
```
- CSP3 browsers (all current Chrome/Edge/Firefox/Safari): honor
  `'nonce-…' 'strict-dynamic'`, **ignore** `'self'` and `https:` for scripts.
- CSP1/2 (legacy) browsers: ignore `'strict-dynamic'`, fall back to `'self' https:`
  so the app still loads (degraded XSS posture, but not broken).
This is the recommended belt-and-suspenders form.

### 4.5 `style-src` stays `'unsafe-inline'` (deliberate)
React/Next inject framework inline **styles** (`next/font` CSS variables, inline
`style=` attributes like `GalaxyBackground`'s, styled-jsx-style runtime CSS) that
cannot be reliably nonced/hashed per request without breaking rendering. The XSS
win lives in `script-src`; an injected `<style>` is far lower risk than an
injected `<script>`. **Do not chase a perfect `style-src` in this pass** — it is a
separate, high-friction effort and not required to close the audit P2.

### 4.6 Dev-mode carve-out (the missing piece)
In `proxy.ts`, branch on `process.env.NODE_ENV`:
- **production:** the strict policy from 4.4 (no `'unsafe-eval'`).
- **development:** add `'unsafe-eval'` to `script-src` (webpack HMR/Fast Refresh
  needs it) — or skip the strict CSP entirely in dev. Recommended:
  ```
  script-src 'self' 'nonce-<n>' 'strict-dynamic' https:
    ${isDev ? "'unsafe-eval'" : ""}
  ```
  Without this, **every local browser test is a false negative** — which is almost
  certainly what made this "need live iteration."

### 4.7 Matcher hygiene
Current matcher (`proxy.ts:36-41`) excludes `_next/static`, `_next/image`,
`favicon.ico`, `api/`. HTML document requests (`/`, `/pricing`, RSC navigations)
still match and get the CSP+nonce — correct. Keep CSP off static asset responses
(they need no script policy and excluding them preserves their cacheability).

---

## 5. Staged rollout (Report-Only first — non-negotiable)

### Stage 0 — Prep
- Confirm exactly **one** layer emits CSP. Remove CSP from `next.config.ts`
  (`:20-23`) when CSP moves to `proxy.ts`. Keep the other five static headers in
  `next.config.ts`.
- Add a CSP violation report sink. Either:
  - `report-to` / `report-uri` pointing at a relay endpoint (e.g.
    `/api/csp-report` proxied to the relay worker), **or**
  - rely on browser console + the in-browser checklist (§6) if no collector is
    stood up. A collector is strongly preferred for the Report-Only stage because
    it captures violations from real visitors/routes you didn't click.

### Stage 1 — Report-Only (observe, don't break)
- Emit `Content-Security-Policy-Report-Only` with the **full strict policy**
  (nonce + strict-dynamic) instead of the enforcing header. Keep the **existing
  enforcing** `unsafe-inline` CSP in place meanwhile (Report-Only does not
  enforce, so the app keeps working).
- Ship to preview/staging. Click through every route (§6 list). Collect
  violations. Expected legitimate reports to **resolve before enforcing**: the
  `next-themes` script (until the nonce prop lands), any route that slipped static.
- Exit criteria: **zero script-src violations** across all routes in real Chrome +
  the report collector over a representative period.

### Stage 2 — Enforce in production build locally
- Switch to enforcing `Content-Security-Policy`. Run `next build && next start`
  (NOT `next dev`). Re-run §6 against `localhost:3000` prod server.
- Exit criteria: zero violations, no functional regressions, theme has no FOUC.

### Stage 3 — Enforce on preview, then production
- Deploy enforcing CSP to a Vercel **preview**; run §6 against the preview URL on
  real Chrome + one Safari + one Firefox pass (strict-dynamic fallback sanity).
- Promote to production. Keep the report collector live for a soak period; be
  ready to revert `proxy.ts` to Report-Only (one-line header-name change) if
  real-traffic violations appear.

Rollback at any stage is a **single header-name swap** in `proxy.ts`
(`Content-Security-Policy` ↔ `Content-Security-Policy-Report-Only`) — much cheaper
than the full git revert that happened in `082aee5`.

---

## 6. In-browser verification checklist (this NEEDS live iteration)

**Golden rule: verify against `next build && next start`, never `next dev`.** Dev
mode's `eval`/HMR will produce violations that do not exist in production and will
send you chasing ghosts.

### Setup
1. `cd apps/web && bun run build && bun run start` (prod server on
   `127.0.0.1:3000`).
2. Open **real Chrome** (not headless) → DevTools → Console + Network tabs.
3. Optionally Console → gear → enable "Preserve log" so navigations don't clear
   violations.

### What to watch for in Console
- `Refused to execute inline script because it violates the following Content
  Security Policy directive: "script-src …"` → a script is missing the nonce
  (framework propagation failing, or a static-rendered route).
- `Refused to load the script '…' because it violates …` → a `src` script not
  trusted under strict-dynamic (would indicate an un-nonced loader; should not
  happen with Next's chunk loader).
- `Refused to evaluate a string as JavaScript … 'unsafe-eval'` → you are on
  `next dev`, or `'unsafe-eval'` leaked needs into prod (it shouldn't).
- Any `report-uri`/`report-to` POST in the Network tab → a live violation.

### What to click / routes to exercise (all must be violation-free)
Marketing/static (highest static-render risk):
- `/` (home), `/pricing`, `/about`, `/docs`, `/developers`, `/blog`,
  `/changelog`, `/download`, `/contact`, `/security`, `/privacy`, `/terms`.
Auth + referral + dynamic:
- `/login`, `/auth/check-email`, `/r/<somecode>` (dynamic `[code]`),
  `/account/delete`.
Authed app shell + dashboard (proxy redirect path):
- Hit `/dashboard` **without** a session cookie → confirm redirect to
  `/login?next=/dashboard` still works and the login page renders with no CSP
  violations (the redirect path in `proxy.ts:20-27` must run before/independently
  of CSP set).
- With a session: `/dashboard`, `/dashboard/billing`, `/dashboard/sessions/<id>`,
  and the `(app)` group: `/chat`, `/compare`, `/research`, `/projects`,
  `/providers`, `/settings`, `/terminal`, `/usage`.

### Behavioral checks (functional, not just console)
- **Theme/FOUC:** hard-reload `/` several times. The page must paint in the dark
  theme immediately with **no flash** — proves the `next-themes` nonce landed and
  its anti-FOUC inline script ran. A flash + a console violation = nonce not
  reaching `ThemeProvider`.
- **Hydration:** interact with a client component (open the chat input, toggle a
  setting). Confirm React hydrated (no "blocked script" → dead buttons).
- **Streaming/connect-src:** start a chat/compare/research request; confirm the
  `connect-src` allowlist (`relay.zintus.ai`, `*.zintus.ai`, localhost in dev)
  still permits the fetch/stream — watch for `Refused to connect` errors.
- **Nonce freshness:** View Source on `/` twice (two separate requests); confirm
  the `nonce="…"` attribute **differs** between loads and matches the
  `Content-Security-Policy` response header's `'nonce-…'` for that same response
  (DevTools → Network → the document request → Response Headers).
- **No double CSP:** in the document response headers, confirm exactly **one**
  `Content-Security-Policy` header.

### Cross-browser
- One pass each in **Safari** and **Firefox** to confirm strict-dynamic + the
  `https:` fallback behave (no broken scripts).

---

## 7. `strict-dynamic` vs explicit allowlist — tradeoff

| | `'nonce-…' 'strict-dynamic'` (recommended) | Explicit host allowlist (`'self' + hosts`, no nonce) |
|---|---|---|
| XSS strength | Strong — only nonced scripts + their transitive loads run; injected `<script>` without the (unguessable, per-request) nonce is dead | Weak-ish — any script from an allowlisted origin runs; allowlist bypasses (JSONP, old AngularJS-style gadgets) are a known class |
| Next.js chunk loading | Works natively — Next's loader is nonced/non-parser-inserted, so dynamically imported chunks inherit trust | Must allowlist `'self'` for every chunk; fine, but no XSS guarantee |
| Maintenance | Near-zero allowlist to maintain (this app has **no third-party JS**) | Must enumerate and maintain every script origin forever |
| Static rendering | **Forces dynamic rendering** of nonced routes (perf/cost cost) | Compatible with static rendering (no per-request value) → can stay in `next.config.ts`, fully CDN-cacheable |
| Legacy browsers | Degrades via `'self' https:` fallback | Works everywhere |

**Recommendation: `'strict-dynamic'` with nonce.** This app is the ideal candidate
(zero third-party scripts, one nonce-aware library). The only real cost is losing
static rendering on marketing pages. If that perf/cost hit is unacceptable, the
**fallback option** is to keep marketing routes static under a **hash-based** or
allowlist CSP and apply the nonce CSP only to the dynamic `(app)`/`dashboard`
group — but that means two CSP regimes and more complexity; prefer the single
strict-dynamic policy unless caching cost proves material.

---

## 8. Headers portability recommendation (vercel.json vs middleware vs next.config)

**Current state is already good and should be preserved:**
- **`vercel.json` carries NO headers** — the audit P2 ("headers only in
  vercel.json", `2026-06-26/03-web.md:19`) is **resolved**. Do **not** move
  headers back into `vercel.json`; it is Vercel-only and non-portable.
- **Static headers → `next.config.ts` `headers()`** (`next.config.ts:7-35`).
  Portable: applies on `next start`, self-host, any platform, and to `/api` +
  static assets (which the proxy matcher excludes). Keep them here.
- **CSP → `proxy.ts`** (per-request, must be dynamic for the nonce). This is the
  only correct home for a nonce CSP.

**Cleanup to fold in:** `proxy.ts:6-11` re-sets four headers
(`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`) that `next.config.ts` already emits for `/(.*)`. This is
redundant. Two clean options:
- (Preferred) **Drop** the duplicate `SECURITY_HEADERS` block from `proxy.ts`;
  let `next.config.ts` own all static headers, and let `proxy.ts` own **only** the
  per-request CSP (+ the dashboard redirect). Smallest surface, single source of
  truth per header.
- (Alt) Move **all** security headers into `proxy.ts` for one-stop reading. Worse
  portability for `/api`/static-asset routes that the matcher excludes — not
  recommended.

Net: **CSP in `proxy.ts`, everything else static in `next.config.ts`, nothing in
`vercel.json`.**

---

## 9. Exact file:line touchpoints to implement

1. **`apps/web/proxy.ts`**
   - Add `buildCsp(nonce, { isDev })` (restore from `5e37241`, plus the §4.4
     `https:` fallback and §4.6 dev `'unsafe-eval'` branch).
   - In `proxy()` (currently `:13-34`): generate `nonce`, build `csp`, set
     `x-nonce` + `content-security-policy` on forwarded **request** headers, set
     the CSP (Report-Only first per §5) on the **response**.
   - Remove the redundant `SECURITY_HEADERS` block (`:6-11`, `:29-32`) per §8.
   - Keep matcher (`:36-41`) and the dashboard redirect (`:20-27`) unchanged.
2. **`apps/web/next.config.ts`**
   - Remove the CSP entry (`:20-23`) from `securityHeaders`. Keep the other five
     static headers and `headers()` (`:33-35`).
3. **`apps/web/app/layout.tsx`**
   - Make `RootLayout` `async`; `const nonce = (await headers()).get("x-nonce") ??
     undefined;`; `<ThemeProvider nonce={nonce}>` (`:68-85`). (Exactly `5e37241`.)
4. **`apps/web/components/marketing/ThemeProvider.tsx`**
   - Add optional `nonce?: string` prop, forward to `<NextThemesProvider
     nonce={nonce}>`. (Exactly `5e37241`.)
5. **(Optional, recommended)** `apps/web/app/api/csp-report/route.ts` (or relay
   endpoint) + `report-to`/`report-uri` directive for the Report-Only stage.

---

## 10. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Dev/webpack `eval` + non-nonced dev scripts → false "broken" signal | High (this is what sank the first attempt) | §4.6 dev carve-out (`'unsafe-eval'` in dev only); verify against `next build && next start` only (§6) |
| Static route ships build-time HTML with stale/no nonce → all scripts blocked | High | `headers()` in root layout forces dynamic render; verify EVERY route in Report-Only (§5/§6); add a guard/CI note that nonced routes must not opt back into static/PPR |
| Loss of full-page static caching on ~30 marketing routes (perf/cost) | Medium | Accept as the cost of nonce CSP; or split regimes (§7 fallback) if caching cost proves material |
| Two CSP headers (proxy + leftover next.config) → enforced intersection breaks scripts | Medium | Remove CSP from `next.config.ts`; assert exactly one CSP header in §6 checklist |
| `next-themes` nonce not threaded → theme FOUC + violation | Medium | Steps 3-4; FOUC check in §6 |
| `connect-src` too tight for streaming endpoints | Low | §6 streaming check; allowlist already includes `relay.zintus.ai`, `*.zintus.ai`, localhost(dev) |
| Future third-party script added (analytics, etc.) silently blocked by strict-dynamic | Low now (none today) | Document: new scripts must be loaded via a nonced `next/script` or added deliberately; report collector catches it |
| Legacy browser drops strict-dynamic and has no script source | Low | `'self' https:` fallback (§4.4) |

---

## 11. Bottom line

The reverted code was the **right design executed in the wrong test harness and
shipped without a safety stage.** Re-land `5e37241`'s four-file change with two
additions — a **dev-mode `'unsafe-eval'` carve-out** and a **`'self' https:`
strict-dynamic fallback** — fold the redundant proxy headers into `next.config.ts`,
and roll out **Report-Only → prod-build verify → enforce** with real-Chrome
clicks against `next start` (never `next dev`). Keep CSP in `proxy.ts`, static
headers in `next.config.ts`, and nothing in `vercel.json`. That closes audit P2
(`2026-06-26/03-web.md:18`) without another live-browser-induced revert.
