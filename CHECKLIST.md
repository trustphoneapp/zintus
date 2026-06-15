# MultipleAI — Production Roadmap Checklist

Audit date: June 15, 2026  
Repo: `/Users/yashwanthsurabhi/Projects/multipleai`

Legend: ✅ done · 🟡 partial · ❌ missing

---

## Week 1 — CLI verify + polish

| Item | Status |
|------|--------|
| `chat`, `status`, `keys`, `config` commands | ✅ |
| Real API key routing via `@multipleai/router` + keychain | ✅ |
| Ollama fallback (priority 99) | ✅ |
| Failover on 429/5xx + Groq 70B→8B | ✅ |
| `keys set` → validate-key worker + local fallback | ✅ |
| Ink status dashboard with provider colors | ✅ |

---

## Week 2–3 — Providers + CI

| Item | Status |
|------|--------|
| 8 providers implemented (OpenAI-compat + Gemini + Ollama) | ✅ |
| Worker validate-key (Hono 4.12+, rate limit) | ✅ |
| Cohere/DeepSeek endpoint parity with providers | ✅ |
| Vitest router tests + Bun integration tests | ✅ |
| GitHub Actions CI (typecheck, test, cli-smoke, worker) | ✅ |
| Desktop matrix scaffold (Mac/Win/Linux) | ✅ |
| Removed orphan `@multipleai/core` package | ✅ |

---

## Month 2 — Desktop PRODUCTION

| Item | Status |
|------|--------|
| Tauri 2 + Next.js 16 static export | ✅ |
| tauri-plugin-pty LIVE (TerminalPane + tauri-pty) | ✅ |
| xterm.js + WebGL + fit addon | ✅ |
| ChatPanel router streaming + failover | ✅ |
| ProviderRail live status + click-to-override | ✅ |
| ProvidersScreen keyring + QuotaBar | ✅ |
| Zustand stores (settings, providers, chat) | ✅ |
| Shared quota.db via Tauri rusqlite commands | ✅ |
| shadcn-style ui + Tailwind v4 + OKLCH tokens | ✅ |
| Tauri bundle icons (png/icns/ico) | ✅ |
| `release-desktop.yml` matrix workflow | ✅ |

---

## Month 3 — Web PRODUCTION

| Item | Status |
|------|--------|
| Chat / Providers / Usage / Settings pages | ✅ |
| Web Crypto AES-256-GCM vault | ✅ |
| `/api/chat` streaming via `@multipleai/router` | ✅ |
| `/api/validate` worker proxy | ✅ |
| Zustand stores wired to pages | ✅ |
| ProviderRail + session passphrase | ✅ |
| Settings → routing strategy + defaultProvider | ✅ |
| `vercel.json` + `.env.example` | ✅ |
| Tailwind v4 + `@multipleai/ui` tokens | ✅ |

---

## Month 4 — Mobile PRODUCTION

| Item | Status |
|------|--------|
| Expo SDK 56 + Expo Router tabs | ✅ |
| Streaming chat with router failover | ✅ |
| Provider bottom sheet + secure-store keys | ✅ |
| expo-sqlite quota + cooldown | ✅ |
| expo-notifications quota warnings | ✅ |
| MMKV config + selected provider persistence | ✅ |
| `eas.json` profiles + `TESTING.md` | ✅ |
| Placeholder app assets | ✅ |
| `release-mobile.yml` EAS workflow | ✅ |

---

## Integration gaps (resolved)

| Item | Status |
|------|--------|
| Zustand stores desktop + web | ✅ |
| MMKV on mobile (config + provider selection) | ✅ |
| Removed orphan `@multipleai/core` | ✅ |
| Terminal page fully functional (PTY) | ✅ |
| Desktop client router (no API route — static export) | ✅ |

---

## Verify commands

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/yashwanthsurabhi/Projects/multipleai
bun install
bun run typecheck   # ✅ passes
bun run test        # ✅ passes (vitest 16 + bun 6)
```

---

## Remaining blockers (manual / external)

| Blocker | Action |
|---------|--------|
| EAS `projectId` placeholder in `app.json` | Run `eas init` and replace UUID |
| App Store / Play submit credentials in `eas.json` | Fill Apple ID, ASC app ID, Google SA key |
| `WORKER_VALIDATE_URL` on Vercel | Set env to deployed Cloudflare worker |
| `EXPO_PUBLIC_VALIDATE_URL` for mobile builds | Set in EAS env or `eas.json` |
| Tauri code signing | Configure `TAURI_SIGNING_*` secrets for releases |
| Live API key E2E in CI | Optional — requires secrets in GitHub |
| Branded app icons | Replace generated purple placeholders with final art |
