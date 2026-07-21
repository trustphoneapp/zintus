# Explicit API contract: C + E follow-on

## Purpose

Solution A keeps the existing prose extractor safe enough for current runs. This
slice replaces it with a typed contract and makes a contract mismatch a clear,
bounded user decision rather than an opaque retry loop.

## Solution C — structural `apiContract`

Add an optional, versioned `apiContract` to the frozen task manifest:

```ts
type ApiContractV1 = {
  version: 1;
  sourcePaths: string[];
  exports: Array<{ kind: "class" | "function" | "error"; name: string }>;
  methods: Array<{ owner: string; name: string; required: true }>;
  options: Array<{ owner: string; name: string; required: true }>;
};
```

The gateway derives a canonical candidate from the original request. The
Planner must return an equivalent or strictly additive contract. The Supervisor
freezes the server-derived canonical hash, not browser or model authority.

Validation layers:

1. **Before freeze:** compare typed manifest contract to the canonical contract.
2. **Before Builder:** bind the same contract hash to Builder input.
3. **Before Reviewer:** inspect the workspace AST/TypeScript program for exports,
   class ownership, methods, and option names.
4. **In evidence:** include the canonical contract, workspace result, and hashes.

This eliminates prose matching from correctness decisions. Solution A remains a
compatibility fallback only for requests that cannot be confidently structured.

## Solution E — contract recovery in the Resolution Desk

Contract mismatch is safe and non-destructive. It should not consume a generic
Planner retry budget or create a terminal retry state.

The Resolution Desk should show:

- extracted immutable requirements;
- manifest requirement matrix (matched, missing, ambiguous);
- the exact guard reason and last safe plan/checkpoint;
- a deterministic action: regenerate the plan, amend an ambiguous requirement,
  or reject the candidate.

`Regenerate` creates a durable correction event and a bounded Planner quote.
The user must approve that quote before a paid planning call. Identical failed
clicks are idempotent and never consume retry allowance.

## UI sequence

1. **Pre-freeze preview:** requirement matrix beside the plan.
2. **Freeze blocker:** highlight only the missing matrix rows and disable freeze.
3. **Resolution Desk:** for ambiguity or explicit user amendment; not for a
   deterministic matching failure that can be repaired automatically.
4. **Workspace evidence:** show source-level pass/fail after Builder, separately
   from planning intent.

## Acceptance criteria for this slice

- A valid `exports DagScheduler` plan can freeze without relying on prose regex.
- A planner cannot omit a server-derived API requirement from the frozen hash.
- A workspace that substitutes `schedule()` for `DagScheduler` fails before any
  Reviewer call.
- A repeated contract mismatch produces one bounded recovery choice, not a
  repeated paid repair loop.
- The requirement matrix is visible before any Builder admission.

## Deliberate non-goals

- No trust in a browser-provided contract.
- No automatic source-code mutation by the Resolution Desk.
- No migration of unrelated R8-5 publication work.
