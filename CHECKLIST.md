# Zintus — Readiness Checklist

Audit date: June 16, 2026
Repo: `/Users/yashwanthsurabhi/Projects/zintus`

Legend: ✅ done · 🟡 partial / needs config · ❌ missing

This is an honest status sheet, not a sales sheet. "Done" means the behavior
exists in code and is covered by `bun run typecheck` + `bun run test`. Anything
that needs external accounts, secrets, or signing is marked 🟡/❌ even if the
code path is wired.

---

## Core engine & routing

| Item | Status |
|------|--------|
| 12 providers (10 OpenAI-compat via factory + Gemini + Ollama) | ✅ |
| `fastest` = **real latency** (p95 over recent successes), not static priority | ✅ |
| `weighted` / `capability` strategies; per-request strategy override | ✅ |
| `economy` = **cheapest paid-equivalent model with quota left** (cost-ranked, quota-aware: low-quota providers demoted behind healthy ones) | ✅ |
| **Same-model multi-provider failover** (model groups via `policy.json`) | ✅ |
| Declarative `policy.json` (priority/weights/groups/fallbacks/limits) + **hot-reload** | ✅ |
| Failover on 429/5xx, **cooldown for all providers** (not just Groq) | ✅ |
| **Health-aware routing**: demote providers with a recent error streak | ✅ |
| Groq 70B→8B in-request retry + `x-ratelimit-*` rolling reset | ✅ |
| Sticky provider affinity per thread (30-min TTL) | ✅ |
| Quota ledger: **daily + rolling-minute (TPM/RPM)** windows | ✅ |
| **Zero-cost failed requests** (errors don't debit token budget) | ✅ |
| **Provable savings**: $ avoided vs paid-API pricing, valued **per-model** (Groq 8B vs 70B, OpenRouter `:free` tiers), estimate | ✅ |
| Real provider `usage` accounting; tagged estimate fallback | ✅ |
| Virtual keys: per-key daily **+ rolling 60s RPM/TPM** limits | ✅ |
| Two-tier cache: L1 SHA-256 exact + L2 `sqlite-vec` (env-gated, TTL, bypass) | ✅ |
| Memory: deterministic summary + regex facts; opt-in LLM (`MEMORY_LLM=1`) | ✅ |
| Context compiler (Fast/Smart/Deep budgets) | ✅ |
| Local execution checkpoints (`thread_id` + serialized state) | ✅ |

---

## Gateway (single source of truth)

| Item | Status |
|------|--------|
| Bun HTTP gateway over `@zintus/engine` | ✅ |
| Loopback by default; refuses public bind without `GATEWAY_TOKEN` | ✅ |
| Bearer auth on all routes except `/health`, `/metrics` | ✅ |
| Clients (web/desktop/mobile) send bearer when token configured | ✅ |
| Restrictive CORS via `GATEWAY_CORS_ORIGIN` | ✅ |
| Body-size (413), message-count (413), timeout (408) limits | ✅ |
| `virtual_key` + `provider_weights` + `strategy` on `/v1/chat/completions` | ✅ |
| `Cache-Control: no-cache` request header bypasses the response cache | ✅ |
| `X-Provider-Used` / `X-Cache-Hit` / `X-Failover-Count` headers | ✅ |
| `/health` exposes per-provider quota/cooldown **+ estimated $ saved** | ✅ |
| `GET /v1/traces?limit=N` (trace list) + `GET /v1/savings` (auditable $ saved) | ✅ |
| Prometheus `/metrics` + request traces | ✅ |
| **OpenTelemetry** OTLP/HTTP trace export (env-gated `OTEL_EXPORTER_OTLP_ENDPOINT`) | ✅ |
| Background **provider health probe** (env-gated `PROVIDER_PROBE_INTERVAL_MS`) | ✅ |

---

## Clients

| Item | Status | Notes |
|------|--------|-------|
| **CLI** — chat/status/keys/config, Ink dashboard, OS keychain | ✅ | Most complete client. Honest `fastest` hint; `status`/`chat` show estimated $ saved. **Working git diff included by default** (`--no-diff` to opt out); `--workspace` for codebase context. **Guided `setup` wizard** (free-key URLs, inline validation w/ retry); zero-config nudge to `setup` when no keys. **`zintus serve` runs the gateway** the GUIs connect to. Cross-OS DB paths; requires Bun. |
| **Web** (Next.js 16) — chat via gateway, AES-256-GCM key vault | ✅ | Strategy + default-provider now reach the gateway; Providers/Usage show real quota+cooldown + $ saved; loading/disabled/focus states. **"Gateway offline — run `zintus serve`" banner** when `/health` is unreachable. Neutral pro UI. |
| **Desktop** (Tauri 2) — chat via gateway, OS keyring commands | ✅ | Honest `fastest` copy; savings on Usage; multi-turn chat with message bubbles + streaming; strategy wired. **Gateway-offline banner** with `zintus serve` hint. Neutral pro UI. |
| **Mobile** (Expo SDK 56) — chat via gateway, SecureStore keys | ✅ | Gateway-`/health` quota+savings (local `expo-sqlite` fallback); strategy selector; "Auto" routing; chat polish. **Gateway-offline banner** (reminds to set `EXPO_PUBLIC_GATEWAY_URL` to a LAN IP, not localhost). Neutral pro UI. Copy uses native Share (true clipboard needs `expo-clipboard`). |
| `release-desktop.yml` / `release-mobile.yml` workflows present | 🟡 | Present, but unsigned / unconfigured (see blockers). |

**Quota storage per platform (accurate):** gateway/CLI → Drizzle `bun:sqlite`
(`quota.db`); desktop → reads gateway `/health` (no local ledger); mobile →
`expo-sqlite`. All decisions go through `@zintus/router/quota-core`. There is
**no Tauri `rusqlite`** — the desktop Rust backend only exposes keyring commands.

---

## CI & tests

| Item | Status |
|------|--------|
| `bun run typecheck` (root build + web/desktop/mobile) | ✅ |
| `bun run test` (router, engine, cache, memory, gateway, web) | ✅ |
| Router tests: cooldown, latency `fastest`, model groups, policy, probe, vkey RPM | ✅ |
| **Failover integration**: engine + gateway (real engine, 429→failover, L1 cache) | ✅ |
| Provider **VCR fixture** tests (recorded SSE, no network) — Groq/Gemini/OpenRouter | ✅ |
| OpenTelemetry payload + no-op-when-disabled tests | ✅ |
| Gateway handler tests (bearer, 413, 408, headers, key passthrough, trace list) | ✅ |
| **128 tests** (17 vitest + 106 bun + 5 integration), 0 fail | ✅ |
| GitHub Actions: typecheck + test + CLI smoke + **gateway load smoke** | ✅ |
| **GHCR release** workflow (`release-gateway.yml`: tag → Docker image) | ✅ |
| Live-provider E2E in CI (Groq + **Gemini + OpenRouter**) | 🟡 env-gated, opt-in; skipped without secrets |

---

## Remaining blockers (manual / external — none block gateway+web)

| Blocker | Action |
|---------|--------|
| Live API keys | Add per provider via CLI `keys set` / web vault / mobile SecureStore |
| Full **Xcode** + CocoaPods (this env only has Command Line Tools) | Required for a local iOS simulator/device build |
| EAS `projectId` (not yet set) | Run `eas init` (needs Expo login) to mint it |
| App Store / Play submit credentials in `eas.json` | Fill Apple ID, ASC app ID, Google SA key |
| `WORKER_VALIDATE_URL` on Vercel | Point at deployed Cloudflare worker |
| Tauri code signing | Configure `TAURI_SIGNING_*` secrets for releases |
| Desktop PTY: `tauri-pty` JS `0.1.1` + `tauri-plugin-pty` Rust `0.3` | Conventional Tauri-v2 pairing; API usage in `TerminalPane.tsx` is correct. Needs a Rust/Tauri build to verify at runtime (no toolchain in this env) |
| Branded app icons | Replace generated placeholders with final art |

---

## Verify

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/yashwanthsurabhi/Projects/zintus
bun install
bun run typecheck   # ✅ passes
bun run test        # ✅ passes (vitest + bun 1.3.x)
```
