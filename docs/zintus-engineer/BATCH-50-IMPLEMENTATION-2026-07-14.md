# Zintus Engineer — next 50 implementation tasks

Date: 2026-07-14  
Scope: the 50 tasks immediately following the context/decision/lease batch.  
Method: Sol lead implementation, independent Terra/Luna gap audits, focused repair,
then cross-package and full-suite verification.

## Completed task ledger

### A. Mandatory questions and planning continuity

1. Added planner question option contracts.
2. Limited questions to two or three choices.
3. Rejected duplicate option identifiers.
4. Required the recommendation to reference a real option.
5. Added question choices to the strict OpenAI function schema.
6. Wired deterministic decision-feature extraction into live planning.
7. Scoped extraction to each question so unrelated ambiguity does not leak across questions.
8. Bound complete questions, options, recommendations, context, and policy versions to the persisted plan artifact.
9. Preserved the plan artifact as untrusted model output.
10. Converted planner questions into durable Supervisor decisions.

### B. Interrupt, resume, and human-answer correctness

11. Paused mandatory questions in `CLARIFICATION_REQUIRED` before `PLAN_READY`.
12. Stopped processing later questions after the first blocking interrupt.
13. Preserved non-blocking `DEFER` questions for the final human checkpoint.
14. Allowed planning to resume from `PLANNING`.
15. Allowed explicit replanning from `REPLANNING`.
16. Fed selected human options into the next planner request.
17. Fed human rationale into the next planner request.
18. Avoided re-normalizing an already normalized request during replanning.
19. Rejected resolution of an unknown option.
20. Added an end-to-end ASK_NOW → answer → replan → PLAN_READY regression.

### C. Runtime resource and cost policy

21. Added strict runtime usage validation.
22. Added deterministic 80% budget warnings.
23. Added hard total-run time limits.
24. Added hard combined input/output token limits.
25. Added hard per-command time limits.
26. Added hard diff-line limits.
27. Added hard artifact-byte limits.
28. Added hard concurrent-agent limits.
29. Failed closed when model cost accounting is unavailable after a call.
30. Added a dated SOL/TERRA/LUNA price catalog, cached-input/cache-write rates,
    long-context multipliers, and malformed-usage tests.

### D. Resumable runs and evidence delivery

31. Added bounded ledger event pages after a sequence cursor.
32. Validated cursor and page-size ranges.
33. Added `afterSequence` to the SSE endpoint.
34. Added standard `Last-Event-ID` resume support.
35. Added SSE event identifiers and server retry guidance.
36. Added SSE heartbeat comments.
37. Added CRLF, multiline, partial-frame, duplicate, and gap-aware client parsing.
38. Added bounded exponential reconnect from the last accepted sequence for clean closes,
    fetch failures, and stream-read failures.
39. Added owner-filtered durable run listing.
40. Added a complete-event, checksummed, owner-checked JSON evidence export.

### E. Honest UI and final risk authority

41. Made evidence subsections degrade independently and surface partial-read errors.
42. Persisted the last applied SSE sequence while replaying durable history after reload.
43. Displayed architecture summary during plan review.
44. Displayed planner assumptions and confidence.
45. Displayed estimated touched files.
46. Added evidence-bundle count and honestly labelled checksummed JSON export UI.
47. Derived final risk features from the actual Git diff.
48. Included trusted check outcomes, retries, and open findings in final risk.
49. Added deterministic auth, authorization, payment, dependency, migration,
    infrastructure, secret, public-API, and external-service floors.
50. Reassessed monotonic Supervisor risk before isolated review.

## Cross-audit repairs

The Terra/Luna pass found and the Sol repair pass closed these additional defects:

- Production decision resolution now automatically invokes replanning and returns the new plan.
- Proposal artifacts are content-address verified against the complete canonical proposal on ledger admission.
- Human decision and resolution hashes are included in replanning provenance.
- Planner, Reviewer, Terra advisors, and Builder fail closed on ambiguous or malformed tool-call sets.
- Stable privacy-preserving end-user safety identifiers now reach every production model role.
- Terminal SSE drains every durable page; future cursors fail closed; reloads reconstruct history.
- Git-quoted paths are decoded before risk floors and diff headers no longer inflate line counts.
- Final risk assessment is included in the Reviewer evidence-bundle hash and export.
- AI-generated decision wording is explicitly labelled as untrusted in the human UI.
- Legacy version-1 plan proposals remain readable while all new proposals use the
  complete version-2 content hash.
- Multiple mandatory questions advance one at a time without recreating already
  resolved decisions, and resolution plus workflow resume is one transaction.
- Model calls now reserve worst-case tokens and cost durably before transport,
  reconcile reservations to actual usage atomically, and retain failed-call
  reservations conservatively across restart.
- Planner, Builder, Terra advisors, and Reviewer now send stable provider-side
  `prompt_cache_key` values in addition to recording those keys as evidence.
- Evidence export now includes verified artifact payloads and the underlying durable
  records, is owner-scoped, and is served with `no-store` caching semantics.
- Every model call is checked against its agent execution and recorded fixed-role
  route; successful calls require that bound reservation, and actual tokens/cost
  cannot exceed it.
- Known provider usage is reconciled before structured-output validation, while an
  indeterminate transport failure retains its conservative reservation.
- Evidence export is assembled from one SQLite read snapshot and includes manifest,
  proposal, context, decision, failure, cost, and verification history tables.
- Reviewer cache status remains unknown unless measured, and the database records
  whether the cache result was actually observed.
- Planner retry and runtime-budget exhaustion now produce durable terminal states;
  duplicate question identifiers and repeated deferred questions fail closed.
- Builder, Terra, Reviewer, and sandbox transport/provisioning loops consume the
  declared durable retry budgets; exhausted retries terminate deterministically.
- Cost evidence records the agent, resolved model, routing decision, currency, and
  versioned pricing catalog, including conservative reservations for responses with
  unavailable usage.
- Failed Phase-3 agents are finalized durably, completion remains possible after a
  budget stop, and the per-run artifact cap rejects aggregate overrun before writing.
- Failed transient calls record zero-based retry counts, measured latency, and their
  exact retained budget reservation; successful reconciliation is bound to the same
  agent execution and routing decision.
- Planner, Builder, advisory, repair, and Reviewer admission failures now share the
  typed runtime-budget stop and terminate as `RETRY_BUDGET_EXHAUSTED` with durable
  evidence instead of being mislabeled as implementation or review failures.

## Current standards review

- The Responses API, strict function tools, `store:false`, application-side validation,
  stable hashed end-user `safety_identifier`, and fixed role routing match current OpenAI guidance.
- SOL is retained for Builder/Reviewer, TERRA for Planner/Tester/Security, and LUNA
  for future high-volume classification/formatting. The price ratio makes this
  materially cheaper than using SOL for all roles.
- Static prompt prefixes stay before run-specific context and every model role sends
  a stable `prompt_cache_key` so automatic caching can match related requests.
  Cached-token usage-detail accounting is still required for discounted billing
  evidence; the active cost authority conservatively prices all reported input as
  uncached.
- Supervisor-only authority, narrow tools, no generic shell, isolated review,
  and human confirmation for sensitive actions align with OWASP guidance on
  prompt injection, insecure output handling, and excessive agency.
- Immutable hashes and evidence manifests are directionally aligned with SLSA
  provenance, but signed attestations and an SBOM are not implemented yet.
- Durable state/event records support NIST SSDF verification and vulnerability
  response practices, but the complete security/evaluation matrix remains open.
- Cursor-based SSE now follows the WHATWG `id`, `Last-Event-ID`, retry, and heartbeat model.

## Verified limitations

This batch does **not** claim production activation. Docker is unavailable on this
machine, required Engineer environment variables are unset, and no live OpenAI or
GitHub mutation was run. Runtime budgets are now an active, durable authority:
model workers reserve conservative worst-case tokens/cost before transport and
atomically reconcile successful usage, while artifacts, commands, agents, diff,
time, and concurrency are checked at their authoritative boundaries. Cached-token
usage-detail accounting, full-state restart reconciliation, branch-protection
enforcement, signed SLSA provenance/SBOM, and live disposable Docker/GitHub
evaluations remain release blockers.

Practitioner discussions consistently emphasize bounded tasks, inspectable diffs,
independent tests, and short evidence summaries. These observations informed the
UX, but Reddit is treated as qualitative input—not as an engineering authority.

## Verification evidence

- Final Engineer/Gateway/Web focused gate: **613 passed, 0 failed, 4,299 assertions**.
- Full monorepo TypeScript project-reference build: passed.
- `git diff --check`: passed.
- The broad root test command observed **2,647 passes, 49 failures, two module-load
  errors, and one skip**. The failures are outside this focused batch and include
  unavailable workspace/provider resolution plus intentional failure fixtures; this
  is recorded as an environment/baseline caveat, not reported as a green root suite.
- Live capability doctor remains failed because Docker and required Engineer runtime
  configuration are unavailable on this machine.
