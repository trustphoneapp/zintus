"use client";

import { useMemo, useState } from "react";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { PROVIDERS, MODELS, type Model, type Provider } from "@/data/providers";
import { CATALOG_STATS } from "@/data/catalog-stats";
import { TIER_COLORS, contextTokens, priceKey, usd } from "./helpers";

const VIOLET = "var(--marketing-accent)"; // #7C3AED
const GREEN = "#22C55E";

// id → display name, so model rows can show "Anthropic" instead of "anthropic".
const PROVIDER_NAME = new Map(PROVIDERS.map((p) => [p.id, p.name] as const));

const TIER_OPTIONS: Model["tier"][] = ["FREE", "T0", "T1", "T2", "BYOK"];
const MODEL_TYPES = [...new Set(MODELS.map((m) => m.family))].sort();
const PROVIDER_OPTIONS = [...new Set(MODELS.map((m) => m.provider))]
  .map((id) => ({ id, name: PROVIDER_NAME.get(id) ?? id }))
  .sort((a, b) => a.name.localeCompare(b.name));

const PROVIDER_TYPES = [...new Set(PROVIDERS.map((p) => p.type))].sort();

type View = "models" | "providers";
type SortKey = "price" | "context" | "name";

const BADGE_LABEL: Record<Provider["badge"], string> = {
  integrated: "Integrated",
  "add-key": "Add your key",
  "coming-soon": "Coming soon",
};

const BADGE_COLOR: Record<Provider["badge"], string> = {
  integrated: GREEN,
  "add-key": VIOLET,
  "coming-soon": "#94A3B8",
};

function Chip({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        cursor: "pointer",
        borderRadius: 999,
        padding: "5px 12px",
        fontSize: 13,
        fontWeight: 600,
        border: `1px solid ${active ? color ?? VIOLET : "var(--marketing-border)"}`,
        background: active
          ? `color-mix(in oklab, ${color ?? VIOLET} 18%, transparent)`
          : "var(--marketing-surface)",
        color: active ? color ?? "var(--marketing-text)" : "var(--marketing-muted)",
      }}
    >
      {label}
    </button>
  );
}

function TierBadge({ tier }: { tier: Model["tier"] }) {
  const color = TIER_COLORS[tier];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.03em",
        color,
        border: `1px solid color-mix(in oklab, ${color} 40%, transparent)`,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
      }}
    >
      {tier}
    </span>
  );
}

function priceCell(model: Model) {
  if (model.free) {
    return <span style={{ color: GREEN, fontWeight: 600 }}>Free</span>;
  }
  return (
    <span style={{ color: "var(--marketing-text)", fontSize: 13 }}>
      {usd(model.inputPer1M)} in · {usd(model.outputPer1M)} out
      <span style={{ color: "var(--marketing-muted)" }}> / 1M</span>
    </span>
  );
}

export default function CatalogPage() {
  const [view, setView] = useState<View>("models");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("price");
  const [freeOnly, setFreeOnly] = useState(false);
  const [tierFilter, setTierFilter] = useState<Model["tier"] | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");

  const visibleModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = MODELS.filter((m) => {
      if (freeOnly && !m.free) return false;
      if (tierFilter !== "all" && m.tier !== tierFilter) return false;
      if (typeFilter !== "all" && m.family !== typeFilter) return false;
      if (providerFilter !== "all" && m.provider !== providerFilter) return false;
      if (
        q &&
        !m.name.toLowerCase().includes(q) &&
        !(PROVIDER_NAME.get(m.provider) ?? "").toLowerCase().includes(q) &&
        !m.routingTags.some((t) => t.includes(q))
      )
        return false;
      return true;
    });
    rows.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "context") return contextTokens(b.contextWindow) - contextTokens(a.contextWindow);
      return priceKey(a) - priceKey(b); // cheapest first, free === 0
    });
    return rows;
  }, [search, sort, freeOnly, tierFilter, typeFilter, providerFilter]);

  const visibleProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PROVIDERS.filter((p) => {
      if (freeOnly && !p.freetier) return false;
      if (typeFilter !== "all" && p.type !== typeFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.specialty.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [search, freeOnly, typeFilter]);

  const stats = CATALOG_STATS;
  const typeOptions = view === "models" ? MODEL_TYPES : PROVIDER_TYPES;

  return (
    <main className="marketing-page">
      <Navbar />

      <section className="m-section" style={{ paddingBottom: "1rem" }}>
        <div className="m-shell">
          <p className="m-eyebrow">Catalog</p>
          <h1 className="m-title">Providers and models Zintus routes to</h1>
          <p className="m-subtitle">
            {stats.totalProviders} providers · {stats.totalModels} models ·{" "}
            {stats.freeModels} free · {stats.integratedProviders} integrated today, the rest via
            your key.
          </p>

          {/* honest stat strip */}
          <div className="m-stats-grid" style={{ marginTop: "0.5rem" }}>
            {[
              { label: "Providers", value: String(stats.totalProviders) },
              { label: "Models", value: String(stats.totalModels) },
              { label: "Free models", value: String(stats.freeModels) },
              { label: "Max context", value: stats.contextWindowMax },
            ].map((card) => (
              <div className="m-stat-card" key={card.label}>
                <strong>{card.value}</strong>
                <span>{card.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="m-shell">
          {/* view toggle */}
          <div style={{ display: "flex", gap: 8, marginBottom: "1.25rem" }}>
            <Chip label="Models" active={view === "models"} onClick={() => setView("models")} color={VIOLET} />
            <Chip label="Providers" active={view === "providers"} onClick={() => setView("providers")} color={VIOLET} />
          </div>

          {/* controls */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: "1rem" }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={view === "models" ? "Search models, providers, tags" : "Search providers"}
              style={{
                flex: "1 1 240px",
                minWidth: 200,
                height: 40,
                borderRadius: 10,
                padding: "0 14px",
                fontSize: 14,
                color: "var(--marketing-text)",
                background: "var(--marketing-surface)",
                border: "1px solid var(--marketing-border)",
              }}
            />

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--marketing-muted)" }}>
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
              Free only
            </label>

            {view === "models" ? (
              <>
                <select
                  value={providerFilter}
                  onChange={(e) => setProviderFilter(e.target.value)}
                  style={selectStyle}
                  aria-label="Filter by provider"
                >
                  <option value="all">All providers</option>
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  style={selectStyle}
                  aria-label="Sort models"
                >
                  <option value="price">Sort: price (cheapest)</option>
                  <option value="context">Sort: context window</option>
                  <option value="name">Sort: name</option>
                </select>
              </>
            ) : null}

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={selectStyle}
              aria-label="Filter by type"
            >
              <option value="all">{view === "models" ? "All families" : "All types"}</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* tier chips — models only */}
          {view === "models" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "1.25rem" }}>
              <Chip label="All tiers" active={tierFilter === "all"} onClick={() => setTierFilter("all")} color={VIOLET} />
              {TIER_OPTIONS.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  active={tierFilter === t}
                  onClick={() => setTierFilter((cur) => (cur === t ? "all" : t))}
                  color={TIER_COLORS[t]}
                />
              ))}
            </div>
          ) : null}

          {/* ── MODELS view ── */}
          {view === "models" ? (
            <>
              <p style={{ fontSize: 13, color: "var(--marketing-muted)", marginBottom: "0.75rem" }}>
                {visibleModels.length} of {MODELS.length} models
              </p>
              <div className="m-provider-grid">
                {visibleModels.map((m) => (
                  <div className="m-provider-card" key={m.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <h3>{m.name}</h3>
                      <TierBadge tier={m.tier} />
                    </div>
                    <span>{PROVIDER_NAME.get(m.provider) ?? m.provider} · {m.family}</span>
                    <div style={{ marginTop: "0.7rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--marketing-muted)" }}>{m.contextWindow} context</span>
                      {priceCell(m)}
                    </div>
                    <p style={{ margin: "0.6rem 0 0", fontSize: 12.5, color: "var(--marketing-muted)", lineHeight: 1.5 }}>
                      {m.specialty}
                    </p>
                  </div>
                ))}
              </div>
              {visibleModels.length === 0 ? (
                <p style={{ color: "var(--marketing-muted)", marginTop: "1.5rem" }}>
                  No models match these filters.
                </p>
              ) : null}
            </>
          ) : (
            /* ── PROVIDERS view ── */
            <>
              <p style={{ fontSize: 13, color: "var(--marketing-muted)", marginBottom: "0.75rem" }}>
                {visibleProviders.length} of {PROVIDERS.length} providers
              </p>
              <div className="m-provider-grid">
                {visibleProviders.map((p) => (
                  <div className="m-provider-card" key={p.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <h3>{p.name}</h3>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 6,
                          whiteSpace: "nowrap",
                          color: BADGE_COLOR[p.badge],
                          border: `1px solid color-mix(in oklab, ${BADGE_COLOR[p.badge]} 40%, transparent)`,
                          background: `color-mix(in oklab, ${BADGE_COLOR[p.badge]} 14%, transparent)`,
                        }}
                      >
                        {BADGE_LABEL[p.badge]}
                      </span>
                    </div>
                    <span>{p.type} · {p.models}+ models · {p.contextMax} context</span>
                    <p style={{ margin: "0.6rem 0 0", fontSize: 12.5, color: "var(--marketing-muted)", lineHeight: 1.5 }}>
                      {p.specialty}
                    </p>
                    {p.freetier ? (
                      <span style={{ display: "inline-block", marginTop: "0.6rem", fontSize: 11, fontWeight: 600, color: GREEN }}>
                        Free tier
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              {visibleProviders.length === 0 ? (
                <p style={{ color: "var(--marketing-muted)", marginTop: "1.5rem" }}>
                  No providers match these filters.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      <Footer />
    </main>
  );
}

const selectStyle: React.CSSProperties = {
  height: 40,
  borderRadius: 10,
  padding: "0 12px",
  fontSize: 13,
  color: "var(--marketing-text)",
  background: "var(--marketing-surface)",
  border: "1px solid var(--marketing-border)",
};
