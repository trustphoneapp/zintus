# Testing Zintus

How testing works in this repo, and the rules for adding to it. Read this before
writing tests — the suite has a non-obvious two-runner split that you must respect.

## TL;DR

```bash
bun run test            # the whole suite (~4s) — run before every PR
bun run typecheck       # 0 errors required
bun run test:coverage   # bun+vitest lcov merge + per-prefix gate
```

## The testing pyramid (actual, not aspirational)

| Layer | Where | What it proves | Count (approx) |
|---|---|---|---|
| **Unit** | co-located `*.test.ts` next to source | pure functions, real boundaries | majority |
| **Integration** | `*.integration.test.ts` | real engine+router+Tokzen, mocked HTTP | ~5 files |
| **Contract** | `contracts.test.ts`, `compress-contract.test.ts` | response/return SHAPES that callers depend on | 2 files |
| **Smoke** | `workers/relay/tests/smoke.test.ts`, `scripts/gateway-load-smoke.ts`, CI smoke jobs | "it boots and answers" | a few |
| **Chaos** | `tests/chaos/` (nightly) | failure/concurrency/timeout/input | _deferred — not yet built_ |

Tests assert what the code **actually does**, not the theoretical ideal. Concrete
examples baked into the suite:
- the gateway returns **no `created`/`usage`** and a quota-exhausted request is
  **HTTP 400** (`"No providers available"`), not 429 — see `contracts.test.ts`.
- `compress()` returns `{ messages, totalResult, ... }` — there is **no
  `metrics`/`mode`/`level`** field — see `compress-contract.test.ts`.
- Tokzen levels use strict `>` cutoffs (`>0.5/>0.3/>0.15`) with no clamping —
  see `quota-controller.test.ts`.

## The two-runner split (important)

The suite runs under **both** `bun test` and `vitest`, and this is deliberate:

- **bun test** runs ~90% of files. Bun's `mock.module()` is process-global and
  `mock.restore()` does not fully undo it, so mock-heavy files are kept in
  **isolated invocations** (see the batches in the root `package.json` `test`
  script). Notably the `@zintus/providers` mock from `weighted.test.ts` must not
  leak into `token-estimate.test.ts` — that's why providers tests run alone.
- **vitest** runs exactly **5 files** (`crypto-e2e/e2e` + the pure router helpers
  `priority/cooldown/groq-reset/quota-core`). These are pure/crypto tests with no
  bun mocking needs.

**Rule:** a file imports test primitives from exactly one runner —
`from "bun:test"` OR `from "vitest"`, never both. vitest **cannot** import
`bun:test` files (it fails to resolve the builtin), so don't try to unify them.

### `@zintus/test-utils`

Shared helpers live in `packages/test-utils`:
- `@zintus/test-utils` (index) — **runner-agnostic**: `createMockProvider`,
  `createMockRequest`, `assertChatCompletionShape`, `assertValidSSEStream`,
  fixtures. Zero `bun:test`/`vitest`/`bun:*` imports at module scope, so both
  runners can use it.
- `@zintus/test-utils/bun` — **bun-only**: `createTestDb`, `createTestGateway`
  (uses `bun:sqlite` + `mock.module`). Import this only from `bun test` files.

## Coverage

`vitest --coverage` alone would see <5% of the tree (it can't load bun-test
files). So coverage is **per-runner, then merged**:

```bash
bun run test:coverage   # scripts/coverage.ts
```

It runs `bun test --coverage` (lcov) for each isolated batch + `vitest run
--coverage` for its 5 files, **unions the lcov per line** (not a naive sum), and
writes `coverage/lcov.info`. Per-prefix line gates are enforced on the merged
report and **ratchet** toward these targets as coverage improves:

| Path | Gate today | Target |
|---|---|---|
| `packages/router/src/inflight.ts` | 90% | 100% |
| `packages/crypto-e2e/src/` | 65% | 95% |
| `packages/router/src/` | 60% | 90% |
| `packages/tokzen/src/` | — | 85% |
| `apps/gateway/src/` | — | 75% |

Raise a gate in `scripts/coverage.ts` whenever you push a prefix above it.

## How to add a test for a new feature

1. **Pick the runner**: pure function or crypto → either; needs `mock.module` or
   `bun:sqlite` → `bun test`.
2. **Co-locate** unit tests next to the source (`foo.ts` → `foo.test.ts`).
3. **Test behavior, not implementation** — assert the business rule and the real
   shape, including the failure path (not just the happy path).
4. **Register it** in the root `package.json` `test` script in the **correct
   batch** (glob-covered dirs like `packages/tokzen/tests/` and
   `workers/relay/tests/` are automatic; explicit-path batches need the file
   added). Mock-heavy files go in the integration batch.
5. `bun run test` must stay green; `bun run typecheck` must stay at 0 errors.

## Rules before merging

- New code ships with tests: **unit tests + at least one integration test** for a
  feature.
- `bun run test` green, `bun run typecheck` clean, no `.only`/`.skip` left behind.
- No test depends on order or shared state; no test mocks the thing it is testing.

## Flaky tests

The suite is intended to be flake-free. If a test is timing- or
concurrency-dependent, prefer a **deterministic** formulation (e.g.
`recentErrorCount` uses an injectable `now`; see `error-streak.test.ts`) over
real timers. If you can't make it deterministic, it belongs in the (nightly)
chaos suite, not the PR suite.

## CI

`.github/workflows/ci.yml`: `typecheck` → `test` (+ `coverage`, `security` in
parallel) → matrix `apps`/`packages` typecheck + `cli-smoke`/`gateway-smoke`;
`build-apps` (incl. the gateway Docker image) runs **only on main**. The bun
install store is cached — the real cost is install, not the ~4s suite. Branch
protection should require: `typecheck`, `test`, `coverage`, `security`.
