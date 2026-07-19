import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "app", "(app)", "engineer", "publication", "page.tsx"), "utf8");

describe("Approval/publication page wiring", () => {
  it("consumes only §3/§4-permitted routes via the typed client, plus the existing readiness projection", () => {
    expect(source).toContain("getPublicationCandidates(id)");
    expect(source).toContain("getEngineerHardeningReadiness()");
    expect(source).not.toContain("fetch(");
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
