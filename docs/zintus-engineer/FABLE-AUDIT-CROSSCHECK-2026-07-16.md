# Zintus Engineer Fable audit cross-check

Date: 2026-07-16  
Audited baseline: `c0096f3740110054c4d182a1dc968d90cd245aa4`  
Scope: the eight live-runtime findings in Part 1 of the Fable review

This record maps every runtime finding to its implementation and executable
regression evidence. "Closed" means the reported failure mode is blocked by a
deterministic control and a test. It does not mean the separate enterprise
programs in Part 2 have been compressed into this reliability patch.

## Pair 1 — bounded cancellation and flake routing

| Audit finding | Status | Control | Regression evidence |
| --- | --- | --- | --- |
| A Docker/child process that ignores `SIGTERM` can hang forever and cannot be cancelled | Closed | `async-process.ts` now applies a hard timeout or caller abort, sends `SIGTERM`, escalates to `SIGKILL` after a bounded grace period, and settles even if the child never emits a normal exit. The execution, verification, trusted-command, and production Docker-adapter paths propagate the same `AbortSignal`; run cancellation aborts the active worker. | `async-process.test.ts` covers a `SIGTERM`-ignoring child for timeout and explicit cancellation. `execution.test.ts` asserts that the signal reaches the injected Docker process boundary. |
| `FLAKE_QUARANTINE` is dead and mixed results terminate as incomplete | Closed | `independent-verifier.ts` transitions a mixed repeated outcome to explicit `FLAKE_QUARANTINE` with evidence. The manager moves it to `HUMAN_REVIEW_REQUIRED`; the human can reject or authorize a fresh verification recovery without requiring a not-yet-created evidence bundle. It is neither incorrectly passed nor left idle. | `verification.test.ts` asserts quarantine and escalation; `engineer.test.ts` proves the no-bundle human retry path resumes verification; the adversarial fixture proves a mixed result never counts as a pass. |

## Pair 2 — crash recovery and renewable GitHub credentials

| Audit finding | Status | Control | Regression evidence |
| --- | --- | --- | --- |
| A crash destroys the workspace but replays a stale Builder continuation into the replacement workspace | Closed | Every new Builder continuation is bound to the sandbox workspace identity as well as manifest, context, and diff. Legacy or replacement-workspace continuations are not resumable even when both workspaces have the same empty diff. Schema v14 permits multiple historical sandbox records per run while retaining unique workspace identity and immutable history. | `execution.test.ts` uses a stale continuation whose diff matches the fresh workspace and proves identity fencing forces fresh rounds. `database-schema.test.ts` executes the v13-to-v14 migration and checks foreign keys. |
| Publication closes over one boot-time GitHub token and bypasses the relay refresh broker | Closed | Gateway publication accepts a readiness-probed dynamic credential provider. GitHub API `401` and recognized Git authentication failures cause at most one forced refresh and retry; non-authentication Git failures are not replayed. A disconnected or stalled connector probe is bounded and does not disable local Engineer admission. Cloud CLI obtains session-scoped tokens from the relay Durable Object; refresh credentials never leave the relay and responses are `no-store`. | `git-service.test.ts`, `engineer-publication-authority.test.ts`, and `cloud-auth-bearer.test.ts` cover API/Git refresh, non-auth replay suppression, dynamic authority, session isolation, and no-store behavior. |

## Pair 3 — phase fencing, planning recovery, and paid-work checkpoints

| Audit finding | Status | Control | Regression evidence |
| --- | --- | --- | --- |
| Verification/review has no lease fencing; planning/replanning has no lease or recovery sweep | Closed for the reported concurrent-workspace corruption path | Planning and verification acquire a per-run fenced worker lease, heartbeat it, propagate revocation into model and command transports, and assert authority before model-derived durable writes and state transitions. Replacement planning waits for the stale attempt to settle. Boot recovery sweeps planning and verification states; an orphaned model call is paused for explicit human retry instead of being replayed. | Worker-lease, gateway, planning-replacement, ambiguous-provider, cancellation, execution, and verification tests run in the full repository gate. |
| Budget resume restarts independent verification from `FAST_CHECKS` and repays completed deterministic work | Closed for the reported re-run | A trusted `INDEPENDENT_VERIFICATION_CHECKPOINT` binds the manifest, diff, result commit, objective executions, findings, and trusted evidence. Recovery enters `SECURITY_REVIEW` from that checkpoint and does not rerun completed commands/tests. | `verification.test.ts` pauses, resumes from the checkpoint, and asserts the objective command count does not increase. |

Residual cost note: if a pause occurs inside a model advisory or isolated review
call, the already settled provider call remains recorded but that individual
stage may be invoked again only after the user explicitly authorizes the
retry. Provider-level idempotency cannot be assumed after
an ambiguous network outcome, so those cases remain fail-closed and require a
human retry decision rather than automatic spending.

Lease precision note: lease validation and artifact/ledger writes currently
span separate storage operations. Revocation aborts model/command transports,
pre-write fencing rejects stale authority, and Supervisor CAS prevents a stale
worker from certifying a state transition. A narrow race can still leave
non-certifying failed-agent bookkeeping after revocation. Eliminating that
metadata-only race requires passing the fencing token into every ledger write
and validating it transactionally in the same database transaction.

## Pair 4 — publication drift and durable artifact failures

| Audit finding | Status | Control | Regression evidence |
| --- | --- | --- | --- |
| Base branch can move between validation and PR creation | Closed to the extent supported by branch-name PR APIs | Publication re-inspects the base after push, immediately before PR creation, and immediately after creation. Pre-create drift prevents a PR. A move during the remote create call is recorded as `BASE_BRANCH_STALE`; the production Git service creates only draft PRs and corrected-run recovery is required. | `publication.test.ts` covers both `[match, drift]` before create and `[match, match, drift]` during create, including one PR call and no completed state; `git-service.test.ts` separately proves PRs are draft. |
| The publication artifact-size exception is not durable and can cause an infinite retry loop | Closed | Artifact-cap failures are caught at the publication boundary, persisted as non-retryable `PUBLICATION_ARTIFACT_LIMIT_EXCEEDED`, and copied to `lastError`. Boot recovery excludes runs with that permanent publication failure. Successful publication clears stale `lastError`. | `publication.test.ts` forces a one-byte artifact budget, then invokes recovery and proves no Git operation is retried. |

No client can make branch-name PR creation mathematically atomic with a base
SHA. The compensating control is detection, draft-only remote mutation, durable
stale state, and corrected-run recovery; it never silently calls the result
verified.

## Part 2 enterprise findings

These are valid product-program findings, not defects that can be honestly
closed by the Part 1 runtime patch:

| Enterprise capability | Current disposition |
| --- | --- |
| Multi-user RBAC and creator/approver segregation of duties | Open — P0 enterprise identity program |
| Tenant/org/team isolation | Open — requires an `org_id` schema and authorization migration across every read/write path |
| SSO/SAML/OIDC | Open — enterprise identity-provider integration |
| Cross-run audit query/export | Partial — immutable writes exist; tenant-scoped read/export API is still required |
| Horizontal scale beyond the local single-process deployment | Open — distributed scheduler/storage program |
| Provider-neutral model routing | Partial — internal role/cost routing exists, but enterprise BYO Azure/Bedrock/provider policy remains open |
| Multi-SCM | Partial — GitHub is implemented; GitLab/Bitbucket adapters remain open |
| Organization governance | Open — repo, model, spend, and publication policies require tenant administration |
| KMS/Vault-backed secret lifecycle | Partial — local protected storage and relay credential broker exist; enterprise KMS integration remains open |
| Backup and disaster recovery | Open — requires defined RPO/RTO, encrypted backups, restore drills, and deployment-specific runbooks |

The enterprise sequence remains: segregation of duties and tenancy first,
then audit export/model-provider policy, followed by scale, multi-SCM, KMS, and
formal backup/DR. Claiming these as completed without the cross-cutting schema,
authorization, deployment, and operational work would weaken the evidence model
this product is designed to protect.

## Release gates

- `git diff --check`
- full repository tests
- repository typecheck
- focused runtime, relay, gateway, and publication regression suites
- no automatic resume of preserved budget-paused evidence runs
- no push without explicit user instruction
