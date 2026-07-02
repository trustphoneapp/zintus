import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import {
  EXTENDED_PROVIDERS,
  EXTENDED_PROVIDER_IDS,
  extendedCatalogSeeds,
  extendedRuntimeProviders,
} from "./manifest.js";
import { createProvider } from "./factory.js";
import { MODEL_CAPABILITIES, supportsVision } from "./capabilities.js";
import { DATA_POLICIES } from "./data-policies.js";
import { PROVIDER_METADATA } from "./provider-metadata.js";
import { getModelPricing } from "./pricing.js";
import { MODEL_CATALOG } from "./catalog.js";

/** The 12 providers wired before the manifest existed (registry files). */
const ORIGINAL_12: ReadonlySet<ProviderId> = new Set([
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "cohere",
  "mistral",
  "deepseek",
  "fireworks",
  "xai",
  "huggingface",
  "lmstudio",
  "ollama",
]);

// The factory/capabilities/metadata spreads use `as Record<ProviderId, …>`
// casts, so the COMPILER no longer proves completeness for manifest providers.
// This test is the replacement guarantee: every ProviderId that is not one of
// the original 12 MUST have a full manifest entry, or the spread would leave a
// hole the cast hides.
describe("provider manifest completeness", () => {
  const manifestIds = PROVIDER_IDS.filter((id) => !ORIGINAL_12.has(id));

  test("every post-2026-07 ProviderId has a manifest entry", () => {
    for (const id of manifestIds) {
      expect(EXTENDED_PROVIDERS[id], `missing manifest entry for ${id}`).toBeDefined();
    }
    expect(new Set(EXTENDED_PROVIDER_IDS)).toEqual(new Set(manifestIds));
  });

  test("no manifest entry shadows an original registry provider", () => {
    for (const id of EXTENDED_PROVIDER_IDS) {
      expect(ORIGINAL_12.has(id)).toBe(false);
    }
  });

  test("factory serves a runtime provider for EVERY ProviderId", () => {
    for (const id of PROVIDER_IDS) {
      const p = createProvider(id);
      expect(p.id).toBe(id);
      expect(typeof p.streamChat).toBe("function");
      expect(typeof p.validateKey).toBe("function");
    }
  });

  test("registry slices are populated for every manifest provider", () => {
    for (const id of manifestIds) {
      expect(MODEL_CAPABILITIES[id], `capabilities ${id}`).toBeDefined();
      expect(DATA_POLICIES[id], `data policy ${id}`).toBeDefined();
      expect(PROVIDER_METADATA[id], `metadata ${id}`).toBeDefined();
    }
  });

  test("runtime default model, capabilities default, and a catalog seed agree", () => {
    const runtimes = extendedRuntimeProviders();
    for (const id of EXTENDED_PROVIDER_IDS) {
      const entry = EXTENDED_PROVIDERS[id]!;
      expect(runtimes[id]!.defaultModel).toBe(entry.capabilities.model);
      const seedIds = entry.catalogSeeds.map((s) => s.id);
      expect(seedIds).toContain(entry.capabilities.model);
      // The default-model seed's flags must mirror the capabilities entry
      // exactly (catalog honesty: the catalog can never over-claim).
      const defaultSeed = entry.catalogSeeds.find(
        (s) => s.id === entry.capabilities.model,
      )!;
      expect(defaultSeed.vision).toBe(entry.capabilities.vision);
      expect(defaultSeed.tools).toBe(entry.capabilities.tools);
      expect(defaultSeed.structuredOutput).toBe(entry.capabilities.structuredOutput);
    }
  });

  test("a vision-true default is backed by the VISION_MODELS allowlist", () => {
    for (const id of EXTENDED_PROVIDER_IDS) {
      const entry = EXTENDED_PROVIDERS[id]!;
      if (entry.capabilities.vision) {
        expect(
          supportsVision(id, entry.capabilities.model),
          `${id} default is vision:true but not allowlisted — supportsVision(id, model) checks the allowlist only`,
        ).toBe(true);
      }
    }
  });

  test("manifest metadata mirrors the runtime name/color and honest fields", () => {
    for (const id of EXTENDED_PROVIDER_IDS) {
      const entry = EXTENDED_PROVIDERS[id]!;
      expect(entry.metadata.name).toBe(entry.runtime.name);
      expect(entry.metadata.color).toBe(entry.runtime.color);
      expect(entry.metadata.keyUrl).toMatch(/^https:\/\//);
      expect(entry.dataPolicy.policyUrl).toMatch(/^https:\/\//);
      // An "unknown" training policy must surface conservatively in the UI
      // metadata (trainsOnData: true = warn), never as a false all-clear.
      if (entry.dataPolicy.trainsOnData === "unknown") {
        expect(entry.metadata.trainsOnData).toBe(true);
      }
    }
  });

  test("pricing rows and catalog seeds land in the shared registries", () => {
    for (const id of EXTENDED_PROVIDER_IDS) {
      const entry = EXTENDED_PROVIDERS[id]!;
      for (const row of entry.pricing) {
        expect(getModelPricing(id, row.model)).toBeDefined();
      }
    }
    const catalogPairs = new Set(
      MODEL_CATALOG.map((m) => `${m.provider}:${m.id}`),
    );
    for (const [id, seed] of extendedCatalogSeeds()) {
      expect(catalogPairs.has(`${id}:${seed.id}`)).toBe(true);
    }
  });

  test("paid savings anchor is positive for every manifest provider", () => {
    for (const id of EXTENDED_PROVIDER_IDS) {
      expect(EXTENDED_PROVIDERS[id]!.paidEquivalentUsdPerMTok).toBeGreaterThan(0);
    }
  });
});
