import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS } from "@zintus/types";
import { PROVIDER_METADATA } from "./provider-metadata.js";
import { listProviders, createProvider } from "./factory.js";

// Drift guard: PROVIDER_METADATA (UI-facing) must stay consistent with the
// runtime provider registry. TypeScript enforces the Record<ProviderId,...>
// keying at compile time; these tests catch RUNTIME drift (a renamed color, a
// keyPrefix that no longer matches the validation regex, a local runtime
// mislabeled as training on data). Since 2026-07-02 (P1) the set includes
// paid-BYOK anchors — openai/anthropic/perplexity — declared in manifest.ts.

describe("PROVIDER_METADATA covers exactly the provider set", () => {
  test("keys equal PROVIDER_IDS", () => {
    const metaKeys = Object.keys(PROVIDER_METADATA).sort();
    expect(metaKeys).toEqual([...PROVIDER_IDS].sort());
  });
});

describe("every provider's metadata is well-formed", () => {
  for (const id of PROVIDER_IDS) {
    const meta = PROVIDER_METADATA[id];
    test(`${id}: required fields are non-empty and well-typed`, () => {
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.freeTier.length).toBeGreaterThan(0);
      expect(meta.dataPolicy.length).toBeGreaterThan(0);
      expect(typeof meta.trainsOnData).toBe("boolean");
      expect(meta.keyUrl.startsWith("https://")).toBe(true);
    });
  }
});

describe("metadata matches the runtime provider registry", () => {
  const runtime = new Map(listProviders().map((p) => [p.id, p]));

  for (const id of PROVIDER_IDS) {
    const meta = PROVIDER_METADATA[id];
    const provider = runtime.get(id);

    test(`${id}: name + color match the runtime provider`, () => {
      expect(provider).toBeDefined();
      expect(meta.name).toBe(provider!.name);
      expect(meta.color).toBe(provider!.color);
    });

    test(`${id}: keyPrefix is consistent with the runtime keyRegex`, () => {
      if (meta.autoDetect) {
        // Local runtimes take no key — keyRegex may be null and prefix empty.
        expect(meta.trainsOnData).toBe(false);
        expect(typeof meta.detectPort).toBe("number");
        return;
      }
      // Some remote providers (cohere, mistral, fireworks) have no documented
      // standard prefix — empty keyPrefix is legitimate there. Only when a
      // prefix IS documented must a synthetic key built from it satisfy the
      // provider's own validation regex (this is what catches prefix drift).
      if (meta.keyPrefix.length > 0) {
        const regex = provider!.keyRegex;
        expect(regex).not.toBeNull();
        const sampleKey = meta.keyPrefix + "a".repeat(64);
        expect(regex!.test(sampleKey)).toBe(true);
      }
    });
  }
});

describe("provider factory invariants", () => {
  test("listProviders returns all 12, sorted by ascending priority", () => {
    const providers = listProviders();
    expect(providers.length).toBe(PROVIDER_IDS.length);
    const priorities = providers.map((p) => p.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sorted);
  });

  test("createProvider builds every known provider id", () => {
    for (const id of PROVIDER_IDS) {
      expect(createProvider(id).id).toBe(id);
    }
  });

  test("createProvider throws for an unknown id", () => {
    // Asking for an id outside the provider set must fail loudly rather than
    // return undefined. (openai/anthropic ARE providers since 2026-07-02.)
    expect(() => createProvider("not-a-provider" as never)).toThrow(/Unknown provider/);
  });
});
