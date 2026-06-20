"use client";

import { useEffect } from "react";
import type { ProviderId } from "@zintus/types";
import { useProviderStatusStore } from "@/lib/store";

export function ProviderRail() {
  const {
    providers,
    selectedProvider,
    activeProvider,
    refresh,
    setSelectedProvider,
  } = useProviderStatusStore();

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const highlightId = activeProvider ?? selectedProvider;

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "8px 16px",
        borderBottom: "1px solid var(--color-border)",
        overflowX: "auto",
        background: "var(--color-surface)",
      }}
    >
      <button
        type="button"
        onClick={() => setSelectedProvider(null)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 999,
          border: `1px solid ${highlightId == null ? "var(--color-purple-bright)" : "var(--color-border)"}`,
          background:
            highlightId == null ? "var(--color-purple-faint)" : "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--color-text-sub)",
          }}
        >
          auto
        </span>
      </button>
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => setSelectedProvider(p.id as ProviderId)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            border: `1px solid ${highlightId === p.id ? p.color : p.enabled ? "var(--color-border)" : "var(--color-border)"}`,
            background:
              highlightId === p.id
                ? "var(--color-purple-faint)"
                : p.enabled
                  ? "transparent"
                  : "transparent",
            opacity: p.enabled ? 1 : 0.5,
            flexShrink: 0,
            cursor: "pointer",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: p.hasKey ? p.color : "var(--color-text-muted)",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--color-text-sub)",
              textTransform: "capitalize",
            }}
          >
            {p.id}
            {p.inCooldown ? " ⏳" : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
