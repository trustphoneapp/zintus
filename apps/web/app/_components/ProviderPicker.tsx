"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import { useAppStore } from "@/lib/app-store";
import { useProviderStatusStore } from "@/lib/store";
import { fetchCatalogModels, type CatalogModelDto } from "@/lib/gateway";
import { SELECTED_MODEL_KEY, unpinModel } from "@/lib/pinned-model";
import { useDismissableMenu } from "./useDismissableMenu";
import { Icon } from "./Icons";

/** Models at or below this $/1M input price are the cheap "T0 — Default" tier
 *  the router reaches for first; pricier ones are "T1 — Capable". Mirrors the
 *  derivation used on the Models page (free/local are always T0). */
const T0_MAX_INPUT_PER_1M = 1.0;

/** Compact context-window label, e.g. 1_000_000 → "1M", 128_000 → "128K". */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** "$0.14/M" / "Free" / "Local" — the price label shown on each model row. */
function priceLabel(model: CatalogModelDto): string {
  if (model.local) return "Local";
  if (model.free || model.pricing.input_per_1m === 0) return "Free";
  if (model.pricing.input_per_1m == null) return "—";
  const p = model.pricing.input_per_1m;
  return `$${p < 1 ? p.toFixed(2) : p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}/M`;
}

/** Provider dot colour for a catalog model (by owned_by → provider id). */
function dotColor(ownedBy: string): string {
  return PROVIDER_BY_ID[ownedBy as ProviderId]?.color ?? "var(--color-text-muted)";
}

/** Short provider label for the right side of a model row. */
function providerLabel(ownedBy: string): string {
  return PROVIDER_BY_ID[ownedBy as ProviderId]?.name ?? ownedBy;
}

function isT0(model: CatalogModelDto): boolean {
  if (model.free || model.local) return true;
  const p = model.pricing.input_per_1m;
  return p != null && p <= T0_MAX_INPUT_PER_1M;
}

/**
 * Header model/route pill (design parity). The closed chip shows the active
 * model + an "Auto" badge when the router is auto-routing (no pin); the dropdown
 * lists the real catalog grouped T0 — Default / T1 — Capable. Picking a model
 * pins it (writes `zintus:selected-model`, read by the chat send path) and sets
 * the provider; "Auto" clears the pin and returns to per-message routing.
 */
export function ProviderPicker() {
  const { gatewayConnected, gatewayProviders, setSelectedProvider } = useAppStore();
  const vaultProviders = useProviderStatusStore((s) => s.providers);
  const unlock = useProviderStatusStore((s) => s.unlock);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<CatalogModelDto[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // Default to only models from providers you've connected (have a key for);
  // "Show all free models" reveals the full catalog.
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Make sure the browser key vault is unlocked so connected-provider detection
  // reflects keys stored on this device (not just the gateway's).
  useEffect(() => {
    void unlock();
  }, [unlock]);

  // Provider ids the user has a real KEY for (gateway-side or in the browser
  // vault), plus local runtimes that are up (usable without a key). `available`
  // alone is NOT enough — a provider can be "available" without any key.
  const connectedProviders = useMemo(() => {
    const set = new Set<string>();
    for (const p of gatewayProviders) {
      if (p.hasKey) set.add(p.id);
      if ((p.id === "ollama" || p.id === "lmstudio") && p.available) set.add(p.id);
    }
    for (const v of vaultProviders) {
      if (v.hasKey) set.add(v.id);
    }
    return set;
  }, [gatewayProviders, vaultProviders]);

  // Restore any pinned model after mount (localStorage is client-only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SELECTED_MODEL_KEY);
      if (raw) {
        const sel = JSON.parse(raw) as { id?: string };
        if (sel.id) setPinnedId(sel.id);
      }
    } catch {
      /* ignore malformed storage */
    }
  }, []);

  // Load the catalog when the gateway is reachable (free core; [] when offline).
  useEffect(() => {
    if (!gatewayConnected) {
      setModels([]);
      return;
    }
    let active = true;
    void fetchCatalogModels().then((data) => {
      if (active) setModels(data);
    });
    return () => {
      active = false;
    };
  }, [gatewayConnected]);

  // Escape (restores focus to the pill) + click / focus-out dismissal.
  useDismissableMenu(open, () => setOpen(false), ref);

  const { t0, t1, hiddenCount, connectedCount } = useMemo(() => {
    const all = models
      .filter((m) => m.free || m.local || m.pricing.input_per_1m != null)
      .sort(
        (a, b) =>
          (a.pricing.input_per_1m ?? 0) - (b.pricing.input_per_1m ?? 0),
      );
    const connected = all.filter((m) => connectedProviders.has(m.owned_by));
    // Connected-only by default; "Show all" reveals the rest.
    const visible = showAll ? all : connected;
    return {
      t0: visible.filter(isT0),
      t1: visible.filter((m) => !isT0(m)),
      hiddenCount: showAll ? 0 : all.length - connected.length,
      connectedCount: connected.length,
      totalCount: all.length,
    };
  }, [models, showAll, connectedProviders]);

  // The pinned model (if any), else the cheapest T0 model as the Auto default.
  const pinned = pinnedId ? models.find((m) => m.id === pinnedId) ?? null : null;
  const autoDefault = t0[0] ?? null;
  const shown = pinned ?? autoDefault;

  function pick(model: CatalogModelDto) {
    try {
      localStorage.setItem(
        SELECTED_MODEL_KEY,
        JSON.stringify({ id: model.id, provider: model.owned_by }),
      );
    } catch {
      /* storage unavailable — provider is still set below */
    }
    setSelectedProvider(model.owned_by as ProviderId);
    setPinnedId(model.id);
    setOpen(false);
  }

  function clearPin() {
    unpinModel(setSelectedProvider);
    setPinnedId(null);
    setOpen(false);
  }

  function Row({ model }: { model: CatalogModelDto }) {
    const active = pinnedId === model.id;
    return (
      <button
        type="button"
        className="model-pick-row"
        onClick={() => pick(model)}
        aria-pressed={active}
      >
        <span
          className="model-pick-dot"
          style={{ background: dotColor(model.owned_by) }}
        />
        <span className="model-pick-id">{model.id}</span>
        <span className="model-pick-meta">
          <span className="model-pick-provider">{providerLabel(model.owned_by)}</span>
          <span className="model-pick-sep">·</span>
          <span>{priceLabel(model)}</span>
          <span className="model-pick-sep">·</span>
          <span>{formatContext(model.context_window)} ctx</span>
          {active ? <Icon name="check" size={14} /> : null}
        </span>
      </button>
    );
  }

  // The routing badge ("Auto") is redundant when the name is already "Auto"
  // (no pinned/default model resolved yet) — show only one "Auto" in that case.
  const pillName = shown ? shown.id : "Auto";
  const rawBadge = !pinned ? "Auto" : null;
  const pillBadge =
    rawBadge && rawBadge.toLowerCase() !== pillName.toLowerCase() ? rawBadge : null;

  return (
    <div className="composer-picker" ref={ref}>
      <button
        type="button"
        className="model-pill"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Model & routing"
      >
        <span
          className="model-pill-dot"
          style={{ background: shown ? dotColor(shown.owned_by) : "var(--color-text-muted)" }}
        />
        <span className="model-pill-name">{pillName}</span>
        {pillBadge ? <span className="model-pill-badge">{pillBadge}</span> : null}
        <Icon name="chevron-down" size={13} />
      </button>

      {open ? (
        <div className="model-pick-menu" role="listbox">
          <div className="model-pick-head">
            <Icon name="zap" size={13} />
            <span>Auto-routes per message — or pin one below</span>
          </div>

          <button
            type="button"
            className={`model-pick-auto${!pinned ? " active" : ""}`}
            onClick={clearPin}
          >
            <span aria-hidden>⚡</span>
            <span>Auto</span>
            {!pinned ? <Icon name="check" size={14} /> : null}
          </button>

          {connectedCount === 0 && !showAll ? (
            /* No usable (connected) models → send the user straight to Providers
               & keys to add one. */
            <div className="model-pick-nokeys">
              <span className="model-pick-foot-note">
                No keys added yet — add a provider key to pick a model.
              </span>
              <Link
                href="/providers"
                className="model-pick-addkey"
                onClick={() => setOpen(false)}
              >
                <Icon name="plus" size={14} />
                <span>Add a key</span>
              </Link>
            </div>
          ) : (
            <>
              {t0.length === 0 && t1.length === 0 ? (
                <p className="model-pick-empty">
                  {gatewayConnected
                    ? "No models for your connected providers."
                    : "Start the gateway to load models."}
                </p>
              ) : null}

              {t0.length > 0 ? (
                <>
                  <div className="model-pick-section">T0 — Default</div>
                  {t0.map((m) => (
                    <Row key={m.id} model={m} />
                  ))}
                </>
              ) : null}

              {t1.length > 0 ? (
                <>
                  <div className="model-pick-section">T1 — Capable</div>
                  {t1.map((m) => (
                    <Row key={m.id} model={m} />
                  ))}
                </>
              ) : null}

              {/* Footer always offers adding more keys; the show-all toggle
                  appears when there are models beyond your connected ones. */}
              <div className="model-pick-foot">
                {hiddenCount > 0 || showAll ? (
                  <button
                    type="button"
                    className="model-pick-toggle"
                    onClick={() => setShowAll((v) => !v)}
                  >
                    {showAll
                      ? "Show connected only"
                      : `Show all free models (+${hiddenCount})`}
                  </button>
                ) : null}
                <Link
                  href="/providers"
                  className="model-pick-addkey-link"
                  onClick={() => setOpen(false)}
                >
                  <Icon name="plus" size={13} />
                  <span>Add a key</span>
                </Link>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
