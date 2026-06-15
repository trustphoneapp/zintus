# MultipleAI

Cross-platform AI router — routes chat requests across providers (Cerebras, Groq, Gemini, OpenRouter, Cohere, Mistral, DeepSeek, Ollama) with quota-aware failover.

## Monorepo layout

| Path | Description |
|------|-------------|
| `packages/types` | Shared TypeScript types |
| `packages/providers` | Provider adapters (OpenAI-compat + Gemini + Ollama) |
| `packages/router` | Priority routing, failover, Drizzle quota ledger, Groq rolling-window cooldown |
| `packages/keychain` | OS keyring wrapper (`@napi-rs/keyring`) |
| `packages/core` | App-level helpers for clients |
| `apps/cli` | Commander CLI with Ink status dashboard |
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
```

## Run commands

### CLI

```bash
cd apps/cli
bun run dev -- --help
bun run dev -- keys set groq gsk_your_key_here
bun run dev -- config
bun run dev -- status
bun run dev -- "Hello from MultipleAI"
```

From repo root:

```bash
bun run dev:cli -- keys list
```

### Web (Next.js 16, Vercel-ready)

```bash
cd apps/web
bun install
bun run dev
# http://localhost:3000/chat
```

API routes:

- `POST /api/chat` — stream chat via `@multipleai/router`
- `POST /api/validate` — validate provider keys (local or via `VALIDATE_WORKER_URL`)

Deploy to Vercel from `apps/web` (see `vercel.json`). Keys are encrypted in the browser with Web Crypto (AES-256-GCM + PBKDF2) before `localStorage` persistence.

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

`POST /validate` with `{ "providerId": "groq", "key": "..." }` — CORS enabled, rate limited to **10 req/IP/min**.

Point the web app at your deployed worker:

```bash
VALIDATE_WORKER_URL=https://your-worker.workers.dev bun run dev
```

## Provider notes

- **Groq** parses `x-ratelimit-*` headers and applies rolling-window cooldown in the quota ledger.
- **Ollama** requires no API key; uses `OLLAMA_HOST` (default `http://localhost:11434`).
- Keys are stored in the OS keychain via CLI/desktop; web uses AES-256-GCM in `localStorage`; mobile uses SecureStore.

## CI

GitHub Actions runs `bun run typecheck` on push/PR, then per-app typechecks and a CLI smoke test (`--help`).

## License

MIT — see [LICENSE](LICENSE).
