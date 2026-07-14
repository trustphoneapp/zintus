# Zintus Engineer state machine

The persisted `EngineerRun.state` is authoritative. UI status, agent output, queue
messages, and worker memory are projections only.

## Primary success flow

```text
REQUEST_RECEIVED -> REQUEST_NORMALIZED -> PLANNING -> PLAN_READY -> PLAN_FROZEN
  -> SANDBOX_WARM_CLAIMING | SANDBOX_COLD_PROVISIONING
  -> SANDBOX_READY -> IMPLEMENTING -> FAST_CHECKS -> UNIT_TESTING
  -> INTEGRATION_TESTING -> SECURITY_REVIEW -> REVIEWING -> REVIEW_APPROVED
  -> HUMAN_APPROVAL_PENDING -> HUMAN_APPROVED   (when required)
  -> PR_PREFLIGHT -> PR_CREATING -> PR_CREATED -> COMPLETED
```

An explicitly configured low-risk policy may take `REVIEW_APPROVED -> PR_PREFLIGHT`
only when all deterministic preflight facts are satisfied.

## Reviewer repair flow

```text
REVIEWING -> REVIEW_CHANGES_REQUESTED -> REVIEW_FIX_PREPARING -> IMPLEMENTING
  -> FAST_CHECKS -> UNIT_TESTING -> INTEGRATION_TESTING -> SECURITY_REVIEW
  -> REVIEWING (new isolated Reviewer session)
```

Reviewer repair attempts are capped at two and count toward the total Builder
repair budget. A scope-expanding finding routes to `REPLANNING`, creates a new
manifest version, and invalidates prior verification/review/approval evidence.

## Publication and stale-base flow

Only the Supervisor can enter `PR_CREATING`. PR preflight binds the current manifest,
result commit, Reviewer decision, evidence bundle, and human approval. A changed
base enters `BASE_BRANCH_STALE`, then re-verification and a fresh review/approval;
it cannot create the PR with stale hashes.

## Failure and control

Every non-terminal state has cancellation and timeout/escalation paths encoded in
the state graph and a policy record containing maximum duration, heartbeat
expectation, and retry class. `CANCELLATION_PENDING` ends in `CANCELLED` or a bounded
rollback. Infrastructure failures are distinct from code verification failures.

Terminal states are:

- `COMPLETED`
- `REJECTED`
- `CANCELLED`
- `TIMED_OUT`
- `RETRY_BUDGET_EXHAUSTED`
- `BLOCKED_BY_ENVIRONMENT`
- `BLOCKED_BY_EXTERNAL_DEPENDENCY`
- `SECURITY_ESCALATION`
- `HUMAN_REVIEW_REQUIRED`
- `VERIFICATION_INCOMPLETE`
- `ROLLED_BACK`
- `FAILED`

No terminal state accepts another transition.

## Transition transaction

For every accepted transition, one SQLite transaction:

1. Reads the current run.
2. Checks expected `state_version` and source state.
3. Validates the state graph, actor policy, manifest binding, risk gate, evidence
   requirements, budgets, and state-specific guard facts.
4. Inserts one event at the next sequence with a unique idempotency key.
5. Compare-and-swaps the run state/version.
6. Commits both records or neither.

A replay with the same idempotency key and same semantics returns the existing
event without incrementing state. Reusing that key for different semantics is a
workflow failure.

## Manifest freeze

`PLAN_READY -> PLAN_FROZEN` is a dedicated atomic operation. It validates the
repository/run identity, canonicalizes the manifest without its hash field, computes
`sha256:<hex>`, inserts the immutable version, attaches the hash to the run, and
appends the transition. Existing manifest rows are never updated.
