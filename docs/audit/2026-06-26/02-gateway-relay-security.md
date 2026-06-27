# GATEWAY + RELAY SECURITY agent report (a707b75b1b74a1f5f)

## VERDICT ~8.5/10. Default posture (127.0.0.1 bind, loopback CORS, 403-on-bad-Origin, relay=ciphertext-only, paid 503-gated) has NO launch-blocking P0. Worst residual: GATEWAY_HOST=routable LAN IP without token NOT refused (auth.ts:180 only checks 0.0.0.0/::); no-Origin LAN client bypasses CORS/Origin guard → open denial-of-wallet + prompt/response exposure on LAN. 2 honesty gaps: hosted-web validate-key puts plaintext keys on operator infra; relay /control channel prompt-capable by design (only client convention keeps prompts off relay).

## THREAT TABLE
- Local CSRF/denial-of-wallet (malicious site no-cors POST localhost): handler.ts:1125-1143 403 on disallowed Origin + auth.ts:81-93 loopback CORS → ✅ CLOSED for browsers (Origin unforgeable).
- LAN exposure (GATEWAY_HOST=192.168.x no token): auth.ts:180-186 refuses only 0.0.0.0/:: → **explicit LAN IP not refused; no-Origin curl bypasses CORS → P1**.
- Key leakage in errors: logs redacted index.ts:75 but **client-facing error.message NOT redacted** (handler.ts:1344,1348,879,775) → P2.
- Relay key custody: GatewaySession.ts:55-79,359 forwards opaque ciphertext never decrypts; tiers.ts:8 managed-keys removed → ✅ none.
- Prompts to relay: shipped clients POST chat direct to gateway (mobile/lib/chat.ts:53) BUT /control forwards any value verbatim → relay-CAPABLE not relay-blocked → P1.
- Plaintext key to server: plaintext transits /api/validate→validate-key worker → P1.
- Paid overflow bypass: tiers.ts:54-73 503 before Stripe, index.ts:953 pre-createCheckoutSession → ✅ double-gated.
- PNA HTTPS→HTTP localhost: OPTIONS 204 but NO Access-Control-Allow-Private-Network → over-blocks (safe) but may break official web app → P2/[HUMAN].

## P1
1. LAN-IP bind footgun auth.ts:180: exposesNetwork misses explicit LAN IPs; tokenless+LAN-IP=open gateway (no-Origin curl skips handler.ts:1127 guard, no token→bearerAuthorized true). Fix: refuse any non-loopback host unless GATEWAY_TOKEN. Test buildGatewayConfig({GATEWAY_HOST:"192.168.1.5"}) throws.
2. Account deletion leaves gateways connected: relay index.ts:634-717 resetQuota+tombstone+cookie-revoke but never loops user's gateway_sessions to /force-disconnect (per-session DELETE does, :769). Active WS + KV relay:<hash> (1h TTL) + DO current_relay_token_hash survive deletion. Fix: fan out force-disconnect before D1 delete.
3. validate-key plaintext on operator infra: apps/web/app/api/validate/route.ts + workers/validate-key. Hosted web can't validate without shipping plaintext to server (SECURITY.md:94-99 honest; **FEATURE-MATRIX:139-140 "keys only loopback/E2E" OMITS it**). Fix: validate locally on gateway (already holds key) or document 3rd key channel. validate-key error path also returns provider error.message un-redacted.

## P2
- Client error messages un-redacted (handler.ts catch) — run redactSecrets.
- Stripe sig compare non-constant-time expectedHex===v1 (billing.ts:133) + NO event-id dedup (replays in 300s re-run; mostly idempotent via ON CONFLICT).
- timingSafeEqual leaks token length (auth.ts:7).
- NEXT_PUBLIC_GATEWAY_TOKEN baked into public bundle → with token set CORS becomes * (auth.ts:108), token readable, any origin can drive gateway.
- www.zintus.ai trusted gateway origin (auth.ts:54) + web CSP script-src 'unsafe-inline' → stored XSS on web pivots to user's local gateway.
- Orphan KV referral_code:<code> after delete (index.ts:691 drops D1 not KV).
- redact.ts misses UUID-form secrets (session/relay/gateway tokens, OAuth code/id_token).
- Relay KV rate limits eventually-consistent best-effort (rate-limit.ts) — dampening not hard caps. Mutating relay routes rely on SameSite=Lax + CORS allow-list (adequate).

## NO-CUSTODY PROOF: relay never decrypts (GatewaySession.ts:55-79 shape-check only "MUST NOT decrypt", :359 forwards verbatim; grep decrypt|x25519|privateKey workers/relay/src = ZERO hits); tiers.ts:1-8 operator-decryptable path REMOVED, MANAGED_KEYS_AVAILABLE=false. No money moves: referral.ts mints codes only; commission rows insert only billing.ts:190 checkout.session.completed (unreachable while 503-gated); no transfer/payout. Mobile pushes E2E ciphertext (gateway-key-push.ts:76 encryptForGateway). EXCEPTION: validate-key worker sees plaintext transiently.

## BYPASS ATTEMPTS: evil.com→403, Origin:null→403, evil.zintus.ai→403 (exact match no wildcard), localhost.evil.com→403. Missing Origin (curl/CLI)→passes BY DESIGN (but + LAN-IP bind = P1). localhost:any-port→allowed (inherent loopback trust). PNA preflight unverifiable without real Chrome [HUMAN].

## COMPAT: localhost✅ CLI(no Origin)✅ Tauri(tauri://localhost)✅ assuming webview emits real Origin not null [HUMAN verify] · mobile LAN direct, needs token if not loopback✅ · browser HTTPS→HTTP localhost PNA may block even www.zintus.ai (no Allow-Private-Network) [HUMAN verify current Chrome].

## HARDENED DEFAULTS: auth.ts refuse non-loopback host without token; emit Allow-Private-Network only for allow-listed origins on OPTIONS; wrap client errors in redactSecrets; account-delete force-disconnect+relay-token revoke per session + delete KV referral map; never ship NEXT_PUBLIC_GATEWAY_TOKEN to public bundle; CSP off unsafe-inline; Stripe constant-time + event-id dedup.

## HUMAN: 1 Tauri build confirm Origin tauri://localhost not null. 2 Chrome confirm HTTPS www.zintus.ai→http://localhost:8788 survives PNA. 3 DEPLOY DRIFT: CLI/validate URL https://relay.zintus.ai/validate (cli/src/commands/keys.ts:8) has NO matching relay route — verify validate-key worker hostname or CLI falls back local-only.
