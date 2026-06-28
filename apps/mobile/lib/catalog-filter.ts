import type { CatalogModel } from "@zintus/providers";

/**
 * Pure, unit-testable filter/sort/search for the mobile MODEL CATALOG screen.
 *
 * It consumes {@link CatalogModel} straight from `@zintus/providers`'
 * `listCatalogModels()` (the shared source of truth — 37 curated models) and
 * mirrors the WEB `/models` semantics (search by name/id, provider + capability +
 * free filters, sort by name/price/context). NO data is fabricated here: a `null`
 * price sorts last and renders "—" in the UI, never a misleading $0.
 *
 * Kept side-effect-free (no MMKV, no React) so `catalog-filter.test.ts` can
 * exercise every branch directly.
 */

export type CatalogSortKey = "name" | "price" | "context";
export type CatalogCapability = "vision" | "tools" | "json";

export interface CatalogFilters {
  /** Free-text query matched against displayName + id (case-insensitive). */
  search: string;
  /** Provider id to keep, or "all" for every provider. */
  provider: string;
  /** When true, keep only models with a free tier. */
  free: boolean;
  /** Capability toggles — all enabled ones must be supported (AND). */
  capabilities: Record<CatalogCapability, boolean>;
  /** Ordering applied after filtering. */
  sort: CatalogSortKey;
}

/** Default "nothing selected" filter state. */
export const EMPTY_CATALOG_FILTERS: CatalogFilters = {
  search: "",
  provider: "all",
  free: false,
  capabilities: { vision: false, tools: false, json: false },
  sort: "name",
};

/** True when the model can produce structured output of any kind. */
export function modelSupportsJson(model: CatalogModel): boolean {
  return model.structuredOutput !== "none";
}

/**
 * Sort key for price (ascending). A free model sorts first (0); a model with no
 * concrete input price sorts last (+Infinity) — never invented as $0.
 */
export function priceSortKey(model: CatalogModel): number {
  if (model.free) return 0;
  return model.inputPer1M == null ? Number.POSITIVE_INFINITY : model.inputPer1M;
}

/** Distinct provider ids present in a catalog, sorted alphabetically. */
export function catalogProviders(models: readonly CatalogModel[]): string[] {
  return [...new Set(models.map((m) => m.provider))].sort();
}

function matchesCapabilities(
  model: CatalogModel,
  caps: Record<CatalogCapability, boolean>,
): boolean {
  if (caps.vision && !model.vision) return false;
  if (caps.tools && !model.tools) return false;
  if (caps.json && !modelSupportsJson(model)) return false;
  return true;
}

/**
 * Apply search + filters, then sort — a single pure pass mirroring the web
 * catalog. Returns a new array; the input is never mutated.
 */
export function filterAndSortCatalog(
  models: readonly CatalogModel[],
  filters: CatalogFilters,
): CatalogModel[] {
  const q = filters.search.trim().toLowerCase();

  const filtered = models.filter((m) => {
    if (filters.provider !== "all" && m.provider !== filters.provider) {
      return false;
    }
    if (filters.free && !m.free) return false;
    if (!matchesCapabilities(m, filters.capabilities)) return false;
    if (
      q &&
      !m.displayName.toLowerCase().includes(q) &&
      !m.id.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered];
  if (filters.sort === "name") {
    sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
  } else if (filters.sort === "price") {
    // Stable tie-break by name so equal-priced models keep a deterministic order.
    sorted.sort(
      (a, b) =>
        priceSortKey(a) - priceSortKey(b) ||
        a.displayName.localeCompare(b.displayName),
    );
  } else {
    sorted.sort(
      (a, b) =>
        b.contextWindow - a.contextWindow ||
        a.displayName.localeCompare(b.displayName),
    );
  }
  return sorted;
}

/** Compact context-window label, e.g. 1_000_000 → "1M", 128_000 → "128K". */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** USD-per-1M figure → "$0.30" / "$15". Caller handles the `null` case. */
function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

export type PriceTone = "free" | "local" | "unknown" | "priced";

export interface PriceLabel {
  /** Headline word/figure shown on the row. */
  headline: string;
  /** Optional "$0.30 in · $2.50 out / 1M" detail line. */
  detail?: string;
  tone: PriceTone;
}

/**
 * Honest price label for a catalog model. NEVER renders $0 for an unknown price:
 * a `null` on either side collapses to "—" (unknown). "Free"/"Local" are shown
 * only when the corresponding flag is set. Mirrors the web `priceLabel`.
 */
export function priceLabel(model: CatalogModel): PriceLabel {
  if (model.free) return { headline: "Free", tone: "free" };
  if (model.local) return { headline: "Local", tone: "local" };
  if (model.inputPer1M == null || model.outputPer1M == null) {
    return { headline: "—", tone: "unknown" };
  }
  return {
    headline: `${usd(model.inputPer1M)} / 1M in`,
    detail: `${usd(model.inputPer1M)} in · ${usd(model.outputPer1M)} out / 1M`,
    tone: "priced",
  };
}
