"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Brain, RefreshCw, Wrench } from "lucide-react";
import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { isActiveMember, useCloudStore, useSettingsStore } from "@/lib/store";
import { getBudgetUsd, setBudgetUsd } from "@/lib/spend";
import { APP_VERSION, checkForUpdate, type UpdateCheck } from "@/lib/updates";
import { getThemePreference, setThemePreference, type ThemePreference } from "@/lib/theme";
import { openExternal } from "@/lib/tauri";
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
  const { authenticated, email, billing, refreshCloud } = useCloudStore();
  const member = isActiveMember(billing);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [updateState, setUpdateState] = useState<UpdateCheck | "checking" | null>(null);
  const [themePref, setThemePref] = useState<ThemePreference>("system");

  useEffect(() => {
    hydrate();
    void refreshCloud();
    const budget = getBudgetUsd();
    setBudgetDraft(budget != null ? String(budget) : "");
    setThemePref(getThemePreference());
  }, [hydrate, refreshCloud]);

  async function runUpdateCheck() {
    setUpdateState("checking");
    setUpdateState(await checkForUpdate());
  }

  if (!hydrated) {
    return null;
  }

  return (
    <div className="scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
    <div style={{ maxWidth: 760, margin: "0 auto", width: "100%", padding: "22px 24px 60px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Settings</h1>
        <p style={{ fontSize: 12.5, color: "var(--color-text-sub)", margin: "2px 0 0" }}>
          Routing strategy and defaults — applied to chat auto-routing.
        </p>
      </div>

      {/* ── Zintus membership ── */}
      <Card
        style={{
          borderColor: "color-mix(in srgb, var(--color-purple-bright) 30%, var(--color-border))",
          background: "color-mix(in srgb, var(--color-purple-bright) 6%, var(--color-bg))",
        }}
      >
        <CardHeader>
          <CardTitle>Zintus membership</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {member && billing ? (
            <>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>
                {billing.tier[0]!.toUpperCase() + billing.tier.slice(1)} plan · active
                {email ? ` · ${email}` : ""}
              </p>
              {billing.tokens_limit ? (
                <>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      color: "var(--color-text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {(billing.tokens_limit - billing.tokens_used).toLocaleString()} of{" "}
                    {billing.tokens_limit.toLocaleString()} plan tokens left this month
                  </p>
                  <div style={{ height: 5, borderRadius: 99, background: "var(--color-elevated)" }}>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 99,
                        width: `${Math.min(100, Math.round((billing.tokens_used / billing.tokens_limit) * 100))}%`,
                        background: "var(--color-purple-bright)",
                      }}
                    />
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-sub)" }}>
              {authenticated
                ? "Free plan (BYOK) — your own keys, $0 forever. Upgrade for managed models with exact token accounting: Starter $15 · Growth $49 · Scale $99 · Pro $199 /mo."
                : "Not signed in. Sign in from the Models page to join — managed models, no API keys, exact token accounting."}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Link
              href="/models"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px 12px",
                borderRadius: 9,
                border: "none",
                background: "var(--color-primary)",
                color: "var(--color-primary-contrast)",
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              {member ? "Manage membership" : "See plans"}
            </Link>
            <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>
              Referral program: commission accrues per paid referral — payouts coming soon.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Appearance ── */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <b style={{ display: "block", fontSize: 13, fontWeight: 600 }}>Theme</b>
            <span style={{ fontSize: 12, color: "var(--color-text-sub)" }}>
              System follows the OS appearance
            </span>
          </div>
          <div className="seg" style={{ marginLeft: "auto", flexShrink: 0 }}>
            {(["system", "light", "dark"] as const).map((pref) => (
              <button
                key={pref}
                type="button"
                className={themePref === pref ? "on" : undefined}
                style={{ textTransform: "capitalize" }}
                onClick={() => {
                  setThemePreference(pref);
                  setThemePref(pref);
                }}
              >
                {pref}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Memory ── */}
      <Card>
        <CardHeader>
          <CardTitle>Memory</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 14, color: "var(--color-text-sub)" }}>
            What Zintus remembers across chats — stored by your local gateway on this
            machine, never used to train anything. Review, pin, or forget any of it.
          </p>
          <Link
            href="/memory"
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
            <Brain size={14} /> Manage memory
          </Link>
        </CardContent>
      </Card>

      {/* ── Cost ── */}
      <Card>
        <CardHeader>
          <CardTitle>Daily budget</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 14, color: "var(--color-text-sub)" }}>
            Soft cap on estimated BYOK spend per day — the top-bar meter turns amber past
            it. Never blocks a request; it's a warning, not a wall.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--color-text-sub)" }}>$</span>
            <input
              value={budgetDraft}
              onChange={(e) => setBudgetDraft(e.target.value)}
              onBlur={() => {
                const value = Number(budgetDraft);
                setBudgetUsd(Number.isFinite(value) && value > 0 ? value : null);
              }}
              placeholder="No budget set"
              inputMode="decimal"
              aria-label="Daily budget in USD"
              style={{
                width: 120,
                padding: "6px 10px",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                background: "var(--color-bg)",
                color: "var(--color-text)",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
              }}
            />
            <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>
              per day · leave empty for none
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Updates ── */}
      <Card>
        <CardHeader>
          <CardTitle>Updates</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 14, color: "var(--color-text-sub)" }}>
            Version {APP_VERSION}. Checks the Zintus release feed; downloads open in your
            browser. Silent in-app auto-update ships once release signing is live.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void runUpdateCheck()}
              disabled={updateState === "checking"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                background: "var(--color-elevated)",
                color: "var(--color-text)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <RefreshCw size={13} />
              {updateState === "checking" ? "Checking…" : "Check for updates"}
            </button>
            {updateState && updateState !== "checking" ? (
              updateState.status === "current" ? (
                <span style={{ fontSize: 12.5, color: "var(--color-green)" }}>
                  You're on the latest version.
                </span>
              ) : updateState.status === "update" ? (
                <button
                  type="button"
                  onClick={() => void openExternal(updateState.info.url)}
                  style={{
                    border: "none",
                    background: "none",
                    color: "var(--color-purple-bright)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  {updateState.info.version} is available — download ↗
                </button>
              ) : (
                <span style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>
                  Release feed unreachable — try again later.
                </span>
              )
            ) : null}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              paddingTop: 11,
              borderTop: "1px solid var(--color-border)",
            }}
          >
            <div>
              <b style={{ display: "block", fontSize: 13, fontWeight: 600 }}>Keyboard shortcuts</b>
              <span style={{ fontSize: 12, color: "var(--color-text-sub)" }}>
                Every shortcut in one place
              </span>
            </div>
            <button
              type="button"
              className="ghostbtn"
              style={{ marginLeft: "auto", flexShrink: 0 }}
              onClick={() => window.dispatchEvent(new CustomEvent("zintus:shortcuts"))}
            >
              View · ⌘/
            </button>
          </div>
        </CardContent>
      </Card>

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
</div>
  );
}
