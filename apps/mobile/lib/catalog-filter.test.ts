import { describe, expect, it } from "bun:test";
import type { CatalogModel } from "@zintus/providers";
import { listCatalogModels } from "@zintus/providers";
import {
  EMPTY_CATALOG_FILTERS,
  catalogProviders,
  filterAndSortCatalog,
  formatContext,
  modelSupportsJson,
  priceLabel,
  priceSortKey,
  type CatalogFilters,
} from "./catalog-filter";

/** A minimal CatalogModel for deterministic, isolated assertions. */
function model(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: "m",
    provider: "groq",
    displayName: "Model",
    contextWindow: 128_000,
    vision: false,
    tools: false,
    structuredOutput: "none",
    inputPer1M: null,
    outputPer1M: null,
    free: false,
    local: false,
    dataPolicy: "unknown",
    isProviderDefault: false,
    ...overrides,
  };
}

function filters(overrides: Partial<CatalogFilters>): CatalogFilters {
  return {
    ...EMPTY_CATALOG_FILTERS,
    ...overrides,
    capabilities: {
      ...EMPTY_CATALOG_FILTERS.capabilities,
      ...overrides.capabilities,
    },
  };
}

const SAMPLE: CatalogModel[] = [
  model({ id: "a", displayName: "Alpha Vision", provider: "gemini", vision: true, tools: true, structuredOutput: "json_schema", free: true, contextWindow: 1_000_000 }),
  model({ id: "b", displayName: "Bravo Paid", provider: "mistral", inputPer1M: 2, outputPer1M: 6, contextWindow: 32_000 }),
  model({ id: "c", displayName: "Charlie Cheap", provider: "mistral", inputPer1M: 0.5, outputPer1M: 1, tools: true, contextWindow: 200_000 }),
  model({ id: "d", displayName: "Delta Unknown", provider: "groq", inputPer1M: null, outputPer1M: null, contextWindow: 64_000 }),
];

describe("filterAndSortCatalog — filters", () => {
  it("keeps only free models when free filter is on", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ free: true }));
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });

  it("filters by provider", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ provider: "mistral" }));
    expect(out.map((m) => m.id).sort()).toEqual(["b", "c"]);
  });

  it("filters by capability (vision)", () => {
    const out = filterAndSortCatalog(
      SAMPLE,
      filters({ capabilities: { vision: true, tools: false, json: false } }),
    );
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });

  it("filters by capability (tools, AND-combined)", () => {
    const out = filterAndSortCatalog(
      SAMPLE,
      filters({ capabilities: { vision: false, tools: true, json: false } }),
    );
    expect(out.map((m) => m.id).sort()).toEqual(["a", "c"]);
  });

  it("filters by capability (json/structured output)", () => {
    const out = filterAndSortCatalog(
      SAMPLE,
      filters({ capabilities: { vision: false, tools: false, json: true } }),
    );
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("filterAndSortCatalog — search", () => {
  it("matches by display name (case-insensitive)", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ search: "bravo" }));
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  it("matches by id", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ search: "c" }));
    // "c" appears in id "c" and in "Charlie" / "Vision" display names
    expect(out.map((m) => m.id)).toContain("c");
  });

  it("returns empty for a non-matching query", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ search: "zzz-nope" }));
    expect(out).toEqual([]);
  });
});

describe("filterAndSortCatalog — sort", () => {
  it("sorts by name (A→Z)", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ sort: "name" }));
    expect(out.map((m) => m.displayName)).toEqual([
      "Alpha Vision",
      "Bravo Paid",
      "Charlie Cheap",
      "Delta Unknown",
    ]);
  });

  it("sorts by price ascending: free first, unknown last", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ sort: "price" }));
    expect(out.map((m) => m.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("sorts by context window (largest first)", () => {
    const out = filterAndSortCatalog(SAMPLE, filters({ sort: "context" }));
    expect(out.map((m) => m.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [...SAMPLE];
    filterAndSortCatalog(input, filters({ sort: "price" }));
    expect(input.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("priceSortKey / priceLabel — honest pricing", () => {
  it("free → 0, unknown → +Infinity", () => {
    expect(priceSortKey(model({ free: true }))).toBe(0);
    expect(priceSortKey(model({ inputPer1M: null }))).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(priceSortKey(model({ inputPer1M: 3 }))).toBe(3);
  });

  it("never fabricates a price: null collapses to '—'", () => {
    expect(priceLabel(model({ inputPer1M: null, outputPer1M: null }))).toEqual({
      headline: "—",
      tone: "unknown",
    });
  });

  it("labels free / local / priced correctly", () => {
    expect(priceLabel(model({ free: true })).tone).toBe("free");
    expect(priceLabel(model({ local: true })).tone).toBe("local");
    const priced = priceLabel(model({ inputPer1M: 0.5, outputPer1M: 1.5 }));
    expect(priced.tone).toBe("priced");
    expect(priced.headline).toBe("$0.50 / 1M in");
    expect(priced.detail).toBe("$0.50 in · $1.50 out / 1M");
  });
});

describe("helpers", () => {
  it("formatContext compacts token counts", () => {
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(2_000_000)).toBe("2M");
    expect(formatContext(128_000)).toBe("128K");
    expect(formatContext(512)).toBe("512");
  });

  it("modelSupportsJson reflects structuredOutput", () => {
    expect(modelSupportsJson(model({ structuredOutput: "none" }))).toBe(false);
    expect(modelSupportsJson(model({ structuredOutput: "json_object" }))).toBe(true);
    expect(modelSupportsJson(model({ structuredOutput: "json_schema" }))).toBe(true);
  });

  it("catalogProviders returns sorted distinct providers", () => {
    expect(catalogProviders(SAMPLE)).toEqual(["gemini", "groq", "mistral"]);
  });
});

describe("integration with the real shared catalog", () => {
  it("operates over listCatalogModels() without crashing and keeps every model under no filters", () => {
    const all = listCatalogModels();
    expect(all.length).toBeGreaterThan(0);
    const out = filterAndSortCatalog(all, EMPTY_CATALOG_FILTERS);
    expect(out.length).toBe(all.length);
  });

  it("free filter over the real catalog returns only free models", () => {
    const out = filterAndSortCatalog(listCatalogModels(), filters({ free: true }));
    expect(out.every((m) => m.free)).toBe(true);
  });
});
