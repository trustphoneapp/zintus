"use client";

import { useEffect, useRef, useState } from "react";
import type { ProviderId, RoutingStrategy } from "@zintus/types";
import { PROVIDERS } from "@/lib/providers";
import { useAppStore } from "@/lib/app-store";
import { getRemainingQuotaPercent } from "@/lib/quota";
import { useProviderStatusStore, useSettingsStore } from "@/lib/store";
import { Icon } from "./Icons";

type ProviderStatus = "active" | "idle" | "disconnected" | "local";

/**
 * Auto-routing modes, surfaced first in the picker. Each maps to a real router
 * strategy that is already wired end-to-end (settings.routingStrategy →
 * gateway body.strategy). Selecting one clears any specific-provider override.
 */
const STRATEGY_OPTIONS: Array<{
  strategy: RoutingStrategy;
  icon: string;
  label: string;
}> = [
  { strategy: "fastest", icon: "⚡", label: "Auto (fastest)" },
  { strategy: "economy", icon: "💰", label: "Economy (cheapest)" },
  { strategy: "capability", icon: "🧠", label: "Quality (best model)" },
];

function strategyLabel(strategy: RoutingStrategy): string {
  return (
    STRATEGY_OPTIONS.find((option) => option.strategy === strategy)?.label ??
    "Auto"
  );
}

function strategyIcon(strategy: RoutingStrategy): string {
  return (
    STRATEGY_OPTIONS.find((option) => option.strategy === strategy)?.icon ?? "⚡"
  );
}

function resolveStatus(
  id: ProviderId,
  hasKey: boolean,
  available: boolean,
  activeProvider: ProviderId | null,
): ProviderStatus {
  if (id === "ollama" || id === "lmstudio") {
    return available ? "local" : "idle";
  }
  if (!hasKey) {
    return "disconnected";
  }
  if (activeProvider === id) {
    return "active";
  }
  return available ? "idle" : "disconnected";
}

/**
 * Composer provider selector. Replaces the old full-width provider rail: the
 * model/route control now lives where the user's attention already is — inside
 * the composer — as a chip that opens a popover list. Selection state is the
 * same `selectedProvider` store value as before (null = auto-route).
 */
export function ProviderPicker() {
  const {
    gatewayConnected,
    gatewayProviders,
    activeProvider,
    selectedProvider,
    setSelectedProvider,
  } = useAppStore();
  const { providers: vaultProviders, unlock } = useProviderStatusStore();
  const { settings, hydrate, update } = useSettingsStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
    void unlock();
  }, [hydrate, unlock]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const rows = PROVIDERS.map((provider) => {
    const gateway = gatewayProviders.find((item) => item.id === provider.id);
    const vault = vaultProviders.find((item) => item.id === provider.id);
    const hasKey = gatewayConnected
      ? Boolean(gateway?.hasKey)
      : Boolean(vault?.hasKey) ||
        provider.id === "ollama" ||
        provider.id === "lmstudio";
    const available = gatewayConnected
      ? Boolean(gateway?.available)
      : Boolean(vault?.enabled);
    const quota = gatewayConnected
      ? getRemainingQuotaPercent({
          hasKey,
          available,
          quotaUsed: gateway?.quotaUsed,
          quotaLimit: gateway?.quotaLimit,
        })
      : hasKey
        ? 100
        : 0;
    return {
      ...provider,
      hasKey,
      quota,
      status: resolveStatus(provider.id, hasKey, available, activeProvider),
    };
  });

  const selected = selectedProvider
    ? rows.find((row) => row.id === selectedProvider)
    : null;

  return (
    <div className="composer-picker" ref={ref}>
      <button
        type="button"
        className="composer-picker-chip"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <span
            className={`provider-status-dot ${selected.status}`}
            style={{ background: selected.color }}
          />
        ) : (
          <span aria-hidden>{strategyIcon(settings.routingStrategy)}</span>
        )}
        <span>
          {selected ? selected.name : strategyLabel(settings.routingStrategy)}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open ? (
        <div className="composer-picker-menu" role="listbox">
          <div className="composer-picker-section">Routing</div>
          {STRATEGY_OPTIONS.map((option) => (
            <button
              key={option.strategy}
              type="button"
              className={`composer-picker-option${
                selectedProvider == null &&
                settings.routingStrategy === option.strategy
                  ? " active"
                  : ""
              }`}
              onClick={() => {
                update({ routingStrategy: option.strategy });
                setSelectedProvider(null);
                setOpen(false);
              }}
            >
              <span aria-hidden>{option.icon}</span>
              <span>{option.label}</span>
            </button>
          ))}
          <div className="composer-picker-section">Providers</div>
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`composer-picker-option${selectedProvider === row.id ? " active" : ""}`}
              onClick={() => {
                setSelectedProvider(row.id);
                setOpen(false);
              }}
            >
              <span
                className={`provider-status-dot ${row.status}`}
                style={{ background: row.color }}
              />
              <span className={row.hasKey ? "" : "muted"}>{row.name}</span>
              <span className="composer-picker-quota">
                {row.hasKey ? `${Math.round(row.quota ?? 0)}%` : "no key"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
