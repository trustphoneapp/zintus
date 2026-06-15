"use client";

import { useEffect } from "react";
import Page from "../_components/Page";
import { useSettingsStore } from "@/lib/store";
import { ROUTING_STRATEGIES } from "@/lib/settings";
import { PROVIDER_BY_ID, PROVIDERS } from "@/lib/providers";
import type { ProviderId, RoutingStrategy } from "@multipleai/types";

export default function SettingsPage() {
  const { settings, hydrated, saved, hydrate, update, clearSaved } = useSettingsStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = window.setTimeout(() => clearSaved(), 2000);
    return () => window.clearTimeout(timer);
  }, [saved, clearSaved]);

  if (!hydrated) {
    return null;
  }

  return (
    <Page
      title="Settings"
      description="Routing strategy and defaults stored in localStorage."
    >
      <div className="card">
        <h2>Routing strategy</h2>
        <div className="strategy-list">
          {ROUTING_STRATEGIES.map((strategy) => (
            <label key={strategy.value} className="strategy-option">
              <input
                type="radio"
                name="strategy"
                checked={settings.routingStrategy === strategy.value}
                onChange={() =>
                  update({ routingStrategy: strategy.value as RoutingStrategy })
                }
              />
              <span>
                <strong>{strategy.label}</strong>
                <small>{strategy.description}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Default provider</h2>
        <label>
          Preferred provider
          <select
            value={settings.defaultProvider ?? ""}
            onChange={(e) =>
              update({
                defaultProvider: e.target.value
                  ? (e.target.value as ProviderId)
                  : undefined,
              })
            }
          >
            <option value="">Auto (priority queue)</option>
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h2>Priority order</h2>
        <ol className="priority-list">
          {settings.providerPriority.map((providerId) => (
            <li key={providerId} style={{ color: PROVIDER_BY_ID[providerId].color }}>
              {PROVIDER_BY_ID[providerId].name}
            </li>
          ))}
        </ol>
      </div>

      {saved ? <p className="status">Settings saved.</p> : null}
    </Page>
  );
}
