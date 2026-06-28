"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Wrench } from "lucide-react";
import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { useSettingsStore } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle } from "../_components/ui/card";

const STRATEGIES: Array<{
  value: RoutingStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "fastest",
    label: "Fastest",
    description:
      "Prefer the provider with the lowest recent p95 latency; falls back to priority order until enough samples exist.",
  },
  {
    value: "capability",
    label: "Capability",
    description: "Prefer higher-capability models first.",
  },
  {
    value: "economy",
    label: "Economy",
    description: "Spread usage across providers with the most remaining quota.",
  },
];

const CONTEXT_MODES: Array<{
  value: ContextMode;
  label: string;
  description: string;
}> = [
  {
    value: "fast",
    label: "Fast",
    description: "Lowest compile latency and context expansion.",
  },
  {
    value: "smart",
    label: "Smart",
    description: "Balanced context depth for most chats.",
  },
  {
    value: "deep",
    label: "Deep",
    description: "Maximum context expansion for complex tasks.",
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
          <CardTitle>Context mode</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {CONTEXT_MODES.map((mode) => (
            <label
              key={mode.value}
              style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}
            >
              <input
                type="radio"
                name="context-mode"
                checked={settings.contextMode === mode.value}
                onChange={() => update({ contextMode: mode.value })}
              />
              <span>
                <strong>{mode.label}</strong>
                <br />
                <small style={{ color: "var(--color-text-muted)" }}>
                  {mode.description}
                </small>
              </span>
            </label>
          ))}
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

      <Card>
        <CardHeader>
          <CardTitle>MCP servers</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 14, color: "var(--color-text-sub)" }}>
            Connect Model Context Protocol tool servers so models can use their
            tools in chat. Your gateway connects and runs the tools — Zintus only
            shows the activity.
          </p>
          <Link
            href="/settings/mcp"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              alignSelf: "flex-start",
              fontSize: 13,
              textDecoration: "none",
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              background: "var(--color-elevated)",
              color: "var(--color-text)",
            }}
          >
            <Wrench size={14} /> Manage MCP servers
          </Link>
        </CardContent>
      </Card>

      <p style={{ fontSize: 12, color: "var(--color-text-muted)", margin: 0 }}>
        Changes are saved automatically and applied to chat auto-routing.
      </p>
    </div>
  );
}
