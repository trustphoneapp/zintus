"use client";

import { useEffect } from "react";
import { useProviderStatusStore } from "@/lib/store";
import { QuotaBar } from "../_components/QuotaBar";

export default function UsagePage() {
  const { providers, refresh } = useProviderStatusStore();

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Usage</h1>
        <p style={{ fontSize: 14, color: "var(--color-text-sub)" }}>
          Live quota from the shared ledger (CLI + desktop use ~/.multipleai/quota.db).
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}
      >
        {providers.map((provider) => (
          <article
            key={provider.id}
            className="card"
            style={{
              padding: 16,
              borderRadius: 12,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
            }}
          >
            <h2 style={{ color: provider.color, margin: "0 0 8px" }}>{provider.name}</h2>
            <QuotaBar
              used={provider.quotaUsed}
              limit={provider.quotaLimit}
              label="Daily tokens"
            />
            <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 8 }}>
              {provider.inCooldown ? "In cooldown" : provider.enabled ? "Available" : "Unavailable"}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
