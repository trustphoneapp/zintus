"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/lib/app-store";
import {
  fetchCatalogModels,
  type CatalogModelDto,
} from "@/lib/gateway";
import { Icon } from "@/app/_components/Icons";
import { ModelCard } from "./ModelCard";
import { ModelDetailPanel } from "./ModelDetailPanel";
import { CompareTable } from "./CompareTable";
import {
  priceSortKey,
  resolveProviderId,
  SELECTED_MODEL_KEY,
  supportsJson,
  type SelectedModel,
} from "./format";

type SortKey = "name" | "price" | "context";
const MAX_COMPARE = 3;

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
  const [sort, setSort] = useState<SortKey>("name");
  const [detail, setDetail] = useState<CatalogModelDto | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

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
  }, [models, search, filters, sort]);

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
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Models</h1>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: "4px 0 0" }}>
          Browse every model your gateway can route to — capabilities, pricing,
          and data policy. Free core; no paywall.
        </p>
      </div>

      {/* Controls */}
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
              : "Try clearing search or filter chips."}
          </p>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            {visible.length} model{visible.length === 1 ? "" : "s"}
          </div>
          <div className="providers-grid">
            {visible.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                selectedForCompare={compareIds.includes(m.id)}
                onOpen={() => setDetail(m)}
                onToggleCompare={() => toggleCompare(m.id)}
              />
            ))}
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
