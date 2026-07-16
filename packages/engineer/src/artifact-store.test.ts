import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./artifact-store.js";

describe("LocalArtifactStore bounded readers", () => {
  test("streams a large verified artifact in bounded chunks without changing its bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-artifact-stream-"));
    try {
      const store = new LocalArtifactStore({ root, idFactory: () => "artifact-large" });
      const bytes = Buffer.alloc((1024 * 1024) + 2);
      for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
      const artifact = store.put({
        runId: "run-large", type: "COMMAND_STDOUT", bytes,
        producerType: "EXECUTOR", producerId: "executor", trusted: true,
      });

      const chunks: Buffer[] = [];
      for await (const chunk of store.verifiedChunks(artifact, 48 * 1024)) {
        expect(chunk.byteLength).toBeLessThanOrEqual(48 * 1024);
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks)).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails before yielding bytes when the stored artifact was tampered with", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-artifact-stream-"));
    try {
      const store = new LocalArtifactStore({ root, idFactory: () => "artifact-tampered" });
      const artifact = store.put({
        runId: "run-tampered", type: "COMMAND_STDOUT", bytes: Buffer.alloc(700 * 1024, 0x61),
        producerType: "EXECUTOR", producerId: "executor", trusted: true,
      });
      writeFileSync(artifact.storageReference, Buffer.alloc(artifact.sizeBytes, 0x62));

      const iterator = store.verifiedChunks(artifact);
      await expect(iterator.next()).rejects.toThrow("integrity check failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
