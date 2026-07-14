"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAppStore } from "@/lib/app-store";
import { fetchGatewayTraces, type GatewayTrace } from "@/lib/gateway";
import { downloadFile } from "@/lib/download";
import { PROVIDER_BY_ID } from "@/lib/providers";
import { useProviderStatusStore } from "@/lib/store";
import {
  DEFAULT_RETENTION_DAYS,
  fetchGatewayActivity,
  type ActivityFeed,
} from "./usage-activity";

const MONO = "ui-monospace, 'JetBrains Mono', 'SFMono-Regular', Menlo, monospace";

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const cardStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "0.5px solid var(--c-border)",
};

const tableHeadCell: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--color-text-muted)",
  fontWeight: 700,
};

const monoCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12.5,
  color: "var(--color-text-sub)",
};

function fmtUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default function UsagePage() {
  const { gatewayConnected, gatewaySavings } = useAppStore();
  const { passphrase, setPassphrase, unlock } = useProviderStatusStore();
  const [traces, setTraces] = useState<GatewayTrace[]>([]);
  // Durable 30-day feed (GET /v1/activity). `null` feed = not yet loaded /
  // offline; an empty `data` array = connected but nothing recorded yet.
  const [activity, setActivity] = useState<ActivityFeed | null>(null);

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  useEffect(() => {
    if (!gatewayConnected) {
      setTraces([]);
      setActivity(null);
      return;
    }
    let active = true;
    const load = () => {
      void fetchGatewayTraces(5).then((next) => {
        if (active) setTraces(next);
      });
      // Pull a wide window so the monthly tiles/chart/table aggregate the whole
      // retention period, not just the last handful of routes.
      void fetchGatewayActivity(1000).then((next) => {
        if (active) setActivity(next);
      });
    };
    load();
    const interval = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [gatewayConnected]);

  const entries = useMemo(() => activity?.data ?? [], [activity]);
  const retentionDays = activity?.retentionDays ?? DEFAULT_RETENTION_DAYS;

  // --- Stat tiles, chart, and table all derive from the SAME real feed, so the
  // numbers reconcile. Cost is $0 on the free core; saved is the gateway's
  // recorded paid-API list-price estimate (`saved_vs_baseline_usd`). ---
  const stats = useMemo(() => {
    let spent = 0;
    let saved = 0;
    let tokens = 0;
    for (const e of entries) {
      spent += e.cost_usd || 0;
      saved += e.saved_vs_baseline_usd || 0;
      tokens += e.tokens?.total || 0;
    }
    return { spent, saved, tokens, requests: entries.length };
  }, [entries]);

  // Prefer the gateway's authoritative cumulative estimate when the feed is
  // empty (e.g. older entries already pruned) so a real saved total still shows.
  const savedTotal =
    entries.length > 0 ? stats.saved : (gatewaySavings?.estimatedUsdSaved ?? 0);

  const rangeLabel = useMemo(() => {
    if (entries.length === 0) return `Last ${retentionDays} days`;
    const times = entries.map((e) => new Date(e.created_at).getTime());
    const min = new Date(Math.min(...times));
    const max = new Date(Math.max(...times));
    return `${SHORT_DATE.format(min)} – ${SHORT_DATE.format(max)}`;
  }, [entries, retentionDays]);

  // Per-day saved/spent, most recent 14 days (matches the mockup's bar count).
  const chart = useMemo(() => {
    const byDay = new Map<string, { saved: number; spent: number; date: Date }>();
    for (const e of entries) {
      const date = new Date(e.created_at);
      const key = dayKey(date);
      const cur = byDay.get(key) ?? { saved: 0, spent: 0, date };
      cur.saved += e.saved_vs_baseline_usd || 0;
      cur.spent += e.cost_usd || 0;
      byDay.set(key, cur);
    }
    const days = [...byDay.values()]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(-14);
    const max = Math.max(0.0001, ...days.map((d) => d.saved + d.spent));
    const axis: string[] = [];
    if (days.length > 0) {
      const first = days[0];
      const last = days[days.length - 1];
      const mid = days[Math.floor(days.length / 2)];
      if (first) axis.push(SHORT_DATE.format(first.date));
      if (days.length > 2 && mid) axis.push(SHORT_DATE.format(mid.date));
      if (last && last !== first) axis.push(SHORT_DATE.format(last.date));
    }
    return { days, max, axis };
  }, [entries]);

  // Per-model breakdown: Model · Requests · Spent · Saved.
  const tableRows = useMemo(() => {
    const byModel = new Map<
      string,
      { model: string; provider: string | null; reqs: number; spent: number; saved: number }
    >();
    for (const e of entries) {
      const model = e.model ?? "unknown";
      const cur =
        byModel.get(model) ??
        { model, provider: e.provider, reqs: 0, spent: 0, saved: 0 };
      cur.reqs += 1;
      cur.spent += e.cost_usd || 0;
      cur.saved += e.saved_vs_baseline_usd || 0;
      if (!cur.provider && e.provider) cur.provider = e.provider;
      byModel.set(model, cur);
    }
    return [...byModel.values()].sort((a, b) => b.reqs - a.reqs);
  }, [entries]);

  const hasData = entries.length > 0;

  function exportJson() {
    downloadFile(
      "zintus-usage.json",
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          range: rangeLabel,
          totals: { ...stats, savedTotal },
          savings: gatewaySavings ?? null,
          activity: activity?.data ?? [],
          activityRetentionDays: activity?.retentionDays ?? null,
          recentTraces: traces,
        },
        null,
        2,
      ),
      "application/json",
    );
  }

  function exportCsv() {
    const header = "model,provider,requests,spentUsd,savedUsd";
    const lines = tableRows.map(
      (r) =>
        `${r.model},${r.provider ?? ""},${r.reqs},${r.spent.toFixed(4)},${r.saved.toFixed(4)}`,
    );
    downloadFile(
      "zintus-usage.csv",
      [header, ...lines].join("\n"),
      "text/csv",
    );
  }

  const tiles: Array<{ label: string; value: string; accent?: boolean }> = [
    { label: "Spent this month", value: fmtUsd(stats.spent) },
    { label: "Saved vs paid APIs", value: fmtUsd(savedTotal), accent: true },
    { label: "Requests", value: stats.requests.toLocaleString() },
    { label: "Tokens", value: fmtTokens(stats.tokens) },
  ];

  return (
    <div className="screen usage-screen">
      <div className="section-shell section-shell-wide" style={pageStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Usage</h1>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--color-text-muted)",
                fontFamily: MONO,
              }}
            >
              {rangeLabel}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="message-action"
              onClick={exportJson}
              disabled={!hasData}
            >
              Download JSON
            </button>
            <button
              type="button"
              className="message-action"
              onClick={exportCsv}
              disabled={!hasData}
            >
              Download CSV
            </button>
          </div>
        </div>

        {/* 4 stat tiles */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          {tiles.map((tile) => (
            <article
              key={tile.label}
              style={{ ...cardStyle, padding: 16, borderRadius: 13 }}
            >
              <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                {tile.label}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 26,
                  fontWeight: 700,
                  fontFamily: MONO,
                  letterSpacing: "-0.02em",
                  color: tile.accent ? "var(--color-green)" : "var(--color-text)",
                }}
              >
                {tile.value}
              </div>
            </article>
          ))}
        </div>

        {/* Daily savings chart */}
        <div style={{ ...cardStyle, padding: 20, borderRadius: 15 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>Daily savings</span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                color: "var(--color-text-muted)",
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: "var(--color-green)",
                }}
              />
              saved
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: "var(--c-accent)",
                  marginLeft: 8,
                }}
              />
              spent
            </span>
          </div>

          {chart.days.length > 0 ? (
            <>
              <div
                style={{
                  marginTop: 18,
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  height: 150,
                }}
              >
                {chart.days.map((d) => {
                  const savedPct = (d.saved / chart.max) * 100;
                  const spentPct = (d.spent / chart.max) * 100;
                  return (
                    <div
                      key={dayKey(d.date)}
                      title={`${SHORT_DATE.format(d.date)} · saved ${fmtUsd(
                        d.saved,
                      )} · spent ${fmtUsd(d.spent)}`}
                      style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "flex-end",
                        gap: 2,
                        height: "100%",
                      }}
                    >
                      <div
                        style={{
                          height: `${Math.max(savedPct, d.saved > 0 ? 4 : 0)}%`,
                          background: "var(--color-green)",
                          borderRadius: "3px 3px 0 0",
                          opacity: 0.85,
                        }}
                      />
                      <div
                        style={{
                          height: `${Math.max(spentPct, d.spent > 0 ? 4 : 0)}%`,
                          background: "var(--c-accent)",
                          borderRadius: "0 0 3px 3px",
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 10.5,
                  color: "var(--color-text-muted)",
                  fontFamily: MONO,
                }}
              >
                {chart.axis.map((label, i) => (
                  <span key={`${label}-${i}`}>{label}</span>
                ))}
              </div>
            </>
          ) : (
            <p
              className="usage-stat-label"
              style={{ marginTop: 16, marginBottom: 0 }}
            >
              {gatewayConnected
                ? "No usage recorded yet."
                : "Connect the gateway to record durable usage history."}
            </p>
          )}

          <p
            className="usage-stat-label"
            style={{ marginTop: 14, marginBottom: 0 }}
          >
            Savings is an estimate of free-tier tokens valued at paid-API list
            pricing. {gatewaySavings?.note ?? "Estimate, not a guarantee."}
          </p>
        </div>

        {/* By-model table */}
        <div
          style={{
            ...cardStyle,
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr 1.4fr",
              gap: 12,
              padding: "11px 18px",
              background: "var(--color-elevated)",
              borderBottom: "0.5px solid var(--c-border)",
              ...tableHeadCell,
            }}
          >
            <span style={tableHeadCell}>Model</span>
            <span style={tableHeadCell}>Requests</span>
            <span style={tableHeadCell}>Spent</span>
            <span style={tableHeadCell}>Saved</span>
          </div>

          {tableRows.length > 0 ? (
            tableRows.map((row) => {
              const color =
                (row.provider &&
                  PROVIDER_BY_ID[row.provider as keyof typeof PROVIDER_BY_ID]
                    ?.color) ||
                "var(--color-text-muted)";
              return (
                <div
                  key={row.model}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1fr 1fr 1.4fr",
                    gap: 12,
                    padding: "13px 18px",
                    borderBottom: "0.5px solid var(--c-border)",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 12.5,
                        color: "var(--color-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.model}
                    </span>
                  </span>
                  <span style={monoCell}>{row.reqs.toLocaleString()}</span>
                  <span style={monoCell}>{fmtUsd(row.spent)}</span>
                  <span style={{ ...monoCell, color: "var(--color-green)" }}>
                    {fmtUsd(row.saved)}
                  </span>
                </div>
              );
            })
          ) : (
            <div style={{ padding: "16px 18px" }}>
              <p className="usage-stat-label" style={{ margin: 0 }}>
                No usage recorded yet.
              </p>
            </div>
          )}
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
      </div>
    </div>
  );
}
