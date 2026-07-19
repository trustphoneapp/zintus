import { describe, expect, test } from "bun:test";
import { EngineerLedger } from "./ledger.js";
import { ENGINEER_DEFAULT_ORG_ID } from "./database-schema.js";

/**
 * P12 Finding C (Sol P1-3 / Luna-2) — the single-tenant assumption is now EXPLICIT
 * and ENFORCED: the ledger constructs only for the default org, and any attempt to
 * bind a non-default org is rejected loudly. This does not claim multi-tenant
 * isolation; it makes the single-tenant invariant unbypassable. See
 * docs/zintus-engineer/KNOWN-LIMITATIONS.md.
 */
describe("EngineerLedger single-tenant invariant (Finding C)", () => {
  test("constructs for the default org (baseline)", () => {
    const ledger = new EngineerLedger(":memory:");
    ledger.close();
    const explicitDefault = new EngineerLedger(":memory:", () => new Date(), undefined, ENGINEER_DEFAULT_ORG_ID);
    explicitDefault.close();
  });

  test("RED-without-guard: constructing with a NON-default org is rejected as multi-tenant", () => {
    expect(() => new EngineerLedger(":memory:", () => new Date(), undefined, "some-other-org"))
      .toThrow(/multi-tenant is not yet supported/);
  });
});
