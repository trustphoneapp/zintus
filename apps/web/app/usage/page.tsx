"use client";

import { useEffect } from "react";
import Page from "../_components/Page";
import { useProviderStatusStore } from "@/lib/store";
import { PROVIDERS } from "@/lib/providers";

export default function UsagePage() {
  const { providers, passphrase, setPassphrase, unlock } = useProviderStatusStore();

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  const rows = providers.length
    ? providers
    : PROVIDERS.map((provider) => ({
        ...provider,
        hasKey: false,
        enabled: provider.id === "ollama",
        quotaUsed: 0,
      }));

  return (
    <Page
      title="Usage"
      description="Provider availability from your encrypted vault. Server-side quota tracking applies per deployment."
    >
      <div className="card">
        <label>
          Vault passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Unlock to view configured providers"
          />
        </label>
      </div>

      <div className="provider-grid">
        {rows.map((provider) => {
          const active = provider.enabled;
          const limit = provider.quotaLimit ?? 1_000_000;
          const used = provider.quotaUsed ?? 0;
          const pct = active && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

          return (
            <article key={provider.id} className="card provider-card">
              <div className="provider-card-header">
                <h2 style={{ color: provider.color }}>{provider.name}</h2>
                <span className={`badge${active ? " ok" : ""}`}>
                  {active ? "Configured" : "Unavailable"}
                </span>
              </div>
              <div className="quota-bar">
                <div
                  className="quota-fill"
                  style={{ width: `${pct}%`, background: provider.color }}
                />
              </div>
              <p className="provider-meta">
                {active
                  ? used > 0
                    ? `${used.toLocaleString()} / ${limit.toLocaleString()} tokens (server)`
                    : "Ready — usage tracked on server"
                  : "Add a key on Providers to enable routing"}
              </p>
            </article>
          );
        })}
      </div>
    </Page>
  );
}
