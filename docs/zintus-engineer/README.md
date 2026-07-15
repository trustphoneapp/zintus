# Zintus Engineer operator guide

Zintus Engineer is the evidence-driven software-engineering workflow inside
Zintus. It plans against an exact commit, freezes scope, builds in an isolated
offline sandbox, independently reruns tests and security checks, starts a fresh
review, requires a human gate according to deterministic risk, and lets only the
Supervisor publish.

## Local setup

1. Install Bun and Docker, then run `bun install` at the Zintus repository root.
2. Store an OpenAI BYOK key through the existing Zintus key flow.
3. Set the execution boundary:

```bash
export ZINTUS_ENGINEER_REPOSITORY_ID=local-repository
export ZINTUS_ENGINEER_REPOSITORY_ROOT=/absolute/path/to/repository
export ZINTUS_ENGINEER_REPOSITORY_PROVIDER=local
export ZINTUS_ENGINEER_REPOSITORY_OWNER=local
export ZINTUS_ENGINEER_REPOSITORY_NAME=zintus
export ZINTUS_ENGINEER_REPOSITORY_ORIGIN_URL=https://github.com/example/zintus.git
export ZINTUS_ENGINEER_BASE_BRANCH=main
export ZINTUS_ENGINEER_BASE_COMMIT_SHA=<exact-40-or-64-character-commit>
export ZINTUS_ENGINEER_IMAGE='oven/bun@sha256:<digest>'
export ZINTUS_ENGINEER_IMAGE_DIGEST='sha256:<digest>'
# Required when the exact base contains a supported lockfile:
export ZINTUS_ENGINEER_DEPENDENCY_BUNDLE_ROOT=/absolute/path/to/verified-bundle
export ZINTUS_ENGINEER_TOOLCHAIN_HASH='sha256:<toolchain-hash>'
export GATEWAY_TOKEN="$(openssl rand -hex 24)"
bun run doctor:engineer
bun run dev:gateway
```

The dependency bundle contains `zintus-engineer-dependencies.json` and its
`node_modules` tree. The manifest binds the complete dependency byte tree to the
exact repository lockfile and toolchain hashes. The doctor must return `ok: true`
before execution is considered activated.

`GATEWAY_TOKEN` mode is suitable for direct API clients and the packaged desktop
configuration. The browser client deliberately never embeds an operator secret;
its direct loopback mode relies on the local machine boundary and one durable,
server-owned installation identity. Client-supplied actor IDs are ignored. Do not
expose a tokenless gateway beyond loopback. Shared/network deployment still needs
session authentication and organization RBAC in front of the gateway.

The ledger and content-addressed artifacts stay machine-local under
`~/.zintus/engineer`. Planning works with the OpenAI key; execution additionally
requires the repository and pinned sandbox settings above. Publication stays off
unless both `ZINTUS_ENGINEER_PUBLICATION_SECRET` and
`ZINTUS_ENGINEER_GITHUB_TOKEN` are explicitly configured.

Run the web client with `bun run dev:web` or the desktop shell with
`bun run dev:desktop`, then open **Engineer**. Enter a task and an exact 40- or
64-character base commit SHA, review the structured contract, and freeze it.

## Operational checks

- `GET /v1/engineer/observability` reports durable state/risk/failure counts.
- `GET /v1/engineer/runs/{runId}/events?afterSequence=N` resumes the append-only
  SSE timeline; `Last-Event-ID` is also accepted.
- `GET /v1/engineer/runs` lists runs owned by the authenticated local principal.
- `GET /v1/engineer/runs/{runId}/evidence-export` downloads a canonical-hash-bound
  JSON aggregate for offline inspection.
- A non-terminal run after process loss remains visible; queued work is reclaimed
  on gateway restart.
- Warm workspaces are one-use. Invalid, expired, and excess entries are quarantined
  by the pool health sweep and never promoted back to available.
- A mixed repeated-test result is `FLAKY`, never a pass, and requires quarantine.

## Verification

```bash
bun test packages/engineer/src
bun test apps/gateway/src/handler.test.ts apps/gateway/src/openapi-spec.test.ts
bun run --cwd packages/engineer typecheck
bun run --cwd apps/gateway typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
```

The demo fixture intentionally has one failing test. See
`examples/zintus-engineer-demo/README.md` and `DEMO-PLAN.md` for the recording path.
