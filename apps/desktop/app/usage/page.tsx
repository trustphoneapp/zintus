"use client";

import { useEffect } from "react";
import { useProviderStatusStore } from "@/lib/store";
import { QuotaBar } from "../_components/QuotaBar";

export default function UsagePage() {
  const { providers, savings, loaded, refresh } = useProviderStatusStore();

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const savingsByProvider = savings
    ? providers
        .map((provider) => ({
          provider,
          amount: savings.byProvider[provider.id] ?? 0,
        }))
        .filter((entry) => entry.amount > 0)
    : [];

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Usage</h1>
        <p style={{ fontSize: 14, color: "var(--color-text-sub)" }}>
          Live quota from the gateway /health endpoint. The authoritative ledger
          (quota.db) lives on the gateway/CLI host; the desktop only displays it.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        }}
      >
        <article
          className="card"
          style={{
            padding: 16,
            borderRadius: 12,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            Estimated saved
          </span>
          <strong style={{ display: "block", fontSize: 24, marginTop: 4 }}>
            {savings ? `$${savings.estimatedUsdSaved.toFixed(2)}` : "—"}
          </strong>
          <span style={{ fontSize: 12, color: "var(--color-text-sub)" }}>
            vs. paid APIs (est.)
          </span>
        </article>
        <article
          className="card"
          style={{
            padding: 16,
            borderRadius: 12,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            Available now
          </span>
          <strong style={{ display: "block", fontSize: 24, marginTop: 4 }}>
            {providers.filter((provider) => provider.enabled).length}
          </strong>
          <span style={{ fontSize: 12, color: "var(--color-text-sub)" }}>
            of {providers.length} ready to route
          </span>
        </article>
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}
      >
        {!loaded && providers.length === 0
          ? Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                aria-hidden
                style={{
                  height: 120,
                  borderRadius: 12,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                  opacity: 0.5,
                  animation: "pulse 1.4s ease-in-out infinite",
                }}
              />
            ))
          : providers.map((provider) => (
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
                <h2 style={{ color: provider.color, margin: "0 0 8px" }}>
                  {provider.name}
                </h2>
                <QuotaBar
                  used={provider.quotaUsed}
                  limit={provider.quotaLimit}
                  label="Daily tokens"
                />
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--color-text-muted)",
                    marginTop: 8,
                  }}
                >
                  {provider.inCooldown
                    ? "In cooldown"
                    : provider.enabled
                      ? "Available"
                      : "Unavailable"}
                </p>
              </article>
            ))}
      </div>

      {savings && savingsByProvider.length > 0 ? (
        <article
          className="card"
          style={{
            padding: 16,
            borderRadius: 12,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>
            Estimated savings by provider
          </h2>
          <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 0 }}>
            Free-tier tokens served, valued at paid-API list pricing.{" "}
            {savings.note ?? "Estimate, not a guarantee."}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {savingsByProvider.map(({ provider, amount }) => (
              <div
                key={provider.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: provider.color,
                      display: "inline-block",
                    }}
                  />
                  {provider.name}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
                  ${amount.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </article>
      ) : null}
    </div>
  );
}
