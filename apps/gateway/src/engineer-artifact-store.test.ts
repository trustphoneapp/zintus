import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineerSupervisor } from "@zintus/engineer";
import { createBoundEngineerArtifactStore } from "./engineer-artifact-store.js";

describe("Engineer artifact authority startup binding", () => {
  test("binds the exact-byte reader before exposing the store", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-gateway-artifacts-"));
    type ArtifactReader = Parameters<EngineerSupervisor["configureArtifactReadAuthority"]>[0];
    const boundReaders: ArtifactReader[] = [];
    const supervisor = {
      configureArtifactReadAuthority(reader: ArtifactReader) {
        expect(boundReaders).toHaveLength(0);
        boundReaders.push(reader);
      },
    } satisfies Pick<EngineerSupervisor, "configureArtifactReadAuthority">;

    try {
      const store = createBoundEngineerArtifactStore(supervisor, root);
      expect(boundReaders).toHaveLength(1);
      expect(boundReaders[0]).toBe(store);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
