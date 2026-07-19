import { describe, expect, test } from "bun:test";
import { normalizeModelCallRowForRowHash } from "./ledger.js";
import { sha256 } from "./hash.js";

/**
 * P12 Finding D — the durable `recordedModelCallRowHash` must be STABLE across the
 * v34 tenancy boundary. The bug: hashing the raw `SELECT *` model_calls row means
 * the write side (pre-v34, no `org_id`) and the rehash/verify side (post-v34, with
 * `org_id`) disagree even though nothing about the model call changed — a spurious
 * HardeningBudgetAuthorityInvalidError on an in-flight AMBIGUOUS reconcile. The fix
 * hashes a normalized projection of ONLY the durable model-call columns on BOTH
 * sides, so the additive `org_id` (and any future additive column) cannot taint it.
 */
describe("model_calls durable row hash — v34-boundary stability (Finding D)", () => {
  const preV34Row: Record<string, unknown> = {
    id: "mc-1", run_id: "run-1", agent_execution_id: "ae-1", logical_tier: "REVIEWER",
    resolved_model: "some-model", prompt_template_version: "engineer-isolated-reviewer-v6",
    input_context_refs_json: '["sha256:aa","sha256:bb"]', output_schema_version: "reviewer-output-v1",
    cache_key: "sha256:cc", cache_hit: 0, latency_ms: 12, input_tokens: 100, output_tokens: 50,
    cached_input_tokens: 0, cache_write_input_tokens: 0, retry_count: 0,
    budget_reservation_id: "res-1", status: "SUCCEEDED", created_at: "2026-07-19T00:00:00.000Z",
  };

  test("the normalized projection hash is IDENTICAL with and without the additive v34 org_id column", () => {
    const postV34Row = { ...preV34Row, org_id: "org-default", retention_class: "STANDARD" };
    const preHash = sha256(normalizeModelCallRowForRowHash(preV34Row));
    const postHash = sha256(normalizeModelCallRowForRowHash(postV34Row));
    expect(postHash).toBe(preHash);
  });

  test("RED-without-fix control: hashing the RAW SELECT * row DOES differ once org_id lands (proving the projection is what stabilizes it)", () => {
    const postV34Row = { ...preV34Row, org_id: "org-default" };
    // The unnormalized raw-row hash (the old behavior) is tainted by org_id...
    expect(sha256(postV34Row)).not.toBe(sha256(preV34Row));
    // ...but the normalized projection is not.
    expect(sha256(normalizeModelCallRowForRowHash(postV34Row))).toBe(sha256(normalizeModelCallRowForRowHash(preV34Row)));
  });

  test("the projection still binds every durable model-call column (a real change to any is reflected)", () => {
    const base = sha256(normalizeModelCallRowForRowHash(preV34Row));
    for (const col of ["id", "run_id", "resolved_model", "input_tokens", "status", "budget_reservation_id"]) {
      const mutated = { ...preV34Row, [col]: `${String(preV34Row[col])}-changed` };
      expect(sha256(normalizeModelCallRowForRowHash(mutated))).not.toBe(base);
    }
  });
});
