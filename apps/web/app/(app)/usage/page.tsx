"use client";

import { useEffect, useState } from "react";
import { QuotaBar } from "@/app/_components/QuotaBar";
import { useAppStore } from "@/lib/app-store";
import { fetchGatewayTraces, type GatewayTrace } from "@/lib/gateway";
import { PROVIDERS } from "@/lib/providers";
import { getRemainingQuotaPercent } from "@/lib/quota";
import { useProviderStatusStore } from "@/lib/store";

export default function UsagePage() {
  const { gatewayConnected, gatewayProviders, gatewaySavings } = useAppStore();
  const { providers, passphrase, setPassphrase, unlock } = useProviderStatusStore();
  const [traces, setTraces] = useState<GatewayTrace[]>([]);

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  useEffect(() => {
    if (!gatewayConnected) {
      setTraces([]);
      return;
    }
    let active = true;
    const load = () =>
      fetchGatewayTraces(5).then((next) => {
        if (active) setTraces(next);
      });
    void load();
    const interval = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [gatewayConnected]);

  const rows = PROVIDERS.map((provider) => {
    const gateway = gatewayProviders.find((item) => item.id === provider.id);
    const vault = providers.find((item) => item.id === provider.id);
    const hasKey = gatewayConnected
      ? Boolean(gateway?.hasKey)
      : Boolean(vault?.hasKey) ||
        provider.id === "ollama" ||
        provider.id === "lmstudio";
    const available = gatewayConnected
      ? Boolean(gateway?.available)
      : Boolean(vault?.enabled);
    const inCooldown = gatewayConnected ? Boolean(gateway?.inCooldown) : false;
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
      available,
      inCooldown,
      quota,
    };
  });

  const configured = rows.filter((row) => row.hasKey).length;

  return (
    <div className="screen usage-screen">
      <div className="usage-summary">
        <article className="usage-stat">
          <span className="usage-stat-label">Providers configured</span>
          <strong>{configured}</strong>
          <span>of {rows.length} total</span>
        </article>
        <article className="usage-stat">
          <span className="usage-stat-label">Routing mode</span>
          <strong>{gatewayConnected ? "Gateway" : "Web vault"}</strong>
          <span>{gatewayConnected ? "CLI keychain active" : "Browser keys only"}</span>
        </article>
        <article className="usage-stat">
          <span className="usage-stat-label">Available now</span>
          <strong>{rows.filter((row) => row.available).length}</strong>
          <span>ready to route</span>
        </article>
        <article className="usage-stat">
          <span className="usage-stat-label">Estimated saved</span>
          <strong>
            {gatewayConnected && gatewaySavings
              ? `$${gatewaySavings.estimatedUsdSaved.toFixed(2)}`
              : "—"}
          </strong>
          <span>vs. paid APIs (est.)</span>
        </article>
      </div>

      {!gatewayConnected ? (
        <div className="vault-card">
          <label>
            Vault passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Unlock to view configured providers"
            />
          </label>
        </div>
      ) : null}

      <div className="usage-card">
        <h2>Provider quota</h2>
        <div className="usage-list">
          {rows.map((provider) => (
            <div key={provider.id} className="usage-row">
              <span className="provider-swatch" style={{ background: provider.color }} />
              <span className="usage-row-name">{provider.name}</span>
              <div className="usage-row-bar">
                <QuotaBar value={provider.quota ?? 0} color={provider.color} />
              </div>
              <span className="usage-row-meta">
                {provider.inCooldown ? (
                  <span className="provider-chip cooldown">cooldown</span>
                ) : null}
                {provider.hasKey
                  ? provider.available
                    ? provider.quota == null
                      ? "quota —"
                      : `${provider.quota}% left`
                    : "cooldown"
                  : "no key"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {gatewayConnected &&
      gatewaySavings &&
      gatewaySavings.estimatedUsdSaved > 0 ? (
        <div className="usage-card">
          <h2>Estimated savings by provider</h2>
          <p className="usage-stat-label">
            Free-tier tokens served, valued at paid-API list pricing.{" "}
            {gatewaySavings.note ?? "Estimate, not a guarantee."}
          </p>
          <div className="usage-list">
            {PROVIDERS.filter(
              (provider) => (gatewaySavings.byProvider[provider.id] ?? 0) > 0,
            ).map((provider) => (
              <div key={provider.id} className="usage-row">
                <span
                  className="provider-swatch"
                  style={{ background: provider.color }}
                />
                <span className="usage-row-name">{provider.name}</span>
                <span className="usage-row-meta">
                  ${(gatewaySavings.byProvider[provider.id] ?? 0).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {gatewayConnected && traces.length > 0 ? (
        <div className="usage-card">
          <h2>Recent requests</h2>
          <p className="usage-stat-label">
            Last {traces.length} routes — failover waterfall, winning provider,
            and latency.
          </p>
          <div className="usage-list">
            {traces.map((trace) => {
              const fails = trace.attempts.filter(
                (a) => a.status === "fail",
              ).length;
              return (
                <div key={trace.traceId} className="usage-row">
                  <span className="usage-row-name">
                    {trace.attempts
                      .map(
                        (a) => `${a.providerId}${a.status === "fail" ? "✗" : "✓"}`,
                      )
                      .join(" → ") || "—"}
                  </span>
                  <span className="usage-row-meta">
                    {fails > 0 ? (
                      <span className="provider-chip cooldown">
                        {fails} failover{fails > 1 ? "s" : ""}
                      </span>
                    ) : null}
                    {trace.winner ? `${trace.winner.providerId}` : "—"}
                    {trace.totalLatencyMs != null
                      ? ` · ${trace.totalLatencyMs}ms`
                      : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
