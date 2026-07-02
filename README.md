# Zintus

Cross-platform AI router — routes chat requests across 22 providers (Cerebras, Groq, Gemini, OpenRouter, Cohere, Mistral, DeepSeek, Fireworks AI, xAI Grok, Hugging Face, Together AI, SambaNova, NVIDIA NIM, Novita, Moonshot/Kimi, Z.ai GLM, Qwen, OpenAI, Anthropic, Perplexity, LM Studio, Ollama) with quota-aware failover. The 10 providers added 2026-07-02 are declared in a single manifest entry each (`packages/providers/src/manifest.ts`) and served by the shared OpenAI-compat adapter; they are unit-tested but awaiting their first keyed live smoke.

## What this is (and isn't)

**Zintus is a local-first, BYOK router that maximizes free-tier quotas across 22 providers** — automatic same-model failover, cooldown, health-aware routing, transparent quota bars, and an estimate of the money you'd otherwise have spent on paid APIs. Paid keys you already own (OpenAI, Anthropic, Perplexity) route through the same quota-aware engine. Your keys live in your OS keychain (CLI/desktop) or your browser (web); there is **no SaaS bill and no hosted control plane**.

**Who it's for:** individuals and small teams who want to stretch free tiers across many providers from one OpenAI-compatible endpoint, self-hosted.

**Who it's *not* for:** enterprises needing multi-tenant SaaS, RBAC/SSO, 100+ providers, SOC2, or a hosted gateway. For those, use LiteLLM/Portkey. This project deliberately does **not** chase that lane.

Notes: grades reflect *this lane only*. LiteLLM/Portkey/OpenRouter are stronger on breadth (provider count, enterprise features). "$ saved" is a deliberately conservative estimate (see `PAID_EQUIVALENT_USD_PER_MTOK`), not a billing guarantee.

### Provable savings

Every free-tier token served is valued at what an equivalent paid API would have charged, summed per provider. The gateway exposes it at the auth-gated `GET /v1/status` (`savings.estimatedUsdSaved`, plus a focused `GET /v1/savings`) and the web **Usage** page renders it. (`GET /health` is now a minimal, unauthenticated liveness probe — savings and provider topology moved behind auth to avoid disclosure.) It is an *estimate*, labelled as such.

### Declarative routing (`policy.json`)

Provider priority, weights, model groups, fallbacks, and per-provider quota limits live in a single `policy.json` (repo root, `~/.zintus/policy.json`, or `$ZINTUS_POLICY`). The gateway loads it at startup and **hot-reloads on change** — no restart needed.

```bash
# Start from the example (no secrets in it):
cp policy.example.json ~/.zintus/policy.json
# edit, save — the running gateway picks it up automatically.
```

In Docker, mount it read-only (already wired in `docker-compose.yml`):
`-v "$PWD/policy.json:/app/policy.json:ro"`.

```mermaid
flowchart LR
  CLI & Web & Desktop & Mobile --> GW[Gateway /v1]
  GW --> ENG[Engine]
  ENG --> RT[Router: policy, latency, cooldown, quota ledger]
  RT --> P[(22 providers)]
  RT -. policy.json hot-reload .-> RT
```

## Self-host with Docker

One command, no SaaS — the gateway runs locally and your keys stay on the host.

```bash
# 1. Routing policy (no secrets in it):
cp policy.example.json policy.json

# 2. Bring up the gateway on :8788 (keys + quota.db persist in the
#    `zintus-data` named volume; the container runs as the non-root `bun` user):
GATEWAY_TOKEN=$(openssl rand -hex 24) docker compose up -d

# 3. Verify:
curl -s localhost:8788/health | jq      # { "ok": true, "draining": false }  (minimal liveness)
# Savings + provider topology are auth-gated:
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" localhost:8788/v1/status | jq   # { ... "savings": {...} }

# 4. Add provider keys (free tiers) — either via env on the container,
#    or mount your CLI keychain dir at /home/bun/.zintus.
```

> **Exposing it beyond loopback?** Read [`docs/DEPLOY.md`](docs/DEPLOY.md) first —
> a network-exposed gateway requires `GATEWAY_TOKEN` and should set
> `GATEWAY_RATELIMIT_RPM`, TLS, and CORS.

Prebuilt images are published to GHCR on each `v*` tag
(`ghcr.io/<owner>/zintus-gateway`):

```bash
docker pull ghcr.io/<owner>/zintus-gateway:latest
# The container runs as the non-root `bun` user (uid 1000); state lives at
# /home/bun/.zintus. A bind-mounted host dir must be writable by uid 1000.
docker run -p 8788:8788 -e GATEWAY_TOKEN=secret \
  -v "$HOME/.zintus:/home/bun/.zintus" \
  -v "$PWD/policy.json:/app/policy.json:ro" \
  ghcr.io/<owner>/zintus-gateway:latest
```

Point any OpenAI-compatible client at `http://localhost:8788/v1` with
`Authorization: Bearer $GATEWAY_TOKEN`.

## Monorepo layout

| Path | Description |
|------|-------------|
| `packages/types` | Shared TypeScript types |
| `packages/providers` | Provider adapters (OpenAI-compat + Gemini + Ollama) |
| `packages/router` | Priority routing, failover, Drizzle quota ledger, Groq rolling-window cooldown |
| `packages/engine` | Shared orchestration engine used by gateway/web |
| `packages/memory` | Memory extraction + summary utilities and memory store |
| `packages/context-compiler` | Prompt context assembly from episodic history + memory |
| `packages/keychain` | OS keyring wrapper (`@napi-rs/keyring`) |
| `apps/cli` | Commander CLI with Ink status dashboard |
| `apps/gateway` | Bun gateway service using the shared engine |
| `apps/web` | Next.js 16 web app (Vercel-ready) with Web Crypto key vault |
| `apps/desktop` | Tauri 2.10 + Next.js 16 desktop shell |
| `apps/mobile` | Expo SDK 56 mobile app |
| `workers/validate-key` | Cloudflare Worker (Hono) key validation proxy |

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- macOS/Linux recommended for keychain support
- Optional: Rust toolchain for Tauri desktop builds
- Optional: Expo Go / simulators for mobile

## Quick start

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run typecheck
bun run test
```

## Run commands

### CLI

```bash
cd apps/cli
bun run dev -- --help
bun run dev -- keys set groq gsk_your_key_here
bun run dev -- config
bun run dev -- status
bun run dev -- "Hello from Zintus"
```

From repo root:

```bash
bun run dev:cli -- keys list
```

### Web (Next.js 16, Vercel-ready)

Start the gateway first, then run web. The GUI is a thin client over the
gateway — if it isn't running, every screen shows a "Gateway offline — run
`zintus serve`" banner.

```bash
# terminal 1 (repo root)
zintus serve          # or: bun run dev:gateway
```

```bash
# terminal 2
cd apps/web
bun install
bun run dev
# http://localhost:3000/chat
```

API routes:

- `POST /api/chat` — stream chat via `@zintus/router`
- `POST /api/validate` — validate provider keys (local or via `VALIDATE_WORKER_URL`)

### Gateway (Bun + engine)

The gateway is the single stateful "brain" the GUI clients connect to. Start it
with the CLI:

```bash
zintus serve                 # 127.0.0.1:8788 by default
zintus serve --port 9000     # or pick a port / --host
```

Equivalent dev scripts:

```bash
bun run dev:gateway          # repo root
# or
cd apps/gateway && bun run dev
```

`POST /v1/chat/completions` accepts the OpenAI-style `messages`/`stream` plus
`provider`, `mode`, `thread_id`, and the routing controls `virtual_key`
(per-key quota/rate limit) and `provider_weights` (weighted load balancing).
Responses carry routing metadata headers: `X-Provider-Used`, `X-Cache-Hit`
(`L1`/`L2`/`miss`), and `X-Failover-Count`. Requests are bounded by
`GATEWAY_MAX_BODY_BYTES` (413), `GATEWAY_MAX_MESSAGES` (413), and
`GATEWAY_REQUEST_TIMEOUT_MS` (408) — see `apps/gateway/.env.example`.

Deploy to Vercel from `apps/web` (see `vercel.json`). The web app is a thin
gateway client: it never bundles the router/engine and `/api/chat` is a `503`
stub pointing at the gateway. Keys are encrypted in the browser with Web Crypto
(AES-256-GCM + PBKDF2) before `localStorage` persistence.

### Desktop (Tauri 2.10 + Next.js 16)

```bash
cd apps/desktop
bun install
bun run dev          # Next.js shell on :3001
bun run tauri:dev    # Tauri window (needs Rust + tauri-cli)
```

Pages: `/chat`, `/terminal` (xterm.js + tauri-plugin-pty), `/providers` (OS keyring), `/usage`, `/settings`.

### Mobile (Expo SDK 56)

```bash
cd apps/mobile
bun install
bun run start
```

Chat UI with provider bottom sheet; API keys stored in `expo-secure-store`.

### Validate-key worker (Hono 4.12+)

```bash
cd workers/validate-key
bun run dev      # wrangler dev
bun run deploy
```

`POST /validate` with `{ "providerId": "groq", "key": "..." }`. Rate limited to **10 req/IP/min** via the Cloudflare native rate-limiting binding (`RATE_LIMITER` in `wrangler.toml`), enforced across edge isolates. Restrict CORS with the `ALLOWED_ORIGINS` var.

Point the web app at your deployed worker:

```bash
VALIDATE_WORKER_URL=https://your-worker.workers.dev bun run dev
```

## Provider notes

- **Groq** parses `x-ratelimit-*` headers and applies rolling-window cooldown in the quota ledger.
- **LM Studio** requires no API key; uses `LM_STUDIO_HOST` (default `http://localhost:1234/v1`).
- **Ollama** requires no API key; uses `OLLAMA_HOST` (default `http://localhost:11434`).
- Keys are stored in the OS keychain via CLI/desktop; web uses AES-256-GCM in `localStorage` (see [SECURITY.md](SECURITY.md)); mobile uses SecureStore.

## Token accounting

Token usage is read from each provider's reported `usage` (OpenAI-compatible
`stream_options.include_usage`, Gemini `usageMetadata`, Ollama
`prompt_eval_count`/`eval_count`) and recorded in the quota ledger as real input
+ output tokens. When a provider reports no usage, a clearly-marked local
estimate (`source: "estimate"`) is used as a fallback. Quota decisions live in a
single shared module, `@zintus/router/quota-core`. The gateway and CLI own
the authoritative ledger (`bun:sqlite`); the desktop app reads provider/quota
status from the gateway's `/health` endpoint (it runs no router of its own); and
mobile persists its own ledger in `expo-sqlite`. All of them make quota
*decisions* through the same `quota-core` functions so behavior cannot drift.

## Security

The gateway binds to `127.0.0.1` by default and refuses to bind to a public
interface without `GATEWAY_TOKEN` set; when set, all endpoints except `/health`
and `/metrics` require `Authorization: Bearer <token>`, which the web, desktop,
and mobile clients send when their `*_GATEWAY_TOKEN` env var is configured. CORS
is restricted to `GATEWAY_CORS_ORIGIN`, and request body size, message count,
and time-to-first-token are bounded. See [SECURITY.md](SECURITY.md) for the full
threat model and `apps/gateway/.env.example` for configuration.

## Production readiness

"Product-ready" here means a **gateway + one client** can ship against live API
keys. The bar:

- ✅ Cooldown/failover works for **all** providers (not just Groq) — a
  rate-limited provider is skipped on the next request.
- ✅ One routing implementation. The gateway/engine is the single source of
  truth; web and desktop are gateway-only clients (no parallel router).
- ✅ Gateway hardened: bearer auth end-to-end, restrictive CORS, body/message/
  timeout limits, `virtual_key` + `provider_weights` exposed, routing-metadata
  response headers.
- ✅ Cache behavior documented (L1 exact + L2 semantic) and quota storage
  described per platform.
- ✅ `bun run typecheck` and `bun run test` green in CI.

Recommended first platform to ship: **gateway + web** (Vercel) or
**gateway + CLI**. Still required before an app-store/native release (none are
blockers for the gateway+web path): EAS `projectId`, store credentials, Tauri
code signing, deployed worker URL, and branded icons — tracked in
[CHECKLIST.md](CHECKLIST.md).

## CI

GitHub Actions runs root `bun run typecheck`, root `bun run test`, per-app typechecks (including `apps/gateway`), package typechecks for `packages/memory` and `packages/context-compiler`, and a CLI smoke test (`--help`). The default `bun run test` is fully offline — it never hits the network or a real keychain.

An opt-in live end-to-end test hits a real provider and is therefore separate
from the default suite. It skips unless a key is present:

```bash
GROQ_API_KEY=gsk_your_key bun run test:live
```

## Memory & context

`@zintus/memory` provides deterministic `summarizeTurns()` and regex-first
`extractFacts()` helpers. After each assistant response the engine updates a
working summary and extracted facts asynchronously (fire-and-forget, never
blocking the stream; failures are logged, not thrown). `@zintus/context-compiler`
assembles the prompt from the working summary, recent turns, and top facts under
a token budget.

LLM-assisted summarization/extraction is **opt-in** via `MEMORY_LLM=1` because it
makes extra provider calls (cost + quota). The default path is fully offline and
deterministic.

Memory chunk recall (and the L2 response cache below) match text via embeddings.
By default — no `OLLAMA_HOST` configured — those embeddings are a deterministic
**keyword-hash** fallback, so similarity is token overlap, **not** semantic
meaning. It is honest local degradation, not vector recall. Set `OLLAMA_HOST`
(a local `nomic-embed-text`) for real semantic embeddings. `embeddingMode()` from
`@zintus/memory` reports the active mode (`"keyword-hash"` by default, `"ollama"`
when configured), and the package logs a one-time warning the first time it falls
back to keyword-hash.

The router keeps sticky provider affinity per `threadId + provider` (TTL 30 min)
so a thread tends to stay on one provider.

## Response cache

`@zintus/cache` provides a two-tier response cache that the engine consults
before calling any provider (`packages/engine/src/engine.ts`):

- **L1 — exact match.** SHA-256 over the message history + model/provider/
  temperature/max-tokens. O(1) lookup, sub-millisecond. A hit replays the stored
  answer verbatim.
- **L2 — embedding match (opt-in path).** When L1 misses, the last user message
  is embedded and matched against stored prompts via `sqlite-vec` cosine distance
  under a strict threshold (≤ 0.12). Embeddings are **semantic only when
  `OLLAMA_HOST` is set** (`nomic-embed-text` via Ollama); with no embedder
  configured (the default) they fall back to a deterministic **keyword-hash**
  (token overlap, not meaning), so L2 degrades to near-exact token-set matching
  rather than true semantic recall. No network call is required either way.

Because a cached answer is **returned instead of calling the provider**, it can
differ from what the live model would produce right now. The gateway surfaces
which tier served a request via the `X-Cache-Hit: L1 | L2 | miss` response
header. Set `enableCache: false` (engine config) to disable caching entirely.
Gemini's genuine `cachedContent` is still passed through when a handle is
supplied.

> An earlier revision shipped a *fake* "semantic cache" (an exact-match store
> that replayed canned responses) and a `formatForProvider()` prompt-marker
> layer that injected text into prompts without any real provider caching. Both
> were removed and replaced by the real L1/L2 cache described above.

## Zintus Cloud — remote gateway control

Zintus Cloud lets you control your home gateway from the mobile app (or `zintus.app/dashboard`) without re-scanning a QR code on every restart.

### Security model

```
Mobile ──HTTPS──► Cloudflare Worker (Hono routing)
                        │
                 GatewaySession Durable Object
                 (WebSocket Hibernation API)
                        ▲
                        │ outbound WebSocket (home machine initiates)
                 zintus serve --cloud (home machine)

zintus.app ──HTTPS──► same Worker/DO
Cloudflare D1: users, gateway sessions (secret stored as SHA-256 hash only)
Cloudflare KV: relay tokens (1h TTL), magic-link tokens, OAuth state
```

- **Outbound-only**: home machine initiates all connections outward; no inbound ports, works behind NAT/home routers/corporate firewalls with zero config
- **Keys never leave the home machine**: only status JSON, control commands, and SSE events pass through the relay
- **Short-lived, scoped credentials**: `gateway_secret` → hashed in D1, never transmitted to mobile; `relay_token` → 1h TTL, in-memory only on the gateway, invalidated on session delete; mobile uses Better Auth session cookie in MMKV (never AsyncStorage)

### Quick setup

```bash
# 1. Sign in to zintus.app and save credentials (opens browser):
zintus cloud login

# 2. Start gateway + connect to cloud relay:
zintus serve --cloud

# 3. Open zintus.app/dashboard — your gateway appears online
# 4. Sign in to the mobile app → Remote tab → tap your gateway
```

### Deploy the relay worker

```bash
# Create D1 + KV:
wrangler d1 create zintus-relay      # paste database_id into wrangler.toml
wrangler kv namespace create RELAY_KV # paste id into wrangler.toml

# Set secrets:
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put RESEND_API_KEY

# Apply schema + deploy:
wrangler d1 execute zintus-relay --file=schema.sql
wrangler deploy
```

Worker lives in `workers/relay/`. See `workers/relay/.env.example` for all vars. `NEXT_PUBLIC_RELAY_URL` in the web app must point at the deployed worker.

### What flows through the relay (and what doesn't)

| Through relay | Never through relay |
|---|---|
| Session heartbeat / online status | API keys for any provider |
| `/remote/status` (provider quota bars) | Raw chat messages |
| Control commands (set_strategy, pause, resume, reload_keys) | Router state or embeddings |
| SSE events (request_routed, quota_warning, provider_failed) | gateway_secret (hashed only) |

---

## License

Zintus is source-available under the Business Source License 1.1. Free for
personal and internal business use. Contact YS Ventures LLC for commercial
licensing. See [LICENSE](LICENSE).
