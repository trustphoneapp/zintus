# CLI Agent

**Owns:** `apps/cli/` (the `zintus` npm package)
**Risk:** MEDIUM — published to npm, versioned, runs on user machines.

## Source of truth
| Fact | Where |
|---|---|
| Package config / publish | `apps/cli/package.json` |
| Commands | `apps/cli/src/index.ts` (commander) |
| Release / publish workflow | `.github/workflows/release-cli.yml` |

## Decisions you must NOT reverse

### Shipping model — single bundled file
The CLI depends on `@zintus/*` `workspace:*` packages, which **cannot resolve
from npm**. So it's **bundled** into one `dist/cli.js` via `bun build`
(`prepack`/`prepublishOnly` run the build). Only the 3 native deps
(`@napi-rs/keyring`, `sqlite-vec`, `ws`) stay as real `dependencies`; everything
else is in `devDependencies` and inlined. `files` is a strict allowlist
(`dist/cli.js`, `README.md`, `LICENSE`) — **no `src`, tests, `.env`, or keys** in
the tarball. Verify with `cd apps/cli && npm pack --dry-run`.

### Runs on the Bun runtime
The CLI uses `bun:sqlite` / `Bun.serve`, so `npm install -g zintus` installs the
bin but it **needs Bun on PATH to run** (`bun install -g zintus` is the truer
claim). This is documented in `apps/cli/README.md`.

### `init` is an alias of `setup`
The marketing/docs advertise `zintus init`; the real command is `setup`.
`apps/cli/src/index.ts` adds `.alias("init")` so both invoke the first-run wizard.
Keep the alias.

### Publishing is gated
`release-cli.yml` publishes **only on a `cli-v*` tag**, after: bin smoke +
`npm pack` filename scan + a bundle-content secret grep. No PR/branch push can
publish. Real publish needs the `NPM_TOKEN` secret.

## When you're done
- [ ] `bun run typecheck` (cli) — 0 errors · `cd apps/cli && bun run build` works
- [ ] `npm pack --dry-run` shows only the allowlist (no secrets/src/tests)
- [ ] PR opened, not merged
