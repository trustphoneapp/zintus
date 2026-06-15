"use client";

import { useEffect } from "react";
import type { ProviderId, RoutingStrategy } from "@multipleai/types";
import { PROVIDER_IDS } from "@multipleai/types";
import { useSettingsStore } from "@/lib/store";
import { Button } from "../_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../_components/ui/card";

const STRATEGIES: Array<{
  value: RoutingStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "fastest",
    label: "Fastest",
    description: "Follow configured provider priority order.",
  },
  {
    value: "capability",
    label: "Capability",
    description: "Prefer higher-capability models first.",
  },
  {
    value: "economy",
    label: "Economy",
    description: "Spread usage across providers with most remaining quota.",
  },
];

export default function SettingsPage() {
  const { settings, hydrated, hydrate, update } = useSettingsStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (!hydrated) {
    return null;
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Settings</h1>
        <p style={{ fontSize: 14, color: "var(--color-text-sub)" }}>
          Routing strategy and defaults — applied to chat auto-routing.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Routing strategy</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {STRATEGIES.map((strategy) => (
            <label
              key={strategy.value}
              style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}
            >
              <input
                type="radio"
                name="strategy"
                checked={settings.routingStrategy === strategy.value}
                onChange={() => update({ routingStrategy: strategy.value })}
              />
              <span>
                <strong>{strategy.label}</strong>
                <br />
                <small style={{ color: "var(--color-text-muted)" }}>
                  {strategy.description}
                </small>
              </span>
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default provider</CardTitle>
        </CardHeader>
        <CardContent>
          <select
            value={settings.defaultProvider ?? ""}
            onChange={(e) =>
              update({
                defaultProvider: e.target.value
                  ? (e.target.value as ProviderId)
                  : undefined,
              })
            }
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
          >
            <option value="">Auto (priority queue)</option>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Priority order</CardTitle>
        </CardHeader>
        <CardContent>
          <ol style={{ margin: 0, paddingLeft: 20, color: "var(--color-text-sub)" }}>
            {settings.providerPriority.map((id) => (
              <li key={id} style={{ textTransform: "capitalize", marginBottom: 4 }}>
                {id}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Button type="button" onClick={() => update({})}>
        Saved automatically
      </Button>
    </div>
  );
}
