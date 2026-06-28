# WEB PRODUCT — re-verification audit (2026-06-28)

Independent re-verify of `docs/audit/2026-06-26/03-web.md` against ACTUAL CODE on
`feat/multimodal-image-input` @ `6bcd097`. Scope: apps/web chat UX, markdown,
image attach UI, billing gate, referral display, account-delete, a11y/headers,
Private-Mode signal. Read-only on source. Targeted suite run below.

## VERDICT ~9/10. Every prior web finding I could classify is FIXED, with real
code (not doc claims) behind each. The image upload path is honest end-to-end.
Two carryovers remain (CSP `unsafe-inline`; `openBillingPortal` not explicitly
constant-guarded — unreachable by consequence). Remaining gaps are coverage/
in-browser, not honesty defects. No dead buttons, no fake renders, no
capability-claim the backend can't honor were found.

## Tests run (all green)
`bun test apps/web/lib/image-attachments.test.ts apps/web/app/_components/markdown.test.ts apps/web/lib/billing.test.ts apps/web/lib/focus-trap.test.ts apps/web/app/account/delete/account-delete.test.ts`
→ **30 pass / 0 fail, 101 expect()** across 5 files.

---

## Claims to verify this session

### 1. Real markdown renderer + per-code-block copy — FIXED ✅
`apps/web/app/_components/Markdown.tsx:36-177`. A genuine block parser (fenced
code, headings, hr, blockquote, ul/ol, GFM tables) + inline pass for
`` `code` ``/`**bold**`/`*em*`/links (`:94-116`). Fences are captured into a
`code` block (`:43-51`) — the old "strip ``` and drop to `<p>`" bug is gone.
`CodeBlock` (`:118-140`) renders a per-block **Copy** button writing
`navigator.clipboard.writeText(text)` with a 1.2s "Copied" state. Wired:
`MessageBubble.tsx:87` renders `<Markdown>` for the assistant turn only; the user
turn stays plain `pre-wrap` text (`:82-85`) — correct (don't markdown user input).
Whole-message copy still exists separately (`MessageBubble.tsx:174-177`).
**Was prior P1 / "fake markdown."**

### 2. Favicon / apple-icon / PWA manifest — FIXED ✅
`apps/web/app/icon.svg` (real SVG Z-mark, labelled PLACEHOLDER pending brand
asset), `apps/web/app/apple-icon.tsx` (generated), `apps/web/app/manifest.ts`
(`name`/`short_name`/`start_url:"/"`/`icons:[/icon.svg, /apple-icon]`). These are
Next file-convention metadata routes — auto-emitted as `<link rel="icon|apple-touch-icon|manifest">`,
so `layout.tsx` needing no explicit `icons` field is correct, not a miss.
[HUMAN] icons are honest placeholders, flagged in-file. **Was prior P1.**

### 3. Image attach button + thumbnail, end-to-end — PROVEN IN CODE ✅
Traced component → lib → send → bubble:
- **Button:** `chat/page.tsx:938-947` — explicit `chat-attach` button, `image`
  icon, `aria-label="Attach an image or text file"`, opens the hidden
  `<input type=file accept="image/jpeg,image/png,image/webp,…">` (`:899-910`).
  Also drag-drop (`:744-747`) and paste (`:931-935`).
- **Processing (honest):** `handleFiles` (`:247-325`) gates MIME via
  `acceptImageFile` (svg/gif/bmp rejected, `image-attachments.ts:26-28`), enforces
  max-4 (`imageSlotsRemaining`), then `processImage(file)` from `@zintus/media`
  (real canvas decode/resize + EXIF strip) — the returned `ImageContentBlock` is
  what gets SENT; `previewUrl = URL.createObjectURL(file)` is the ORIGINAL, used
  only for the thumbnail (`:275-282`).
- **Composer thumbnail + EXIF badge:** `chat/page.tsx:852-897` (`<img>` preview +
  size + "EXIF stripped" badge + remove that revokes the object URL).
- **Send (no fake injection):** `buildImageMessageContent(text, blocks)` returns
  `[{type:"text"},…images]` (`image-attachments.ts:49-54`); the user content is a
  `ContentBlock[]` (`chat/page.tsx:489-492`), POSTed as `messages[].content`
  blocks (`gateway.ts:489-516`). There is **no** `images:[]` field and **no**
  `[Image: name]` text note — test `image-attachments.test.ts:75-86` asserts the
  serialized content never contains `[Image:`.
- **Sent bubble:** `MessageBubble.tsx:97-162` renders the real thumbnail from
  `previewUrl` (with `onError` → hide) + a metadata chip (name/size/dims/EXIF).
  Stored history carries **metadata only, never base64** (`UiImageMeta`,
  `app-store.ts:13-24,37-38`); after reload the `blob:` URL is dead and the bubble
  falls back to the chip — documented and honest.
- **Vision honesty:** a concrete non-vision provider is blocked *before* send with
  a warn notice (`chat/page.tsx:472-484` via `providerCanSeeImages` →
  `supportsVision`); auto-routing is allowed and a gateway 422
  `unsupported_capability` is surfaced as an honest message + provider suggestions
  (`chat-client`/`gateway.ts:444-457,529-539`; `chat/page.tsx:394-404`), not a
  crash. Post-send confirms which provider actually read the image
  (`:379-384`). **Real multimodal UX — no dead button, no fake render.**
- **Regenerate:** re-sends the same bytes from `lastSentImagesRef` (`:565-624`);
  if bytes are gone post-reload it warns "re-attach" rather than silently
  regenerating text-only. Honest.

### 4. Referral "Earned $X" no longer shown while gated — FIXED ✅
`billing.ts:34` `REFERRAL_PAYOUTS_LIVE = false`; `formatReferralEarned`
(`:42-48`) returns **"Coming soon"** while gated (never a dollar figure).
Rendered at `dashboard/billing/page.tsx:384` and a "payouts not live" note at
`:419`. `billing.test.ts` covers the gated/live branches. Resolves the prior P2
inconsistency (FAQ said "not live" but dashboard showed a live `$`).

### 5. No `NEXT_PUBLIC_GATEWAY_TOKEN` in the client bundle — FIXED ✅
`gateway.ts:26-28` `gatewayAuthHeaders()` returns `{}` with a GUARD comment
(`:11-25`) forbidding reintroduction of any static secret into this client
module. Grep confirms no `NEXT_PUBLIC_GATEWAY_TOKEN` anywhere in apps/web. BYOK
keys are still only sent to a **loopback** gateway (`gateway.ts:31-38,508-513`).
**Was prior P2.**

### 6. a11y focus rings + consent-dialog focus trap — FIXED ✅
- **Focus rings:** `globals.css:1587-1605` and `3095-3101` — `outline:none` is now
  paired with a visible `box-shadow` ring (`0 0 0 2px bg, 0 0 0 4px purple` /
  `var(--c-focus)`) on `:focus-visible` (keyboard-only). Prior P2 (invisible
  rings) resolved.
- **Consent dialog:** `ConsentDialog.tsx` now has `aria-labelledby`/`aria-describedby`
  (`:39-40` via `useId`), `tabIndex={-1}`, Escape-cancels and focus-trap+restore
  via `useFocusTrap` (`:30`), `data-autofocus` on the primary action (`:67`).
  `useFocusTrap.ts:18-76` implements trap + Esc + initial-focus + restore-to-trigger;
  pure Tab math `trapTabTarget` is unit-tested (`focus-trap.test.ts`). **Was prior P2.**

### 7. Account-delete flow — REAL ✅
`apps/web/app/account/delete/{page.tsx,DeleteAccountWidget.tsx}`. Public page
(Play requires a public deletion URL); widget resolves the signed-in user from the
relay session and **sends no user id** (`:5,40-50`, comment `:15-17`) so it can
only delete the current user. Signed-out → sign-in link + support email fallback;
two-step confirm; honest done/error states. Covered by `account-delete.test.ts`
(passes).

### 8. Capability-honest UI (no dead buttons / fake renders / silent degradation) — HOLDS ✅
Hunted specifically:
- **Report-AI control** now present on web (`MessageBubble.tsx:39-61,188-197`) —
  saved on-device only (parity w/ desktop), honestly described. **Was prior gap #27.**
- **Stop mid-stream** now in Compare (`compare/page.tsx:135-137,274-277`) and
  Research (`research/page.tsx:129-131,195-198`), plus chat Esc/Stop. **Was prior P1.**
- **Private-Mode signal:** `TransparencyStrip.tsx:62-67,91-101` renders
  **"⚠ Private Mode not honored"** when `meta.privacyHonored === false`, with an
  actionable tip — a real honesty signal, not a silent leak. `gateway.ts:563-574`
  parses `private_mode_honored` off the SSE metadata event.
- No reachable money movement: `createCheckout` triple-gated
  (`pricing/page.tsx:112,228/256/304` all `MANAGED_KEYS_AVAILABLE=false` →
  "Coming soon" + disabled) and the relay 503s before Stripe.

---

## Prior P0/P1/P2 — classification

| Prior finding | Class | Evidence |
|---|---|---|
| P0 | (none existed) | — |
| Fake markdown (P1) | **FIXED** | `Markdown.tsx` real parser; `MessageBubble.tsx:87` |
| No per-block code copy (P1) | **FIXED** | `Markdown.tsx:118-140` CodeBlock copy |
| No favicon/manifest (P1) | **FIXED** | `icon.svg`, `apple-icon.tsx`, `manifest.ts` |
| No stop in Compare/Research (P1) | **FIXED** | `compare:274`, `research:195` |
| Report-AI absent on web (#27) | **FIXED** | `MessageBubble.tsx:188-197` |
| Project strategy dead field | **FIXED** (commit `8137fd9`) | not re-deep-verified this session; out of stated claim set |
| Headers Vercel-only (P2) | **FIXED** | `next.config.ts:33-34` headers() on every host |
| Bundle-baked gateway token (P2) | **FIXED** | `gateway.ts:26-28` + guard |
| Focus rings invisible (P2) | **FIXED** | `globals.css:1594,1604,3099` box-shadow ring |
| Consent dialog a11y (P2) | **FIXED** | `ConsentDialog.tsx` + `useFocusTrap.ts` |
| Referral "Earned $X" while gated (P2) | **FIXED** | `billing.ts:42-48` "Coming soon" |
| CSP `script-src 'unsafe-inline'` (P2) | **STILL-OPEN** | `next.config.ts:22`; nonce attempt reverted (`082aee5`), acknowledged in `:5-6` |
| `openBillingPortal` not client-guarded (P2) | **STILL-OPEN (minor)** | `dashboard/billing/page.tsx:216` gates on `tier!=="free"` only; no explicit `MANAGED_KEYS_AVAILABLE` guard. Unreachable by consequence (relay never returns a paid tier while gated) but not defense-in-depth. |

## NEW / coverage gaps (not honesty defects)
- **Markdown tests are thin.** `markdown.test.ts` has 3 cases (fenced code not
  stripped; headings/lists/tables; plain prose). No coverage of `renderInline`
  (bold/inline-code/em/links), blockquote, ordered list, hr, or the CodeBlock
  **Copy** button. The copy path uses `navigator.clipboard` → needs in-browser
  verification.
- **Image canvas path is unverified by tests.** `image-attachments.test.ts:148`
  only exercises the `@zintus/media` Node path (no canvas under bun); the real
  browser path (canvas decode/resize/EXIF-strip + `URL.createObjectURL` preview)
  is untested. **Flag for in-browser verification:** attach PNG/JPEG/WebP, confirm
  thumbnail renders, EXIF badge shows, send produces image blocks, non-vision
  provider warns, gateway 422 renders suggestions.
- **In-browser to confirm:** focus-ring visibility on real controls; consent
  focus trap/Esc/restore behavior; favicon/manifest served and installable.

---

## Verdict
The web surface materially closed every honesty gap the 2026-06-26 audit raised:
markdown is a real renderer with per-code-block copy, the image attachment UX is
honest and complete end-to-end (explicit button → real `@zintus/media` processing
→ `ImageContentBlock` send with no fake `[Image:]` injection → real thumbnail in
both composer and sent bubble → vision-guard + honest 422 surfacing → byte-faithful
regenerate), the referral "Earned" stat reads "Coming soon" while payouts are
gated, the bundle carries no gateway token, focus rings are visible and the consent
dialog is a labelled, Esc-closable, focus-trapped modal, the account-delete page is
public and session-scoped, and the Private-Mode "not honored" warning is a genuine
signal. I found no dead buttons, no fake renders, and no UI claiming a capability
the backend can't honor. Two carryovers remain — CSP still ships `unsafe-inline`
(consciously deferred to a browser-verified nonce change) and `openBillingPortal`
lacks an explicit constant guard (unreachable by consequence) — both minor and
non-blocking. The only real debt is test/in-browser coverage of the markdown inline
path, the code-copy button, and the browser canvas image pipeline. Net: ~9/10,
launch-credible for web BYOK beta.
