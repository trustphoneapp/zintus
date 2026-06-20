"use client";

import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDERS } from "@/lib/providers";
import { useAppStore } from "@/lib/app-store";
import { getRemainingQuotaPercent } from "@/lib/quota";
import { useProviderStatusStore } from "@/lib/store";
import { Icon } from "./Icons";

type ProviderStatus = "active" | "idle" | "disconnected" | "local";

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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void unlock();
  }, [unlock]);

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
          <Icon name="zap" size={13} />
        )}
        <span>{selected ? selected.name : "Auto-route"}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open ? (
        <div className="composer-picker-menu" role="listbox">
          <button
            type="button"
            className={`composer-picker-option${selectedProvider == null ? " active" : ""}`}
            onClick={() => {
              setSelectedProvider(null);
              setOpen(false);
            }}
          >
            <Icon name="zap" size={13} />
            <span>Auto-route</span>
          </button>
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
