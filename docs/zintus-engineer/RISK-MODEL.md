# Zintus Engineer risk model

Risk is an auditable deterministic decision. LUNA may later extract candidate
features, but it cannot assign the authoritative tier.

## Inputs

The engine accepts explicit booleans/counts for sensitive paths, authentication,
authorization, payments, migrations, destructive operations, infrastructure,
secret access/exposure, dependencies, public API changes, coverage, warnings,
security findings, retries, external services, diff size, generated-code ratio,
reviewer disagreement, and suspected runner compromise.

Missing evidence is not converted to a favorable value. For example, unknown
coverage remains unknown and can match an `UNVERIFIED_COVERAGE` rule.

## Tier rules

Rules are evaluated from highest to lowest severity.

| Tier | Representative deterministic matches | Control effect |
| --- | --- | --- |
| CRITICAL | secret exposure, suspected runner compromise, unresolved critical security finding, destructive production action, privilege escalation | block and security-escalate; never auto-approve |
| HIGH | auth/authorization, payments, migrations, infrastructure/production config, secret access, unresolved high security finding | mandatory human approval; fail closed |
| MEDIUM | normal functional code, dependency or public API change, external-service behavior, material warnings, large/low-coverage/retried patch | mandatory human approval; bounded pause |
| LOW | documentation/comments/formatting or a narrowly non-functional change with all checks complete | policy-based auto-proceed only when explicitly enabled |

The highest matched tier wins. The output includes `ruleVersion`, every matched
rule, and `humanGateRequired`. A model confidence score is never used.

## Reassessment

Risk is evaluated at intake, manifest freeze, after the final diff/security review,
after repair retries, and before publication. A higher tier takes effect
immediately. A lower tier does not revive invalidated approval or review evidence.

Any change to frozen scope creates a new manifest version and risk assessment.
Medium/high/critical scope changes require human approval before execution.
