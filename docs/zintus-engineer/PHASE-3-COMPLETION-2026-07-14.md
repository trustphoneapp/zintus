# Zintus Engineer Phase 3 completion — 2026-07-14

## Outcome

Phase 3 is complete in source for the configured local single-repository flow.
Correctness authority remains deterministic: trusted executor/system evidence may
certify a requirement; TERRA and LUNA outputs are advisory; SOL supplies one fresh,
isolated final review after all executable gates pass.

Live activation is not claimed. This host still lacks the configured immutable
Docker runtime/image and live OpenAI credentials required for an end-to-end run.

## Task pairs and cross-verification

1. Coverage matrix and evidence binding
   - Added a hash-bound criterion/test coverage matrix.
   - Rejected uncovered MUST criteria, non-executable plan items, unrelated
     evidence, and false verified claims.
2. Durable reconstruction and restart recovery
   - Persisted a hash-bound retained sandbox/workspace checkpoint.
   - Revalidated Git identity, frozen base ancestry, image digest, environment,
     and sandbox policies before restarting from `FAST_CHECKS`.
3. Failure taxonomy and security authority
   - Distinguished plan, flaky, failed, timed-out, blocked, stable-required, and
     security failures with durable reason codes.
   - Required executable security gates for HIGH/CRITICAL work and blocked HIGH
     or CRITICAL deterministic findings before model review.
4. Reviewer isolation and end wiring
   - Required structured non-approval rationale and valid criterion/evidence refs.
   - Rechecked commit and diff after SOL returned, rejecting stale decisions.
   - Wired startup recovery and failure-only LUNA triage through the gateway.

## Cost-aware routing

- TERRA: test-coverage and security advisories on successful verification.
- LUNA: one low-effort, schema-constrained failure summary only after the
  deterministic classifier has already made a terminal decision.
- SOL: the final isolated review and bounded Builder repair only.

No model advisory is added to trusted acceptance evidence.

## Mandatory evaluation matrix

`phase3-evaluation-matrix.ts` is hash-bound and names 16 executable cases:
happy-path approval, missing coverage, unrelated evidence, missing high-risk
security gate, flake quarantine, failed security command, blocking deterministic
finding, stable repair, identical-patch stop, Reviewer repair, input tampering,
concurrent workspace mutation, interrupted recovery, runtime budget stop, LUNA
advisory isolation, and TERRA advisory isolation.

## Standards cross-check

- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
  requests force one strict function, disable parallel tool calls, use `store:false`,
  omit previous-response state, and hash-bind dynamic inputs.
- [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) PW.7/PW.8
  principles are reflected by independent code/security review, executable tests,
  durable triage records, and full retesting after repair.
- [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)
  is used as the current security-verification baseline; HIGH and CRITICAL
  deterministic findings fail closed.
- [SLSA 1.2 artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts)
  is reflected by binding the subject commit/diff, verifier identity, policy
  versions, environment digest, and input evidence.

## Verification evidence

- Focused pair gates: 13/13, 36/36, 21/21, and 23/23 passed.
- Engineer plus gateway source suites: 406 passed, 0 failed.
- Engineer and gateway TypeScript checks passed after rebuilding project-reference
  declarations.
- The full repository test command, root TypeScript build, and root build command
  passed with zero command failures.
