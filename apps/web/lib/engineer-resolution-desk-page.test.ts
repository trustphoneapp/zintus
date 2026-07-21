import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "app", "(app)", "engineer", "resolution", "page.tsx"), "utf8");

describe("Resolution Desk page wiring", () => {
  it("consumes only §2/§4-permitted routes via the typed client, plus the existing run projection and readiness projection", () => {
    expect(source).toContain("getEngineerRun(id)");
    expect(source).toContain("listResolutionCases(id)");
    expect(source).toContain("getEngineerBudget(id)");
    expect(source).toContain("getEngineerHardeningReadiness()");
    expect(source).not.toContain("fetch(");
  });

  it("chains directive-create then apply for every decision instead of leaving the case in DIRECTIVE_ISSUED unresolved", () => {
    expect(source).toContain("createResolutionDirective(resolutionCase.caseId");
    expect(source).toContain("applyResolutionDirective(directive.directiveId)");
    expect(source).toContain("getResolutionCaseDetail(resolutionCase.caseId)");
    expect(source).toContain('withMutation("resolution:resume-issued"');
  });

  it("passes caseVersion and sourceRunVersion straight from server-derived state, never a client-invented value", () => {
    expect(source).toContain("caseVersion: resolutionCase.caseVersion");
    expect(source).toContain("sourceRunVersion: run.stateVersion");
  });

  it("locks mutations behind a single action-lock key so a double click cannot start two in-flight resolutions", () => {
    expect(source).toContain("new EngineerActionLock()");
    expect(source).toContain('actionLockRef.current.run("resolution-desk"');
  });

  it("echoes the case's own pricingPolicyDigest (§5a S1) into the corrected-run budget, never a fabricated value", () => {
    expect(source).toContain("replacementBudgetFrom(budgetValue, resolutionCase.pricingPolicyDigest)");
    expect(source).toContain("pricingPolicyDigestAvailable={Boolean(resolutionCase.pricingPolicyDigest)}");
    expect(source).not.toMatch(/pricingPolicyDigest:\s*["'`][^"'`]*["'`]/); // never a literal string constant
  });

  it("gives Resolution Desk mutation errors the same structured cause/next-action/spend treatment as the Publication screen", () => {
    expect(source).toContain("<ResolutionActionError error={actionError} />");
    expect(source).toContain("catch (cause) { setActionError(cause); }");
  });

  it("renders the degraded readiness banner using the existing shared component rather than a bespoke one", () => {
    expect(source).toContain("HardeningReadinessBanner state={readiness}");
  });

  it("renders distinct loading, empty, error, and terminal states", () => {
    expect(source).toContain("Loading the resolution case…");
    expect(source).toContain("<ResolutionEmptyState");
    expect(source).toContain("<ResolutionErrorState");
    expect(source).toContain("<ResolutionTerminalSummary");
    expect(source).toContain("TERMINAL_CASE_STATES.has(resolutionCase.state)");
  });

  it("establishes the memory-only local gateway session before requesting protected Resolution Desk data", () => {
    expect(source).toContain("fetchGatewayConnection, type GatewayConnectionState");
    expect(source).toContain("const connection = await fetchGatewayConnection();");
    expect(source).toContain('if (connection.state !== "connected")');
    expect(source).toContain("Connecting to your local Engineer gateway…");
  });

  it("re-fetches the case after every applied directive so the desk never displays a stale version", () => {
    expect(source).toContain("if (runId) await load(runId);");
  });
});
