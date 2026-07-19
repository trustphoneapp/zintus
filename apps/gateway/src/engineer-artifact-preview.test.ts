import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalArtifactStore } from "@zintus/engineer";
import { previewEngineerArtifact } from "./engineer-artifact-preview.js";

describe("Engineer artifact preview", () => {
  test("integrity-checks, bounds, redacts, and hides storage paths", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-artifact-preview-"));
    try {
      const store = new LocalArtifactStore({ root, idFactory: () => "artifact-1" });
      const artifact = store.put({ runId: "run-1", type: "COMMAND_STDOUT", bytes: "ok sk-abcdefghijklmnopqrstuvwxyz1234567890 tail", producerType: "EXECUTOR", producerId: "executor", trusted: true });
      const preview = previewEngineerArtifact(store, artifact, 32);
      expect(preview.encoding).toBe("utf8");
      expect(preview.content).toContain("REDACTED");
      expect(preview.content).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(preview.truncated).toBe(true);
      expect(preview.artifact).not.toHaveProperty("storageReference");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("does not expose sensitive or binary artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-artifact-preview-"));
    try {
      const store = new LocalArtifactStore({ root, idFactory: () => "artifact-2" });
      const command = store.put({ runId: "run-2", type: "SUPERVISOR_PR_COMMAND", bytes: "signed-secret", producerType: "SYSTEM", producerId: "supervisor", trusted: true });
      expect(previewEngineerArtifact(store, command).encoding).toBe("unavailable");
      const binary = store.put({ runId: "run-2", type: "COMMAND_STDERR", bytes: new Uint8Array([0xff, 0x00]), producerType: "EXECUTOR", producerId: "executor", trusted: true });
      expect(previewEngineerArtifact(store, binary).encoding).toBe("unavailable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("retains only the bounded prefix but verifies bytes beyond the preview boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-artifact-preview-"));
    try {
      const store = new LocalArtifactStore({ root, idFactory: () => "artifact-large" });
      const bytes = Buffer.alloc((512 * 1024) + 1, 0x61);
      const artifact = store.put({
        runId: "run-large", type: "COMMAND_STDOUT", bytes,
        producerType: "EXECUTOR", producerId: "executor", trusted: true,
      });

      const preview = previewEngineerArtifact(store, artifact);
      expect(Buffer.byteLength(preview.content!, "utf8")).toBe(512 * 1024);
      expect(preview.truncated).toBe(true);

      bytes[bytes.byteLength - 1] = 0x62;
      writeFileSync(artifact.storageReference, bytes);
      expect(() => previewEngineerArtifact(store, artifact)).toThrow("integrity check failed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("uses the strict root-confined reader for optional-hardening previews",()=>{
    const root=mkdtempSync(join(tmpdir(),"zintus-artifact-preview-strict-")),artifactRoot=join(root,"artifacts"),
      outsideRun=join(root,"outside-run");let attack:(()=>void)|null=null;
    try{
      const store=new LocalArtifactStore({root:artifactRoot,afterStrictReadStageForTest:(stage)=>{
        if(stage==="RUN_OPENED")attack?.();}}),artifact=store.put({runId:"strict-preview",type:"COMMAND_STDOUT",
          bytes:"trusted preview",producerType:"EXECUTOR",producerId:"executor",trusted:true}),
        runRoot=dirname(artifact.storageReference),originalRun=join(artifactRoot,"strict-preview-original"),
        digest=artifact.storageReference.split("/").at(-1)!;
      mkdirSync(outsideRun,{recursive:true});writeFileSync(join(outsideRun,digest),"trusted preview");
      attack=()=>{attack=null;renameSync(runRoot,originalRun);symlinkSync(outsideRun,runRoot,"dir");};
      expect(()=>previewEngineerArtifact(store,artifact,32,true)).toThrow("strict path integrity check failed");
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
