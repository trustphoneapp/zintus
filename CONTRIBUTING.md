# Contributing to Zintus

Thanks for your interest. This is a Bun monorepo; everything below assumes
`bun` 1.2+ on your PATH.

## Setup

```bash
bun install
bun run typecheck   # tsc project build + per-app typechecks
bun run test        # unit + integration tests (must be green)
```

## Project layout

See the table in [README.md](README.md). The dependency direction is:

```
types → providers → router → engine → apps/gateway
                 ↘ keychain ↗
memory, context-compiler → engine
```

- **`packages/router/quota-core`** is the single source of truth for quota
  decisions (reset/availability/cooldown/usage). The gateway, desktop, and
  mobile all consume it. Do not reimplement quota math in an app.
- **`packages/providers/token-estimate`** owns token accounting. Provider
  adapters must surface real `usage` when the API reports it; estimation is a
  tagged fallback only.

## Ground rules

1. **No fake features.** If something cannot be verified, do not ship it as if
   it works. (An earlier *fake* "semantic cache" — an exact-match store that
   replayed canned responses — and a prompt-marker layer were removed for this
   reason and replaced by the real L1/L2 `@zintus/cache`; see the
   "Response cache" section in README.)
2. **Tests must pass and not hang.** Tests must never touch the real OS keychain
   or the network — inject `getApiKey` and stub providers via `mock.module`
   (see `engine.integration.test.ts`).
3. **Errors are logged, not silently swallowed.** Background work (memory) may
   be best-effort, but failures must be observable.
4. **Security defaults stay safe.** The gateway must not bind publicly without a
   token. See [SECURITY.md](SECURITY.md).

## Adding a provider

1. Add the id to `packages/types/src/provider-id.ts` and `provider.ts`.
2. For an OpenAI-compatible API, add it via `createOpenAiCompatProvider` in
   `packages/providers/src/providers/skeletons.ts`. Use a real key prefix regex
   when documented, otherwise `GENERIC_KEY`.
3. Add limits to `packages/router/src/limits.ts`.
4. Confirm `usage` is parsed (most OpenAI-compatible APIs honor
   `stream_options.include_usage`).

## Before opening a PR

```bash
bun run typecheck && bun run test
```

Both must pass. Keep changes focused; prefer deleting code over adding it.
