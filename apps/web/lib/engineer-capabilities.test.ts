import { describe, expect, test } from "bun:test";
import type { EngineerManifest } from "./engineer";
import { frozenPlanCapabilities } from "./engineer-capabilities";

const manifest = {
  allowedPaths: ["src/**", "tests/**"], deniedPaths: [".env*"],
  allowedCommands: ["bun test tests/auth.test.ts"], prohibitedCommands: ["git push"],
  humanGateRequired: true,
} as EngineerManifest;

describe("frozen Engineer capability summary", () => {
  test("separates model, file, command, network, Git, and publication authority", () => {
    const capabilities = frozenPlanCapabilities(manifest, { githubConnected: true });
    expect(capabilities.map((item) => item.id)).toEqual([
      "model-reads", "builder-writes", "delete", "commands", "model-network", "local-git", "github",
    ]);
    expect(capabilities.find((item) => item.id === "delete")?.summary).toContain("no dedicated delete tool");
    expect(capabilities.find((item) => item.id === "commands")?.summary).toContain("network disabled");
    expect(capabilities.find((item) => item.id === "model-network")?.summary).toContain("use the network");
    expect(capabilities.find((item) => item.id === "local-git")?.summary).toContain("cannot access Git credentials");
    expect(capabilities.find((item) => item.id === "github")?.summary).toContain("required human approval");
    expect(capabilities.find((item) => item.id === "github")?.summary).toContain("does not merge or deploy");
  });

  test("does not imply GitHub effects when a connector is absent", () => {
    expect(frozenPlanCapabilities(manifest, { githubConnected: false }).at(-1)?.summary).toContain("remains local");
  });
});
