import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "app", "(app)", "engineer", "publication", "page.tsx"), "utf8");

describe("Approval/publication page wiring", () => {
  it("consumes only §3/§4-permitted routes via the typed client, plus the existing readiness projection", () => {
    expect(source).toContain("hydratePublicationDesk(id)");
    expect(source).toContain("getEngineerHardeningReadiness()");
    expect(source).not.toContain("fetch(");
  });

  it("R7-2 (FINDING #3): hydrates the durable current publication from the server on load/refresh, restoring publication + approval + selected candidate (React state is not the authority)", () => {
    // The loader reads the server projection and, when a publication is active,
    // restores the full in-flight state instead of dropping to candidates-only.
    expect(source).toContain("hydratePublicationDesk(id)");
    expect(source).toContain("if (current)");
    expect(source).toContain("setPublicationId(current.publicationId)");
    expect(source).toContain("setPublication({ state: current.state");
    expect(source).toContain("setApproval({ approvalId: current.approvalId");
    expect(source).toContain("setSelected({");
  });

  it("never sends a client-supplied checkpointHash mismatch — the selected candidate's own hash is what gets approved", () => {
    expect(source).toContain("checkpointHash: selected.checkpointHash");
  });

  it("distinguishes SELF_APPROVAL and PREFLIGHT_MISMATCH by their server-returned code, not a guessed error string", () => {
    expect(source).toContain('cause.code === "SELF_APPROVAL"');
    expect(source).toContain('cause.code === "PREFLIGHT_MISMATCH"');
  });

  it("locks approval and publish mutations behind a single action-lock key", () => {
    expect(source).toContain("new EngineerActionLock()");
    expect(source).toContain('actionLockRef.current.run("publication-desk"');
  });

  it("polls the read-only publication GET to observe RECONCILING resolving, and never re-issues the publish request itself", () => {
    expect(source).toContain("getPublication(publicationId)");
    expect(source).toContain("window.setInterval(() => void poll(), POLL_INTERVAL_MS)");
    expect(source).not.toContain("createPublication(runId, { approvalId: approval.approvalId, operation: \"BRANCH_PR\" });\n    });\n  }, [runId, approval, withMutation]);\n\n  const disabled");
  });

  it("renders the degraded readiness banner using the existing shared component", () => {
    expect(source).toContain("HardeningReadinessBanner state={readiness}");
  });

  it("renders distinct loading, empty, error, and lineage-labeled candidate states", () => {
    expect(source).toContain("Loading publication candidates…");
    expect(source).toContain("<PublicationEmptyState");
    expect(source).toContain("<PublicationErrorState");
    expect(source).toContain("selected.lineage === \"ORIGINAL\"");
  });
});
