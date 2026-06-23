"use client";

import { useEffect } from "react";
import { useSettingsStore } from "@/lib/store";
import { ROUTING_STRATEGIES } from "@/lib/settings";
import { PROVIDER_BY_ID, PROVIDERS } from "@/lib/providers";
import { signOut } from "@/lib/cloud";
import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";

const CONTEXT_MODES: Array<{
  value: ContextMode;
  label: string;
  description: string;
}> = [
  { value: "fast", label: "Fast", description: "Lowest compile overhead." },
  { value: "smart", label: "Smart", description: "Balanced context quality." },
  { value: "deep", label: "Deep", description: "Most thorough context expansion." },
];

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
    <div className="screen settings-screen">
      <div className="settings-card">
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

      <div className="settings-card">
        <h2>Default provider</h2>
        <label>
          Preferred provider
          <select
            value={settings.defaultProvider ?? ""}
            onChange={(event) =>
              update({
                defaultProvider: event.target.value
                  ? (event.target.value as ProviderId)
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

      <div className="settings-card">
        <h2>Context mode</h2>
        <div className="strategy-list">
          {CONTEXT_MODES.map((mode) => (
            <label key={mode.value} className="strategy-option">
              <input
                type="radio"
                name="context-mode"
                checked={settings.contextMode === mode.value}
                onChange={() => update({ contextMode: mode.value })}
              />
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.description}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <h2>Priority order</h2>
        <ol className="priority-list">
          {settings.providerPriority.map((providerId) => (
            <li key={providerId} style={{ color: PROVIDER_BY_ID[providerId].color }}>
              {PROVIDER_BY_ID[providerId].name}
            </li>
          ))}
        </ol>
      </div>

      <div className="settings-card about-card">
        <h2>About</h2>
        <p>Zintus v0.1.0</p>
        <p className="muted">Client-side free-tier orchestrator</p>
        <p className="muted">Run gateway: <code>bun run dev:gateway</code></p>
      </div>

      <div className="settings-card">
        <h2>Account</h2>
        <button
          className="auth-submit-btn"
          style={{ background: "var(--color-red)" }}
          onClick={async () => {
            await signOut();
            window.location.href = "/login";
          }}
        >
          Sign out
        </button>
      </div>

      {saved ? <p className="status-banner">Settings saved.</p> : null}
    </div>
  );
}
