import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "app", "(app)", "engineer", "page.tsx"), "utf8");

describe("Engineer live UI lifecycle guards", () => {
  it("preserves the initial snapshot but uses the lightweight projection on hot SSE events", () => {
    expect(source).toContain("getEngineerSnapshot(runId)");
    expect(source).toContain("void refreshLiveSummary(runId)");
    expect(source).not.toContain("setTimeout(() => { refreshTimerRef.current = null; void refresh(runId);");
  });

  it("does not reopen event streams for paused or terminal runs", () => {
    expect(source).toContain('snapshot.status.run.state !== "PAUSED_BUDGET" && !TERMINAL.has(snapshot.status.run.state)');
    expect(source).toContain("watch(resumed.runId, latestSequence)");
  });

  it("invalidates artifact preview state and remounts the viewer when run identity changes", () => {
    expect(source).toContain("requestGeneration.current += 1");
    expect(source).toContain("setSelected(null)");
    expect(source).toContain("setPreview(null)");
    expect(source).toContain("<ArtifactViewer key={run.runId}");
  });

  it("locks a budget top-up synchronously and exposes an applying state", () => {
    expect(source).toContain("if (!run || !budget || topUpPendingRef.current) return");
    expect(source).toContain("topUpPendingRef.current = true");
    expect(source).toContain('"Applying one top-up…"');
    expect(source).toContain("Allowance added once. New ceiling:");
    expect(source).toContain('topUpNotice ? "Prepare another top-up"');
  });
});
