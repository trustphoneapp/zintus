# Zintus Engineer architecture

## Boundary

Zintus Engineer is a vertical feature inside Zintus:

```text
Zintus web / desktop / mobile
          |
          | authenticated /v1/engineer + SSE
          v
Existing Zintus gateway
          |
          +--> @zintus/engineer (authoritative supervisor + ledger)
          +--> @zintus/router (central model resolution)
          +--> @zintus/agent (Builder tools only)
          +--> context/index packages (untrusted repository data)
          +--> sandbox / executor / evidence / Git service (later phases)
```

The existing generic agent remains available, but an Engineer run cannot be
implemented by relabeling an agent conversation. Engineer has a frozen manifest,
authoritative state, trusted executor evidence, isolated review, bounded repair,
and supervisor-controlled publication.

## Trust domains

1. **User/client:** supplies intent and human decisions. Authentication establishes
   ownership, not correctness.
2. **Supervisor:** deterministic application code. It alone promotes state,
   consumes budgets, evaluates gates, and commands publication.
3. **Builder:** Codex in a single-writer sandbox. It can propose a patch but cannot
   certify it, publish it, or mutate authoritative state.
4. **Trusted executor:** runs policy-approved commands and records exit code,
   output artifacts, environment digest, sandbox identity, and commit SHA.
5. **Tester/Security:** independent roles that request executor actions and produce
   structured findings. Their prose is not executor evidence.
6. **Reviewer:** a fresh SOL session per attempt with only the frozen manifest,
   final diff, and filtered trusted executor evidence. No Builder narrative,
   memory, repo map, or previous review context crosses the boundary.
7. **Git service:** a narrow publication capability callable only by an
   authenticated Supervisor command after preflight.

## Phase-1 package

`@zintus/engineer` is a shared, UI-agnostic package. Its public entry point exposes
validated types, pure policy functions, a read API, and the deterministic
Supervisor. The raw ledger implementation is intentionally not exported from the
package entry point, preventing agents or API handlers from bypassing transition
validation through the supported module surface.

The local implementation uses `bun:sqlite`, WAL mode, foreign keys, transactions,
owner-only file permissions, unique `(run_id, sequence)` and `(run_id,
idempotency_key)` constraints, and compare-and-swap updates on `state_version`.
This matches existing Zintus local stores. The Supervisor contract is kept free of
SQLite-specific result types so a cloud adapter can be added later.

The same package fixes the logical model tier for every role: SOL is reserved for
Builder and Reviewer, TERRA serves planning/testing/security/architecture, and
LUNA serves classification/risk-feature/docs/formatting work. Phase 2 resolves
those logical tiers to provider models at startup; resolution may fail explicitly
but may not silently change a role's tier.

## Core invariants

- Model text is data and never directly mutates workflow state.
- A manifest is canonicalized, SHA-256 hashed, versioned, and immutable.
- Events are append-only and ordered. Duplicate idempotency keys replay the exact
  prior result; semantic reuse of a key is rejected.
- Every transition compares the caller's expected state version.
- Every post-freeze event is bound to the current manifest hash.
- Terminal states reject all later execution transitions.
- Risk tier and retry permission are deterministic rule results.
- Reviewer approval, human approval, and PR creation require evidence IDs and
  role-specific guards.
- Medium, high, and critical work can never use the low-risk PR bypass.
- The Builder never receives remote mutation credentials.

## Data model

Phase 1 creates the complete table namespace early so later phases can add behavior
without weakening referential integrity: users, repository connections, Engineer
runs, manifest versions, state events, acceptance criteria, agent/model/sandbox/
command/test records, artifacts and bundles, claims, security and review findings,
Reviewer sessions, risk, approvals, retries, failures, costs, audit events, Git
operations, routing decisions, and warm sandboxes.

Large stdout, diffs, reports, and screenshots belong in the future artifact store;
database rows contain metadata, hashes, and references. Agent-authored annotations
are marked by producer and filtered before Reviewer input construction.

## Existing infrastructure reuse

- Gateway bearer auth and relay ownership checks protect future routes.
- Gateway SSE supplies ordered timeline updates; clients reconnect using durable
  sequence numbers rather than relying on an in-memory stream.
- `@zintus/context-compiler` already fences repository text as untrusted user-role
  data; Engineer will add source/trust manifests and narrower retrieval.
- `@zintus/agent` supplies path containment, symlink defense, bounded writes,
  argv-only commands, allowlists, and optional hardened Docker execution.
- `@zintus/router` supplies provider/capability routing, while a new Engineer model
  router enforces fixed role tiers before calling it.
- Existing Zintus tokens, cards, badges, buttons, and themes supply the UI language.

## Deferred integrations

Phase 1 does not execute commands, contact a model, create branches, open PRs, or
expose API routes. Those omissions are deliberate: the authority and persistence
layer must be testable before side effects are connected.
