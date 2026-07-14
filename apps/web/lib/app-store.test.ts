import { beforeAll, describe, expect, test } from "bun:test";
import type { ArtifactVersion } from "./artifacts";

// zustand's persist middleware touches localStorage at import time; provide a
// minimal in-memory shim when the runtime has none (bun), then import the store.
type Store = typeof import("./app-store").useAppStore;
let useAppStore: Store;

beforeAll(async () => {
  const g = globalThis as unknown as { localStorage?: Storage };
  if (typeof g.localStorage === "undefined") {
    const mem = new Map<string, string>();
    g.localStorage = {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, String(v)),
      removeItem: (k) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      get length() {
        return mem.size;
      },
    } as Storage;
  }
  ({ useAppStore } = await import("./app-store"));
});

const edit = (over: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  content: "x",
  kind: "code",
  title: "T",
  label: "v2",
  source: "user-edit",
  createdAt: 1,
  ...over,
});

describe("artifact edits (goal 4)", () => {
  test("addArtifactEdit accumulates per thread, per artifact id", () => {
    const tid = useAppStore.getState().activeThreadId;
    useAppStore.getState().addArtifactEdit(tid, "decl:foo", edit({ content: "a" }));
    useAppStore.getState().addArtifactEdit(tid, "decl:foo", edit({ content: "b", label: "v3" }));
    const foo = useAppStore.getState().artifactEdits[tid]?.["decl:foo"] ?? [];
    expect(foo).toHaveLength(2);
    expect(foo[1]!.content).toBe("b");
    expect(foo[1]!.source).toBe("user-edit");
  });

  test("a different artifact id stays separate", () => {
    const tid = useAppStore.getState().activeThreadId;
    useAppStore.getState().addArtifactEdit(tid, "sim:html:abc", edit({ kind: "html" }));
    expect(useAppStore.getState().artifactEdits[tid]?.["sim:html:abc"]).toHaveLength(1);
    // the earlier artifact is untouched
    expect(useAppStore.getState().artifactEdits[tid]?.["decl:foo"]).toHaveLength(2);
  });
});

describe("artifact budget + consent (quota gate)", () => {
  test("recordArtifactSpend creates a budget then accumulates spend", () => {
    const tid = useAppStore.getState().activeThreadId;
    useAppStore.getState().recordArtifactSpend(tid, "decl:rb", 0.02);
    useAppStore.getState().recordArtifactSpend(tid, "decl:rb", 0.03);
    const b = useAppStore.getState().artifactBudgets[tid]?.["decl:rb"];
    expect(b?.spentUsd).toBeCloseTo(0.05);
    expect(b?.windowCalls).toBe(2);
  });

  test("setArtifactConsent persists per artifact", () => {
    const tid = useAppStore.getState().activeThreadId;
    useAppStore.getState().setArtifactConsent(tid, "decl:rb", { granted: true, autoApproveUnderUsd: 0.01 });
    const c = useAppStore.getState().artifactConsents[tid]?.["decl:rb"];
    expect(c?.granted).toBe(true);
    expect(c?.autoApproveUnderUsd).toBe(0.01);
  });
});

describe("managed model pin (mutual exclusivity with BYOK provider)", () => {
  test("pinning a managed model clears the BYOK provider", () => {
    useAppStore.getState().setSelectedProvider("groq");
    expect(useAppStore.getState().selectedProvider).toBe("groq");
    useAppStore.getState().setManagedModel("zintus/llama-3.3-70b");
    // This is what makes the composer's pinned-provider "needs a key" notice
    // impossible for a managed pin: that notice keys off selectedProvider, which
    // is now null. The managed branch shows a quiet "routes via membership" note.
    expect(useAppStore.getState().managedModel).toBe("zintus/llama-3.3-70b");
    expect(useAppStore.getState().selectedProvider).toBeNull();
  });

  test("picking a BYOK provider clears the managed pin", () => {
    useAppStore.getState().setManagedModel("zintus/gpt-4o-mini");
    expect(useAppStore.getState().managedModel).toBe("zintus/gpt-4o-mini");
    useAppStore.getState().setSelectedProvider("gemini");
    expect(useAppStore.getState().selectedProvider).toBe("gemini");
    expect(useAppStore.getState().managedModel).toBeNull();
  });

  test("clearing to Auto (null) drops the managed pin without forcing a provider", () => {
    useAppStore.getState().setManagedModel("zintus/kimi-k2");
    useAppStore.getState().setManagedModel(null);
    expect(useAppStore.getState().managedModel).toBeNull();
  });
});
