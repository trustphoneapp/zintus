# Production-pilot architecture mapping

| Required lane | Runtime authority | Pilot proof |
| --- | --- | --- |
| Repository source | Server-configured repository authority | Exact root, origin, branch, and base commit preflight |
| Repository intelligence | Planner constrained by deterministic repository inspection | Evidence-backed plan and mandatory-question boundary |
| Frozen engineering contract | Required-lane contract ledger | Immutable manifest/criteria/test/budget binding |
| Deterministic execution | Supervisor plus pinned offline Docker sandbox | Scoped diff, tests, security checks, cancellation, and budget enforcement |
| Scoped reviewer | Deterministic classification gateway | Blocking findings map to frozen criteria or safety policy; additions remain advisory |
| Verified candidate checkpoint | Checkpoint and attestation authorities | Hash-bound candidate, evidence, lineage, and identities |
| Correction | Resolution Desk only | New run, explicit budget, durable lineage, no in-place candidate mutation |
| Publication | PublicationAuthorityService governing the Git actuator | Distinct approval, fresh base/protection check, dispatched-before-effect, read-only reconciliation |

## Authority boundary

The pilot supports one server-configured organization and one trusted local installation. Browser input cannot choose repository, commit, organization, approver, lineage, or attestation authority. GitHub availability is reported separately from core Engineer readiness.

## Reuse rule

Existing source implementations remain in their package locations. The release directory stores only plans, historical schema evidence, reusable diagnostics, and non-secret test results. Git history is the source-code archive.
