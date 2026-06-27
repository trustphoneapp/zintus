# WEB PRODUCT agent report (a3026ee37577c8a4b)

## VERDICT ~7.5/10. Honesty rules HOLD, plumbing wired. Biggest gap: web "markdown rendering" is FAKE.

## DEAD/FAKE/MISLEADING (highest priority)
1. **Markdown is line-formatter not markdown.** MessageBubble.tsx:11-34: ``` fences → return null (STRIPPED); code lines render as <p class="message-paragraph"> (indentation collapsed, no monospace). No headers/bold/inline-code/links/tables/numbered-lists — only "- " bullets. **FEATURE-MATRIX row 7 marks web markdown ✅ "parity with mobile/desktop Markdown.tsx" = FALSE; web never got Markdown.tsx.** Row 8 code-block copy "🟡 verify web" → web has NO per-block copy (only whole-message copy() line 52).
2. **Project strategy still DEAD field.** Consumer exists (projects/page.tsx:65 applies project.strategy) but create/edit form (FormState 17-23, save() 45-57) has NO strategy input → every project saved strategy:null → line 65 guard never true. FM "made strategy actually applied" OVERSTATED.
3. **"Report AI response" (#27) ABSENT on web.** No report/flag control in MessageBubble/chat. Mobile+desktop have it; web 🟡=missing.

## P0: NONE. No reachable money movement, no fake image injection, consent gates hold. Image refusal GENUINELY honest (only [Image: ref is a comment chat/page.tsx:181 describing what was removed; web always sends images:[]).

## P1
- No favicon/app icon/PWA manifest/apple-touch-icon. public/ only has llms.txt; no app/icon.* app/favicon.ico app/apple-icon.* manifest; layout.tsx:39-66 metadata no icons. Fix add app/icon.svg+apple-icon.png+manifest.ts.
- Markdown/code rendering (above). Fix port desktop Markdown.tsx + per-block copy.
- No stop/cancel during Compare and Research. compare/page.tsx ("Comparing…" disabled, abort only unmount/removeColumn); research/page.tsx:54-56 (abort only unmount). Chat has Esc/stop. Fix expose Stop→controllerRef.abort().

## P2
- CSP script-src 'unsafe-inline' (vercel.json) — weak XSS. Fix nonce middleware.
- Headers live ONLY in vercel.json not next.config.ts → any non-Vercel deploy ships ZERO security headers. Fix mirror into next.config.ts headers().
- Bundle-baked NEXT_PUBLIC_GATEWAY_TOKEN (lib/gateway.ts:6,10) — inlined into client JS; harmless for default loopback (empty), leaks for shared-gateway deploys.
- openBillingPortal not client-guarded.
- a11y focus rings removed select:focus-visible{outline:none} (globals.css:1599,3095) — keyboard focus may be invisible. Verify in browser for box-shadow replacement.
- Consent dialog a11y: ConsentDialog.tsx + inline (chat/page.tsx:423-467) role=dialog aria-modal but NO aria-labelledby, no focus trap, no Esc-close, no autofocus/restore.

## MISSING UI STATES vs ChatGPT/Claude/Gemini/Perplexity: Compare/Research no stop mid-stream; Research no per-search error (single global error), no "0 results" partial; Chat no edit/resend, no retry on errored turn (error baked into bubble chat/page.tsx:263), no 429-specific copy; no app-wide <main> landmark or skip-to-content in AppShell.tsx.

## A11Y/SEO/HEADERS: reduced-motion handled (globals.css:3109,3286 good); GalaxyBackground pointerEvents:none good. Gaps: focus-ring removal, no app <main>/skip-link, consent dialog not trap/labelled. SEO metadata/OG/Twitter solid, opengraph-image.tsx/robots.ts/sitemap.ts real+tested. MISSING favicon/manifest (P1). Headers full CSP+HSTS+XFO:DENY+nosniff on Vercel ONLY.

## PRICING/BILLING GATE
- createCheckout: only call site pricing/page.tsx:114 TRIPLE-gated: if(!MANAGED_KEYS_AVAILABLE)return :112, buttons disabled :228,256,304 "Coming soon", server relay 503. UNREACHABLE ✓.
- openBillingPortal: dashboard/billing/page.tsx:129; button shows only if billing.tier!=="free" :218. NO client MANAGED_KEYS_AVAILABLE guard — unreachable by consequence not explicitly. WEAKEST LINK; stray non-free tier from relay surfaces live Stripe portal. Fix gate button on same constant.
- Referral: fetchReferralStats.earned_cents shown as live "Earned $X" console :386 with no "coming soon" (pricing FAQ says not live — INCONSISTENCY). app/r/[code]/page.tsx inert (validate→cookie→redirect to gated /pricing). No payout/transfer ✓.

## COMPETITOR GAPS: rich markdown+syntax-highlight+per-block copy; edit-and-resend; conversation search/rename/pin sidebar; regenerate-with-different-model from chat; favicon/installable PWA + keyboard-shortcut help sheet.

## HUMAN: confirm vercel.json headers apply on chosen host (or port to next.config.ts); decide referral-dashboard honesty (label "coming soon" or hide); verify focus-ring visibility + mobile-web responsive in real browser; ship favicon/manifest assets.
