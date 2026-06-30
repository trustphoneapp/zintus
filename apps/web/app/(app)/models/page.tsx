"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/lib/app-store";
import {
  fetchCatalogModels,
  type CatalogModelDto,
} from "@/lib/gateway";
import { Icon } from "@/app/_components/Icons";
import { ModelDetailPanel } from "./ModelDetailPanel";
import { CompareTable } from "./CompareTable";
import {
  formatContext,
  priceSortKey,
  resolveProviderId,
  SELECTED_MODEL_KEY,
  supportsJson,
  type SelectedModel,
} from "./format";

type SortKey = "name" | "price" | "context";
type TierTab = "all" | "T0" | "T1";
type Tier = "T0" | "T1" | null;
const MAX_COMPARE = 3;

// ── Tier derivation ──────────────────────────────────────────────────────────
// The catalog DTO carries no explicit T0/T1 field, so we derive the router's
// "default vs escalate" split from a REAL, defensible price signal:
// `pricing.input_per_1m` (USD per 1M input tokens). Free/local models cost ~$0 at
// the margin → they're the cheap default tier the router reaches for first (T0).
// Priced models at or below the threshold are still cheap-default (T0); above it
// they're the capable models the router only escalates to (T1). An unknown price
// (`null`) yields NO tier — we never invent one to fill the badge.
const T0_MAX_INPUT_PER_1M = 1.0;

function modelTier(m: CatalogModelDto): Tier {
  if (m.free || m.local) return "T0";
  const input = m.pricing.input_per_1m;
  if (input == null) return null;
  return input <= T0_MAX_INPUT_PER_1M ? "T0" : "T1";
}

// USD-per-1M figure → "$0.30" / "$15" (local mirror of format.ts's private `usd`).
function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

// Real price in/out from the catalog. "Free"/"Local"/"—" are honest fallbacks —
// a null on either side never collapses to $0.
function priceInOut(m: CatalogModelDto): string {
  if (m.free) return "Free";
  if (m.local) return "Local";
  const { input_per_1m, output_per_1m } = m.pricing;
  if (input_per_1m == null || output_per_1m == null) return "—";
  return `${usd(input_per_1m)} / ${usd(output_per_1m)}`;
}

// "Best for" — a FACTUAL one-liner derived purely from real catalog fields
// (local/free flags, context window, tier, vision capability). Not a fabricated
// marketing claim; every branch is grounded in a value the catalog reports.
function bestFor(m: CatalogModelDto, tier: Tier): string {
  if (m.local) return "Private, on-device";
  if (m.free) return "Free everyday use";
  if (m.context_window >= 1_000_000) return "Long-context work";
  if (tier === "T1") return "Harder reasoning";
  if (m.capabilities.vision) return "Multimodal turns";
  return "Fast, low-cost turns";
}

// Decorative, deterministic dot hue per provider (purely cosmetic — no data).
function providerDot(owner: string): string {
  let h = 0;
  for (let i = 0; i < owner.length; i += 1) h = (h * 31 + owner.charCodeAt(i)) % 360;
  return `oklch(68% 0.17 ${h})`;
}

const TABLE_COLS = "2.2fr 1.1fr 0.7fr 1.3fr 1fr 1.6fr";

function tierBadgeStyle(tier: Tier): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 30,
    padding: "2px 6px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 700,
  };
  if (tier === "T0") {
    return {
      ...base,
      background: "color-mix(in oklch, var(--color-green) 14%, transparent)",
      color: "var(--color-green)",
    };
  }
  if (tier === "T1") {
    return { ...base, background: "var(--c-accent-light)", color: "var(--c-accent)" };
  }
  return { ...base, background: "transparent", color: "var(--color-text-muted)" };
}

function TierTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "6px 14px",
        borderRadius: 999,
        border: active ? "none" : "0.5px solid var(--c-border)",
        background: active ? "var(--c-accent)" : "var(--color-elevated)",
        color: active ? "#fff" : "var(--color-text-sub)",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

interface Filters {
  provider: string;
  vision: boolean;
  tools: boolean;
  json: boolean;
  free: boolean;
  local: boolean;
}

const EMPTY_FILTERS: Filters = {
  provider: "all",
  vision: false,
  tools: false,
  json: false,
  free: false,
  local: false,
};

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`provider-chip${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
      style={{ cursor: "pointer" }}
    >
      {label}
    </button>
  );
}

export default function ModelsPage() {
  const router = useRouter();
  const gatewayConnected = useAppStore((s) => s.gatewayConnected);
  const gatewayHealthLoaded = useAppStore((s) => s.gatewayHealthLoaded);
  const setSelectedProvider = useAppStore((s) => s.setSelectedProvider);

  const [models, setModels] = useState<CatalogModelDto[] | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [tierTab, setTierTab] = useState<TierTab>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [detail, setDetail] = useState<CatalogModelDto | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Fetch the full catalog once the gateway is reachable. We pull the whole list
  // and filter client-side for instant chip toggles; an offline/erroring gateway
  // yields [] (honest empty state, never fabricated rows).
  useEffect(() => {
    if (!gatewayConnected) {
      setModels(null);
      return;
    }
    let active = true;
    setModels(null);
    void fetchCatalogModels().then((data) => {
      if (active) setModels(data);
    });
    return () => {
      active = false;
    };
  }, [gatewayConnected]);

  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const m of models ?? []) set.add(m.owned_by);
    return [...set].sort();
  }, [models]);

  const visible = useMemo(() => {
    if (!models) return [];
    const q = search.trim().toLowerCase();
    const filtered = models.filter((m) => {
      if (tierTab !== "all" && modelTier(m) !== tierTab) return false;
      if (filters.provider !== "all" && m.owned_by !== filters.provider) return false;
      if (filters.vision && !m.capabilities.vision) return false;
      if (filters.tools && !m.capabilities.tools) return false;
      if (filters.json && !supportsJson(m.capabilities.structured_output)) return false;
      if (filters.free && !m.free) return false;
      if (filters.local && !m.local) return false;
      if (q && !(m.display_name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)))
        return false;
      return true;
    });
    const sorted = [...filtered];
    if (sort === "name") {
      sorted.sort((a, b) => a.display_name.localeCompare(b.display_name));
    } else if (sort === "price") {
      sorted.sort((a, b) => priceSortKey(a) - priceSortKey(b));
    } else {
      sorted.sort((a, b) => b.context_window - a.context_window);
    }
    return sorted;
  }, [models, search, filters, tierTab, sort]);

  const compareModels = useMemo(
    () => (models ?? []).filter((m) => compareIds.includes(m.id)),
    [models, compareIds],
  );

  function toggleCompare(id: string) {
    setCompareIds((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= MAX_COMPARE
          ? prev
          : [...prev, id],
    );
  }

  function handleUse(model: CatalogModelDto) {
    const providerId = resolveProviderId(model.owned_by);
    if (providerId) setSelectedProvider(providerId);
    const payload: SelectedModel = {
      id: model.id,
      provider: providerId ?? model.owned_by,
      displayName: model.display_name,
    };
    try {
      window.localStorage.setItem(SELECTED_MODEL_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage failures — provider is still selected in the store
    }
    router.push("/chat");
  }

  // Until the first health check resolves we don't yet know if the gateway is
  // up — show skeletons rather than a misleading "no models" empty state.
  const loading = !gatewayHealthLoaded || (gatewayConnected && models === null);
  const offline = gatewayHealthLoaded && !gatewayConnected;

  return (
    <div className="screen providers-screen">
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", margin: 0 }}>
          Models
        </h1>
        <p
          style={{
            fontSize: 14.5,
            lineHeight: 1.6,
            color: "var(--color-text-sub)",
            margin: "8px 0 0",
            maxWidth: 600,
          }}
        >
          Every model the router can reach.{" "}
          <strong style={{ color: "var(--color-text)" }}>T0</strong> handles most turns
          cheaply; the router escalates to{" "}
          <strong style={{ color: "var(--color-text)" }}>T1</strong> only when a prompt needs
          it — that&apos;s where your savings come from.
        </p>
      </div>

      {/* Tier tabs */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TierTabButton label="All models" active={tierTab === "all"} onClick={() => setTierTab("all")} />
        <TierTabButton label="T0 · Default" active={tierTab === "T0"} onClick={() => setTierTab("T0")} />
        <TierTabButton label="T1 · Capable" active={tierTab === "T1"} onClick={() => setTierTab("T1")} />
      </div>

      {/* Controls — real catalog search / provider / sort wiring */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <input
          type="search"
          className="sidebar-search"
          style={{ flex: "1 1 220px", maxWidth: 320 }}
          placeholder="Search by name or id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          Provider
          <select value={filters.provider} onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value }))}>
            <option value="all">All</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="name">Name</option>
            <option value="price">Price</option>
            <option value="context">Context</option>
          </select>
        </label>
      </div>

      {/* Capability filter chips — real vision/tools/structured/free/local wiring */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <FilterChip label="Vision" active={filters.vision} onClick={() => setFilters((f) => ({ ...f, vision: !f.vision }))} />
        <FilterChip label="Tools" active={filters.tools} onClick={() => setFilters((f) => ({ ...f, tools: !f.tools }))} />
        <FilterChip label="JSON" active={filters.json} onClick={() => setFilters((f) => ({ ...f, json: !f.json }))} />
        <FilterChip label="Free" active={filters.free} onClick={() => setFilters((f) => ({ ...f, free: !f.free }))} />
        <FilterChip label="Local" active={filters.local} onClick={() => setFilters((f) => ({ ...f, local: !f.local }))} />
      </div>

      {/* States */}
      {offline ? (
        <div className="vault-card" style={{ textAlign: "center", padding: 32 }}>
          <p style={{ fontWeight: 600, margin: 0 }}>Gateway offline</p>
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: "8px 0 0" }}>
            Start your gateway to browse the model catalog —{" "}
            <code>zintus serve</code>.
          </p>
        </div>
      ) : loading ? (
        <div className="providers-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="provider-card provider-card-skeleton" aria-hidden="true">
              <div className="provider-card-top">
                <div>
                  <div className="skeleton-line skeleton-line-title" />
                  <div className="skeleton-line skeleton-line-sub" />
                </div>
                <div className="skeleton-line skeleton-line-badge" />
              </div>
              <div className="skeleton-line skeleton-line-bar" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="vault-card" style={{ textAlign: "center", padding: 32 }}>
          <p style={{ fontWeight: 600, margin: 0 }}>
            {(models ?? []).length === 0 ? "No models available" : "No models match your filters"}
          </p>
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: "8px 0 0" }}>
            {(models ?? []).length === 0
              ? "Your gateway returned an empty catalog."
              : "Try clearing search, filter chips, or a different tier."}
          </p>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            {visible.length} model{visible.length === 1 ? "" : "s"}
          </div>

          {/* Catalog table */}
          <div
            style={{
              border: "0.5px solid var(--c-border)",
              borderRadius: 14,
              overflow: "hidden",
              background: "var(--color-surface)",
            }}
          >
            {/* Header row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: TABLE_COLS,
                gap: 12,
                padding: "11px 18px",
                background: "var(--color-elevated)",
                borderBottom: "0.5px solid var(--c-border)",
                fontSize: 10.5,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                color: "var(--color-text-muted)",
                fontWeight: 700,
              }}
            >
              <span>Model</span>
              <span>Provider</span>
              <span>Tier</span>
              <span>Price in / out</span>
              <span>Context</span>
              <span>Best for</span>
            </div>

            {/* Data rows — clicking opens the detail panel (Use / Compare actions). */}
            {visible.map((m, i) => {
              const tier = modelTier(m);
              return (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetail(m)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDetail(m);
                    }
                  }}
                  onMouseEnter={() => setHoverId(m.id)}
                  onMouseLeave={() => setHoverId((id) => (id === m.id ? null : id))}
                  style={{
                    display: "grid",
                    gridTemplateColumns: TABLE_COLS,
                    gap: 12,
                    padding: "14px 18px",
                    borderBottom: i === visible.length - 1 ? "none" : "0.5px solid var(--c-border)",
                    alignItems: "center",
                    cursor: "pointer",
                    background: hoverId === m.id ? "var(--color-elevated)" : "transparent",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                    <span
                      aria-hidden
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: providerDot(m.owned_by),
                        flexShrink: 0,
                      }}
                    />
                    <span
                      title={m.id}
                      style={{
                        fontSize: 13,
                        color: "var(--color-text)",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.display_name}
                    </span>
                  </span>
                  <span style={{ fontSize: 13, color: "var(--color-text-sub)" }}>{m.owned_by}</span>
                  <span style={tierBadgeStyle(tier)}>{tier ?? "—"}</span>
                  <span style={{ fontSize: 12.5, color: "var(--color-text-sub)" }}>
                    {priceInOut(m)}
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--color-text-sub)" }}>
                    {formatContext(m.context_window)}
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>
                    {bestFor(m, tier)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Compare bar */}
      {compareIds.length > 0 ? (
        <div
          style={{
            position: "sticky",
            bottom: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: "var(--color-elevated)",
            border: "0.5px solid var(--c-border)",
            borderRadius: 12,
          }}
        >
          <Icon name="compare" size={16} />
          <span style={{ fontSize: 13 }}>
            {compareIds.length} selected (max {MAX_COMPARE})
          </span>
          <button
            type="button"
            disabled={compareIds.length < 2}
            onClick={() => setShowCompare(true)}
            style={{ marginLeft: "auto" }}
            title={compareIds.length < 2 ? "Select at least 2 models" : "Compare side by side"}
          >
            Compare
          </button>
          <button type="button" className="secondary" onClick={() => setCompareIds([])}>
            Clear
          </button>
        </div>
      ) : null}

      {detail ? (
        <ModelDetailPanel
          model={detail}
          selectedForCompare={compareIds.includes(detail.id)}
          onClose={() => setDetail(null)}
          onUse={() => handleUse(detail)}
          onToggleCompare={() => toggleCompare(detail.id)}
        />
      ) : null}

      {showCompare && compareModels.length >= 2 ? (
        <CompareTable models={compareModels} onClose={() => setShowCompare(false)} />
      ) : null}
    </div>
  );
}
