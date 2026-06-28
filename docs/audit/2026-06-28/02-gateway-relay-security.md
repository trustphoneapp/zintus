# GATEWAY + RELAY SECURITY — re-verification (2026-06-28)

Branch `feat/multimodal-image-input` @ HEAD `6bcd097` (all scope commits merged to main).
Independent re-audit of the 2026-06-26 report (`../2026-06-26/02-gateway-relay-security.md`).
Method: read ACTUAL source, grepped, ran the targeted suites. Trust-nothing.

## VERDICT ~9.5/10 (was ~8.5). Every launch-relevant P1/P2 in scope is FIXED with code I traced to file:line; no REGRESSIONS; no NEW launch-blockers. The no-custody headline holds and is now even cleaner than before. Residuals are two by-design/cosmetic items (validate-key worker still sees plaintext transiently — inherent to hosted-web BYOK validation, now HONESTLY documented; router `redact.ts` still misses UUID-shaped tokens — negligible). `bun test auth.test.ts handler.test.ts rate-limit.test.ts route-options.test.ts` → **79 pass / 0 fail**.

## NO-CUSTODY PROOF (re-verified, brutal)
- `grep -rniE "decrypt|x25519|privatekey|private_key" workers/relay/src` → **3 hits, ALL comments** asserting the opposite: `tiers.ts:2` ("operator-decryptable … REMOVED"), `GatewaySession.ts:55` ("decrypt or inspect `encryptedKey`" — in a MUST-NOT sentence), `GatewaySession.ts:341` ("NEVER decrypts or inspects … only checks shape, then forwards verbatim"). **Zero executable decrypt paths.**
- Broader sweep `subtle.|deriveKey|importKey|aes|sodium|tweetnacl|ed25519|curve25519|sharedSecret|ecdh` → the ONLY `crypto.subtle` uses are non-custodial: `auth.ts:23` SHA-256 token hash; `billing.ts:147/154` HMAC for Stripe-Signature; `index.ts:143-166` Google ID-token JWT verify (`importKey(..,["verify"])` RS256, verify-only — NOT decryption). `@noble` sits in `node_modules` but is **not imported by any `src/` file.**
- Control channel still shape-checks then forwards verbatim: `GatewaySession.ts:340-359` validates `(action,value)` and `send({type:"control",...body})` — never reads `encryptedKey`. Mobile pushes E2E ciphertext; relay is a dumb pipe.
- Money-movement: `grep "transfer|payout|payment_intent|charge|refund"` in `workers/relay/src` → **0 hits.** Referral commission rows insert ONLY inside `billing.ts:217 checkout.session.completed` — which is unreachable while checkout is 503-gated (below). No payout/transfer code exists.

## MANAGED-KEYS GATE — 503 BEFORE Stripe (re-verified)
`tiers.ts:8 MANAGED_KEYS_AVAILABLE = false`. Route `index.ts:975 POST /api/billing/checkout`:
tier-validate (`:980`) → **`checkoutAvailability(tier)` at `:990`, returns 503 `{managed_keys_unavailable}` at `:991-993`** → user lookup (`:995`) → `createCheckoutSession(...)` at **`:1000`**. The 503 is emitted **10 lines before any Stripe call**; `checkoutAvailability` (`tiers.ts:54-73`) blocks all of starter/growth/scale (the only paid tiers) AND placeholder-price tiers. Double-gated, exactly as the prior report claimed. ✅

## PRIOR FINDINGS — RE-CLASSIFIED

### P1 #1 — LAN-IP bind footgun (`auth.ts:180`) → **FIXED** (`1255f21`, `1f2bd4f`)
New `isLoopbackHost()` (`auth.ts:77-87`) treats only `localhost` / `127.0.0.0/8` / `::1` as loopback; **every** LAN/public IP and hostname is "exposed." `buildGatewayConfig` (`auth.ts:202-210`) **throws** when `!isLoopbackHost(host) && !token`. The old check that only caught `0.0.0.0`/`::` is gone. Covered by tests: `auth.test.ts:82-94` (`192.168.1.5`/`10.0.0.2`/`172.16.4.4` throw; with token they pass) and `:159-181` (`isLoopbackHost` truth table). The "no-Origin curl on a LAN IP" bypass is now structurally impossible — the gateway refuses to start.

### P1 #2 — account-delete leaves gateways connected → **FIXED** (`aea3c26`)
`index.ts:686-704` selects every `gateway_sessions` row for the user and POSTs `/force-disconnect` to each DO **before** the D1 deletes (`:721`). The DO handler `GatewaySession.ts:128-149` closes all `"gateway"` WebSockets, deletes `current_relay_token_hash` from DO storage **and `KV.delete(relay:<hash>)`**, and marks offline. Plus orphan-KV cleanup: `index.ts:709-716` deletes every `referral_code:<code>`; `tombstoneDeletedUser` (`:738`) rejects all still-cached session tokens. Live WS + KV relay token + DO token are all torn down on delete. ✅

### P1 #3 — validate-key plaintext + matrix omission → **FIXED (honesty); residual by design**
The FEATURE-MATRIX omission is corrected: `docs/FEATURE-MATRIX.md:205-206` now explicitly documents "the hosted-web 'test key' path transits a plaintext key to the validate-key worker." `STORE-READINESS.md:49`, `store/review-notes.md:98`, `ios-listing.md:148` all carry the honest "no plaintext keys [except documented exception]" wording. The worker (`workers/validate-key/src/index.ts:82-122`) is minimal, rate-limited (10/min/IP, `:84`), CORS-allow-listed (`:67-78`), and forwards to `provider.validateKey()` — it does NOT persist the key. **Residual (STILL-OPEN, minor):** the plaintext key still transits operator infra transiently (inherent to server-side validation), and the worker's error path returns the provider `error.message` un-redacted (`index.ts:119`). Acceptable + disclosed; not a launch blocker.

### P2 — client error messages un-redacted → **FIXED** (`9a1e1b0`)
`handler.ts` now wraps client-facing error bodies in `redactSecrets` at `:793`, `:891`, `:1017` (SSE error frame), `:1209` (research error event). Imported `:8`. Logs were already redacted.

### P2 — Stripe non-constant-time + no event-id dedup → **FIXED** (`79dcbde`)
`billing.ts:125-158` adds `constantTimeEqual` (WebCrypto-friendly, no `===` shortcut) used for the signature compare at `:158`. Event-id replay dedup at `:207-210`: `stripe_evt:<event.id>` KV key, ACK-200 on duplicate, TTL `STRIPE_EVENT_DEDUP_TTL_SECS`. D1 writes remain `ON CONFLICT`-idempotent as defense-in-depth.

### P2 — `NEXT_PUBLIC_GATEWAY_TOKEN` baked into public bundle → **FIXED in source** (`bbd7a85`)
`apps/web/lib/gateway.ts:26-28 gatewayAuthHeaders()` returns `{}` with an explicit GUARD comment (`:23`) forbidding reintroduction of the env var. No source file references `process.env.NEXT_PUBLIC_GATEWAY_TOKEN` (the only two hits are those guard comments). NOTE: a STALE `.next/` build (timestamp 01:51, **before** the 02:26 source edit; gitignored, never committed) still contains `NEXT_PUBLIC_GATEWAY_TOKEN?.trim()||""` — but with the env var unset it inlined to `""`, so even that artifact baked **no token value**. A clean rebuild emits nothing. Not shipped.

### P2 — orphan KV `referral_code:<code>` after delete → **FIXED** (`aea3c26`, `index.ts:709-716`, see P1 #2).

### Prior "missing" P1 — relay backup/restore did not exist → **FIXED / NEW capability** (`93e7105`)
`scripts/relay-backup.sh` (D1 `wrangler d1 export` + per-key KV dump → `{key,value}[]`), `scripts/relay-restore-drill.sh`, and `.github/workflows/backup-relay.yml` (daily backup + automatic restore drill). DOs intentionally excluded (self-healing) with a documented rationale (`relay-backup.sh:8-11`). The prior report's biggest cross-surface gap in this scope is closed.

### STILL-OPEN (negligible, unchanged)
- `timingSafeEqual` early-returns on length mismatch (`auth.ts:7-9`) — leaks token *length*, not bytes. Cosmetic.
- Router `redact.ts:19-27` covers provider-key formats (`sk-`,`csk-`,`AIza`,`gsk_`,`whsec_`,`xai-`,`hf_`…) but still **misses UUID/opaque session-relay-gateway tokens**. Low impact (those tokens aren't typically embedded in upstream provider error strings). Worth a follow-up regex.
- `www.zintus.ai` remains a trusted gateway origin (`auth.ts:54`) — by-design for the official web app; out of pure gateway/relay remediation scope (web CSP owns the XSS-pivot half).
- Relay KV rate-limits remain best-effort/eventually-consistent (`rate-limit.ts`) — dampening, not hard caps. Accepted by design; mutating routes also gated by SameSite=Lax + CORS allow-list.

## BYPASS ATTEMPTS (re-verified against `handler.ts:1269-1287` + `auth.test.ts`/`handler.test.ts`)
`evil.com → 403`, `Origin:null → 403`, exact-match origins only (no wildcard), `localhost.evil.com → 403`. Confirmed by `handler.test.ts:59-82` ("loopback gateway 403s a disallowed Origin; allows allowed + no-Origin"). No-Origin requests (CLI/server) pass **by design** — and that path is no longer a footgun because a non-loopback bind without a token now refuses to start. `localhost:any-port` allowed (inherent loopback trust). PNA preflight still [HUMAN]-verify in a real Chrome.

## TEST / COVERAGE NOTES
- `bun test apps/gateway/src/{auth,handler,rate-limit,route-options}.test.ts` → **79 pass, 0 fail, 389 assertions**.
- Strong coverage: LAN-bind refusal, `isLoopbackHost`, Origin-403 CSRF guard, checkout 503-gate (relay `tiers`), Stripe constant-time/dedup, route-options.
- Gaps (acceptable, note for completeness): the DO `force-disconnect` handler and the account-delete fan-out are not unit-tested in this run (would need a Workers/DO harness); the validate-key worker has no test for its un-redacted error path; PNA preflight is human-only.

## VERDICT (one paragraph)
Re-verified against real code, the gateway+relay surface is launch-grade on the dimensions this audit exists to protect: **no custody is provable** — zero executable decrypt/x25519/private-key paths in the relay (the only three grep hits are comments asserting the prohibition), the sole asymmetric crypto is Google-JWT *verification*, and no money-movement code exists; the **managed-keys checkout returns a 503 a full ten lines before any Stripe call** and is double-gated; the **LAN-IP-without-token footgun is structurally closed** (the gateway throws on startup, tested); **account deletion now force-disconnects live gateway sessions and revokes the relay token in DO storage + KV**; browser CSRF/denial-of-wallet is still 403'd on every forged-Origin attempt; client-facing errors are redacted; Stripe is constant-time with replay dedup; the public bundle bakes no gateway token; and **relay backup/restore now exists with a CI-driven restore drill**. The only residuals are a transient, honestly-documented plaintext-key transit through the hosted-web validate-key worker and a UUID-token gap in the router redactor — neither is a launch blocker. I would ship this scope at ~9.5/10.
