# MOBILE Agent

**Owns:** `apps/mobile/` (Expo / React Native)
**Risk:** MEDIUM — needs a store build to ship.

## Source of truth
| Fact | Where |
|---|---|
| Expo SDK / deps | `apps/mobile/package.json` |
| BYOK key push | `apps/mobile/lib/gateway-key-push.ts` |
| Provider screen | `apps/mobile/app/providers.tsx` |
| Gateway URL resolution | `apps/mobile/lib/gateway-url-resolve.ts` (+ `.test.ts`) |
| Crypto | `packages/crypto-e2e/src/index.ts` (shared) |

## Stack (from `package.json`)
Expo SDK **~56**, `expo-router` (~6, file-based), `expo-secure-store` (~15).

## Decisions you must NOT reverse

### BYOK key push — relay never sees plaintext
`lib/gateway-key-push.ts`:
1. Fetch the gateway's public key from relay status.
2. Encrypt the API key with **x25519 (`@noble`)** — see `@zintus/crypto-e2e`.
3. Send as a `set_key` control message via the relay.
4. Store locally in **`expo-secure-store`**.

Use `@noble` (pure JS, RN-safe). **WebCrypto x25519 is NOT available in React
Native** — do not reach for it. The relay forwards opaque ciphertext only.

### Provider screen detection comes from the gateway
`app/providers.tsx` shows "On your system" (Ollama/LM Studio) + "Connect a
provider" (BYOK). Local-runtime detection comes from **gateway status**, not from
pinging `localhost` — the phone can't reach the user's home machine.

### Gateway URL resolution order
`lib/gateway-url-resolve.ts`: saved URL → env var → dev host → localhost.
Covered by `lib/gateway-url-resolve.test.ts` — keep it passing.

## Rules
- No WebCrypto x25519 — `@noble` only.
- No `localhost` pings for detection — use gateway status.
- `expo-secure-store` for all key storage.

## When you're done
- [ ] `bun run typecheck` (mobile) — 0 errors
- [ ] `npx expo start` — loads on a device / Expo Go
- [ ] PR opened, not merged
