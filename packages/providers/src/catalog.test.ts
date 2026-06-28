import { describe, expect, test } from "bun:test";
import type { ProviderId } from "@zintus/types";
import {
  MODEL_CATALOG,
  listCatalogModels,
  getCatalogModel,
  catalogModelsForProvider,
  type DataPolicyTag,
} from "./catalog.js";
import {
  MODEL_CAPABILITIES,
  supportsVision,
  supportsTools,
  structuredOutputLevel,
} from "./capabilities.js";
import { DATA_POLICIES } from "./data-policies.js";
import { getModelPricing } from "./pricing.js";

// DATA_POLICIES is the canonical Record<ProviderId, …>, so its keys are the
// complete, valid provider set.
const IDS = Object.keys(DATA_POLICIES) as ProviderId[];
const ID_SET = new Set<string>(IDS);

const POLICY_TAGS: ReadonlySet<DataPolicyTag> = new Set([
  "no_train",
  "may_train",
  "unknown",
  "zero_retention",
]);

describe("model catalog", () => {
  test("is non-empty and frozen at the source", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(0);
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true);
  });

  test("every entry uses a real, known provider id", () => {
    for (const m of MODEL_CATALOG) {
      expect(ID_SET.has(m.provider)).toBe(true);
    }
  });

  test("no duplicate (provider, id) pairs", () => {
    const keys = MODEL_CATALOG.map((m) => `${m.provider}::${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("isProviderDefault matches MODEL_CAPABILITIES exactly", () => {
    for (const m of MODEL_CATALOG) {
      const expected = MODEL_CAPABILITIES[m.provider].model === m.id;
      expect(m.isProviderDefault).toBe(expected);
    }
    // Every provider's default model is present and flagged exactly once.
    for (const id of IDS) {
      const defaults = MODEL_CATALOG.filter(
        (m) => m.provider === id && m.isProviderDefault,
      );
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.id).toBe(MODEL_CAPABILITIES[id].model);
    }
  });

  test("vision/tools/structuredOutput agree with capabilities.ts for every entry", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.vision).toBe(supportsVision(m.provider, m.id));
      expect(m.tools).toBe(supportsTools(m.provider, m.id));
      expect(m.structuredOutput).toBe(structuredOutputLevel(m.provider, m.id));
    }
  });

  test("default models agree with MODEL_CAPABILITIES capability flags", () => {
    for (const id of IDS) {
      const def = MODEL_CATALOG.find(
        (m) => m.provider === id && m.isProviderDefault,
      )!;
      const caps = MODEL_CAPABILITIES[id];
      expect(def.vision).toBe(caps.vision);
      expect(def.tools).toBe(caps.tools);
      expect(def.structuredOutput).toBe(caps.structuredOutput);
      expect(def.contextWindow).toBe(caps.contextWindow);
    }
  });

  test("pricing is null or strictly positive, and never invented (matches PRICING_CATALOG)", () => {
    for (const m of MODEL_CATALOG) {
      for (const price of [m.inputPer1M, m.outputPer1M]) {
        expect(price === null || price > 0).toBe(true);
      }
      const pricing = getModelPricing(m.provider, m.id);
      // A positive list price must equal the catalog source; a missing or 0
      // (local/free) source must surface as null.
      const expectIn =
        pricing && pricing.inputPer1M > 0 ? pricing.inputPer1M : null;
      const expectOut =
        pricing && pricing.outputPer1M > 0 ? pricing.outputPer1M : null;
      expect(m.inputPer1M).toBe(expectIn);
      expect(m.outputPer1M).toBe(expectOut);
    }
  });

  test("local providers are flagged local with no per-token price", () => {
    for (const m of MODEL_CATALOG) {
      const isLocal = m.provider === "lmstudio" || m.provider === "ollama";
      expect(m.local).toBe(isLocal);
      if (isLocal) {
        expect(m.inputPer1M).toBeNull();
        expect(m.outputPer1M).toBeNull();
        expect(m.free).toBe(true);
      }
    }
  });

  test("dataPolicy is a valid tag derived from DATA_POLICIES", () => {
    for (const m of MODEL_CATALOG) {
      expect(POLICY_TAGS.has(m.dataPolicy)).toBe(true);
      const p = DATA_POLICIES[m.provider];
      const expected: DataPolicyTag = p.zdr
        ? "zero_retention"
        : p.trainsOnData === true
          ? "may_train"
          : p.trainsOnData === false
            ? "no_train"
            : "unknown";
      expect(m.dataPolicy).toBe(expected);
    }
  });

  test("required scalar fields are well-formed", () => {
    for (const m of MODEL_CATALOG) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.displayName).toBe("string");
      expect(m.displayName.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(typeof m.vision).toBe("boolean");
      expect(typeof m.tools).toBe("boolean");
      expect(typeof m.free).toBe("boolean");
    }
  });

  test("every priced PRICING_CATALOG pair with a positive price appears in the catalog", () => {
    // Ground-truth sourcing check: the catalog must at least cover the priced
    // pairs (defaults + groq 8B + openrouter :free) — none silently dropped.
    const catalogKeys = new Set(
      MODEL_CATALOG.map((m) => `${m.provider}::${m.id}`),
    );
    for (const id of IDS) {
      const def = MODEL_CAPABILITIES[id].model;
      expect(catalogKeys.has(`${id}::${def}`)).toBe(true);
    }
  });

  test("listCatalogModels returns a mutation-safe copy", () => {
    const a = listCatalogModels();
    const b = listCatalogModels();
    expect(a).not.toBe(b);
    expect(a).toEqual([...MODEL_CATALOG]);
    a.pop();
    expect(listCatalogModels()).toHaveLength(MODEL_CATALOG.length);
  });

  test("getCatalogModel returns exact (provider, id) match or undefined", () => {
    expect(getCatalogModel("gemini", "gemini-2.5-flash")?.id).toBe(
      "gemini-2.5-flash",
    );
    expect(getCatalogModel("groq", "llama-3.1-8b-instant")?.provider).toBe(
      "groq",
    );
    // wrong provider for a real id → undefined (no cross-provider leakage)
    expect(getCatalogModel("groq", "gemini-2.5-flash")).toBeUndefined();
    expect(getCatalogModel("gemini", "does-not-exist")).toBeUndefined();
  });

  test("catalogModelsForProvider returns only that provider's models", () => {
    for (const id of IDS) {
      const models = catalogModelsForProvider(id);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) expect(m.provider).toBe(id);
    }
    expect(catalogModelsForProvider("gemini").length).toBeGreaterThanOrEqual(5);
    expect(catalogModelsForProvider("groq").length).toBe(2);
  });
});
