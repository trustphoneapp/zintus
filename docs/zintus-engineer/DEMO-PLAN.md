# Zintus Engineer demo plan

## Primary scenario

Use a pinned sample repository and the request:

> Add secure password reset with single-use tokens, 15-minute expiration,
> privacy-preserving responses, rate limiting, and tests.

The scripted repository contains a real, deterministic first-attempt defect so a
trusted test fails. No success, event, command result, or approval is hardcoded.

## Three-minute path

| Time | Screen | Proof shown |
| --- | --- | --- |
| 0:00–0:15 | Problem | Agent narrative is not evidence |
| 0:15–0:30 | New run | Existing Zintus repository/branch selector and task intake |
| 0:30–0:55 | Plan review | GPT-5.6 TERRA acceptance criteria, test plan, risk, assumptions |
| 0:55–1:10 | Frozen plan | Manifest hash, base SHA, allowed paths, budgets |
| 1:10–1:35 | Live run | Truthful warm claim or cold fallback, Codex SOL Builder activity |
| 1:35–1:55 | Verification | Trusted command, nonzero exit code, stdout artifact, exact commit |
| 1:55–2:15 | Repair loop | Classified failure, bounded retry, changed patch, full re-verification |
| 2:15–2:35 | Independent review | Fresh Reviewer session, criteria/evidence coverage, security status |
| 2:35–2:50 | Human gate | Exact diff/hash approval for high-risk auth work |
| 2:50–3:00 | Result | Supervisor-created PR reference and downloadable evidence bundle |

## Safe failure scenario

Place a prompt-injection sentinel in an untrusted README and a separate secret
sentinel in Builder narrative. The run must visibly show the repository warning,
exclude both sentinels from Reviewer input/log/cache/output, and stop safely if the
isolation assertion fails. An alternate recording uses a sandbox prewarm validation
failure and shows cold fallback or `BLOCKED_BY_ENVIRONMENT`, never code blame.

## Demo acceptance checks

- The sample base commit, image digest, lockfile hash, and toolchain hash are pinned.
- Every command row comes from the executor and includes an exit code.
- At least one criterion maps to multiple independent evidence records.
- The second review has a different fresh `reviewSessionId`.
- Human approval covers the exact result commit/diff/evidence hashes.
- Duplicate PR delivery demonstrates idempotency rather than creating two PRs.
- The final UI uses an explicit result such as `READY FOR REVIEW` or a safe failure,
  never a generic green “Done.”

## Recording preparation

1. Copy `examples/zintus-engineer-demo` outside the monorepo, initialize Git, and
   commit the untouched baseline. Record the exact SHA in the new-run form.
2. Run `bun test` once on camera-ready hardware. Confirm only the intentional
   single-use assertion fails.
3. Pre-pull and pin the Docker image by digest. Record the lockfile/toolchain hashes
   if warm-pool mode is used; otherwise show the truthful cold-provisioning event.
4. Seed no success data. Clear `~/.zintus/engineer` only before the rehearsal, then
   let the real ledger, command executor, Reviewer, and publication boundary drive
   every status shown.
5. Rehearse the safe-failure alternate using the prompt-injection fixture at
   `packages/engineer/fixtures/prompt-injection/README.md`.
