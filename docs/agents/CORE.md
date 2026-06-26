# CORE Agent

**Owns:** `packages/router`, `packages/tokzen`, `packages/engine`, `packages/crypto-e2e`, `packages/schemas`, `packages/providers`
**Risk:** HIGH — every AI request flows through here. A bug affects every user on every request.

## Source of truth (re-verify here; don't trust this doc blindly)
| Fact | Where |
|---|---|
| Quota compression levels | `packages/tokzen/src/quota/controller.ts` (`getLevel`) + `quota/dial.ts` |
| `compress()` return type | `packages/tokzen/src/pipeline/types.ts` (`CompressResult`) |
| Provider priority (default) | `policy.example.json` → `providerPriority` |
| Circuit breaker / half-open | `packages/router/src/factory.ts` |
| In-flight reservation | `packages/router/src/inflight.ts` |
| E2E crypto | `packages/crypto-e2e/src/index.ts` |
| Secret redaction | `packages/router/src/redact.ts` (`redactSecrets`) |

## Decisions you must NOT reverse

### Quota compression levels — REAL thresholds
`controller.ts:getLevel(quotaRemaining)`:
```
> 0.5  → Level 1 (CacheAligner only, no content compression)
> 0.3  → Level 2 (+ JSON/log/diff, no CCR)
> 0.15 → Level 3 (+ code compression, CCR for history)
else   → Level 4 (+ prose, aggressive CCR, optional ML)   # includes NaN
```
These are `0.5 / 0.3 / 0.15`. Do NOT change to `0.50 / 0.20 / 0.05`.

### `compress()` return shape — REAL shape
Top level: `{ messages, totalResult, systemPrompt?, tools? }`.
`totalResult` is a `CompressResult` (`pipeline/types.ts`):
`{ originalTokens, compressedTokens, ratio, transforms: string[], ccrHashes: string[], cacheHit: boolean }`.
There is **no** `metrics`, `mode`, or `level` field. To tell what ran, inspect
`transforms[]` (e.g. `"ast-signature"` / `"text-signature"`).

### Provider priority — REAL default order (12, from `policy.example.json`)
```
cerebras → groq → gemini → fireworks → xai → huggingface →
openrouter → cohere → mistral → deepseek → lmstudio → ollama
```
This is the *provider* order. "Groq 70B → Groq 8B" is **model-group failover**
(a different mechanism — `modelGroups` in policy, e.g. `llama-3.3-70b`), not
provider priority. The order is **hot-reloadable** via `policy.json` (root,
`~/.zintus/policy.json`, or `$ZINTUS_POLICY`); strategy (`fastest` default,
`weighted`, `economy`, latency) can reorder at runtime.

### In-flight quota reservation — no mutex
`inflight.ts` closes the concurrent-overshoot race (the ledger only debits after
a response drains). `tryReserve` is **fully synchronous with no `await` inside**,
so read-decide-reserve is atomic on the JS event loop. **Do NOT add async-mutex
or external locking** — it's single-threaded by design. It gates on
`requestsPerMinute / tokensPerMinute / requestsPerDay / tokensPerDay`.

### Circuit breaker — NOT a textbook CLOSED/OPEN/HALF_OPEN FSM
Real mechanism (`factory.ts`): cooldown + an error-streak threshold
(`ERROR_STREAK_THRESHOLD = 3` in a `5 * 60_000` ms window) + a half-open probe
`Set`. A provider with *recent* errors (recovering, still below the threshold)
admits **one** in-flight probe at a time; healthy providers (zero recent errors)
are never gated. Test against this real mechanism, not a generic FSM.

### E2E encryption — exact
`crypto-e2e/src/index.ts`: x25519 ECDH (`@noble/curves`) → HKDF-SHA256 with
`info = "zintus-relay-e2e-v1"` (`@noble/hashes`) → AES-256-GCM (`@noble/ciphers`,
16-byte tag appended to ciphertext). `@noble` only (pure JS, React-Native-safe;
WebCrypto x25519 is NOT available in RN). The relay sees **only opaque
ciphertext** — never plaintext. The HKDF `info` string MUST stay byte-identical
across gateway, mobile, and web.

### Never
- Log API keys — use `redactSecrets()` (`router/src/redact.ts`).
- Add synchronous blocking in async paths.
- Mock the function under test.

## Before you start
1. Read the relevant source file completely.
2. `bun run test packages/<pkg>/` and show what the function actually does.
3. Only then write code.

## When you're done
- [ ] `bun run test` — 0 failures (not below `main`, see RULES.md)
- [ ] `bun run typecheck` — 0 errors
- [ ] `git switch -c <branch>` → commit `type(scope): …` → push → open PR (don't merge)
