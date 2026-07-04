"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_METADATA } from "@zintus/providers";
import { fetchProviderSnapshot, type DesktopProviderInfo } from "@/lib/providers";
import { spendUsdForDays, usageForDays, formatSpend } from "@/lib/spend";
import { isActiveMember, useCloudStore } from "@/lib/store";

/**
 * Usage (approved 2026-07-03 design): the Claude-settings row grammar — name +
 * context on the left, one quota bar with "% used" on the right. Zintus plan
 * first, then every connected provider (its models as indented sub-rows from
 * the local per-turn ledger), then everything else greyed out with Add key.
 * Bars are the gateway's LIVE daily quota ledger; unknown limits say so.
 */

type Range = "today" | "7d" | "30d";
const RANGE_DAYS: Record<Range, number> = { today: 1, "7d": 7, "30d": 30 };

/** Local runtimes: nothing metered, nothing to grey out on "no key". */
const LOCAL_IDS = ["ollama", "lmstudio"] as ProviderId[];

const RECOMMENDED: Partial<Record<string, string>> = {
  openai: "Vision + JSON · gpt-4o-mini from $0.15/1M",
  anthropic: "Claude Haiku 4.5 · quality per $",
};

const OFF_ROWS_COLLAPSED = 4;

function fmtK(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** period_end arrives as epoch seconds from the relay; tolerate ms too. */
function periodEndDate(periodEnd: number): Date {
  return new Date(periodEnd < 1e12 ? periodEnd * 1000 : periodEnd);
}

function Bar({ pct, thin }: { pct: number; thin?: boolean }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color =
    clamped >= 95 ? "var(--color-red)" : clamped >= 75 ? "var(--c-warn)" : "var(--color-purple-bright)";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        flex: 1,
        height: thin ? 4 : 6,
        borderRadius: 99,
        background: "var(--color-elevated)",
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${clamped}%`, height: "100%", borderRadius: 99, background: color }} />
    </div>
  );
}

const pctStyle: React.CSSProperties = {
  minWidth: 76,
  textAlign: "right",
  fontSize: 12,
  color: "var(--color-text-sub)",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const chipStyle = (fg: string, bg: string): React.CSSProperties => ({
  fontSize: 10,
  fontWeight: 700,
  padding: "2px 7px",
  borderRadius: 999,
  marginLeft: 6,
  verticalAlign: 2,
  color: fg,
  background: bg,
});

export default function UsagePage() {
  const [range, setRange] = useState<Range>("today");
  const [providers, setProviders] = useState<DesktopProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAllOff, setShowAllOff] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const { billing, refreshCloud } = useCloudStore();
  const member = isActiveMember(billing);

  async function refresh() {
    const snapshot = await fetchProviderSnapshot();
    setProviders(snapshot.providers);
    setLoaded(true);
    setRefreshedAt(new Date());
  }

  useEffect(() => {
    void refresh();
    void refreshCloud();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refreshCloud]);

  const days = RANGE_DAYS[range];
  // refreshedAt keeps the ledger reads live alongside the poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ledger = useMemo(() => usageForDays(days), [days, refreshedAt]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spend = useMemo(() => spendUsdForDays(days), [days, refreshedAt]);
  const totalTokens = Object.values(ledger.models).reduce((s, m) => s + m.in + m.out, 0);

  const connected = providers.filter((p) => (LOCAL_IDS.includes(p.id) ? p.enabled : p.hasKey));
  const offline = providers.filter((p) => !LOCAL_IDS.includes(p.id) && !p.hasKey);
  const offSorted = [...offline].sort(
    (a, b) => Number(Boolean(RECOMMENDED[b.id])) - Number(Boolean(RECOMMENDED[a.id])),
  );
  const offVisible = showAllOff ? offSorted : offSorted.slice(0, OFF_ROWS_COLLAPSED);

  /** Ledger sub-rows for one provider in the current window. */
  function modelRows(providerId: ProviderId) {
    return Object.entries(ledger.models)
      .filter(([key]) => key.startsWith(`${providerId}·`))
      .map(([key, tokens]) => ({ model: key.slice(providerId.length + 1), tokens }))
      .sort((a, b) => b.tokens.in + b.tokens.out - (a.tokens.in + a.tokens.out));
  }

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 18,
    padding: "13px 4px",
    borderTop: "1px solid var(--color-border)",
  };
  const whoStyle: React.CSSProperties = { width: 236, flexShrink: 0, minWidth: 0 };
  const subStyle: React.CSSProperties = {
    display: "block",
    fontSize: 11.5,
    color: "var(--color-text-muted)",
    marginTop: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  return (
    <div className="scroll" style={{ flex: 1, overflowY: "auto" }}>
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "26px 24px 60px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          width: "100%",
        }}
      >
        {/* ── header + range ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>Usage</h1>
          <div className="seg" style={{ marginLeft: "auto" }} role="tablist" aria-label="Time range">
            {(["today", "7d", "30d"] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={range === r}
                className={range === r ? "on" : undefined}
                onClick={() => setRange(r)}
              >
                {r === "today" ? "Today" : r === "7d" ? "7 days" : "30 days"}
              </button>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--color-text-sub)", margin: 0 }}>
          Spent{" "}
          <b style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}>
            {formatSpend(spend)}
          </b>{" "}
          · <b style={{ color: "var(--color-text)" }}>{ledger.requests}</b> request
          {ledger.requests === 1 ? "" : "s"} ·{" "}
          <b style={{ color: "var(--color-text)" }}>{fmtK(totalTokens)}</b> tokens
          {ledger.savedUsd > 0 ? (
            <>
              {" "}
              · saved{" "}
              <b style={{ color: "var(--color-green)", fontFamily: "var(--font-mono)" }}>
                {formatSpend(ledger.savedUsd)}
              </b>{" "}
              by compression <span style={{ fontFamily: "var(--font-mono)" }}>est</span>
            </>
          ) : null}
        </p>

        {/* ── Zintus plan ── */}
        <div
          style={{
            border: "1px solid color-mix(in srgb, var(--color-purple-bright) 30%, var(--color-border))",
            background: "color-mix(in srgb, var(--color-purple-bright) 6%, var(--color-bg))",
            borderRadius: 12,
            padding: "14px 16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background: "linear-gradient(135deg, var(--color-purple-bright), #8b7bf7)",
                display: "grid",
                placeItems: "center",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              Z
            </span>
            <b style={{ fontSize: 13.5, fontWeight: 700, color: "var(--color-text)" }}>
              {member && billing
                ? `Zintus — ${billing.tier[0]!.toUpperCase()}${billing.tier.slice(1)}`
                : "Zintus membership"}
            </b>
            {member && billing?.period_end ? (
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                resets{" "}
                {periodEndDate(billing.period_end).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            ) : null}
          </div>
          {member && billing && billing.tokens_limit != null && billing.tokens_limit > 0 ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 11 }}>
                <Bar pct={(billing.tokens_used / billing.tokens_limit) * 100} />
                <span style={pctStyle}>
                  {Math.round((billing.tokens_used / billing.tokens_limit) * 100)}% used
                </span>
              </div>
              <p style={{ fontSize: 11.5, color: "var(--color-text-sub)", margin: "7px 0 0" }}>
                {fmtK(Math.max(0, billing.tokens_limit - billing.tokens_used))} of{" "}
                {fmtK(billing.tokens_limit)} plan tokens left · exact counts on every reply
              </p>
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
              <p style={{ fontSize: 11.5, color: "var(--color-text-sub)", margin: 0, flex: 1 }}>
                Managed models, no keys — exact token accounting on every reply.
              </p>
              <Link
                href="/models"
                style={{
                  padding: "6px 12px",
                  borderRadius: 9,
                  background: "var(--color-primary)",
                  color: "var(--color-primary-contrast)",
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: "none",
                  flexShrink: 0,
                }}
              >
                See plans
              </Link>
            </div>
          )}
        </div>

        {/* ── connected providers ── */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)" }}>Your models</div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 1 }}>
            Live daily quota from the gateway ledger; model rows are your own turns in this window.
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
            {!loaded ? (
              <p style={{ fontSize: 12, color: "var(--color-text-muted)", padding: "10px 4px" }}>
                Reading the gateway ledger…
              </p>
            ) : connected.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--color-text-muted)", padding: "10px 4px" }}>
                Nothing connected yet — add a key below or start a local runtime.
              </p>
            ) : null}
            {connected.map((p, index) => {
              const local = LOCAL_IDS.includes(p.id);
              const pct =
                p.quotaLimit != null && p.quotaLimit > 0 ? (p.quotaUsed / p.quotaLimit) * 100 : null;
              const models = modelRows(p.id);
              return (
                <div key={p.id}>
                  <div style={{ ...rowStyle, borderTop: index === 0 ? "none" : rowStyle.borderTop }}>
                    <div style={whoStyle}>
                      <b style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--color-text)" }}>
                        {p.name}
                        {local ? (
                          <span style={chipStyle("var(--color-green)", "color-mix(in srgb, var(--color-green) 12%, transparent)")}>
                            on-device
                          </span>
                        ) : null}
                        {p.inCooldown ? (
                          <span style={chipStyle("var(--c-warn)", "color-mix(in srgb, var(--c-warn) 14%, transparent)")}>
                            cooldown
                          </span>
                        ) : null}
                      </b>
                      <span style={subStyle}>
                        {local
                          ? "Runs on this machine · nothing metered"
                          : p.quotaLimit != null
                            ? `${fmtK(p.quotaUsed)} of ${fmtK(p.quotaLimit)} today · resets daily`
                            : "Your key · no published limit"}
                      </span>
                    </div>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      {local ? (
                        <>
                          <div style={{ flex: 1, height: 6, borderRadius: 99, background: "var(--color-elevated)" }} />
                          <span style={{ ...pctStyle, color: "var(--color-green)" }}>unlimited</span>
                        </>
                      ) : pct != null ? (
                        <>
                          <Bar pct={pct} />
                          <span style={pctStyle}>{Math.round(pct)}% used</span>
                        </>
                      ) : (
                        <>
                          <div style={{ flex: 1, height: 6, borderRadius: 99, background: "var(--color-elevated)" }} />
                          <span style={{ ...pctStyle, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                            limit unknown
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {models.map(({ model, tokens }) => {
                    const share =
                      p.quotaLimit != null && p.quotaLimit > 0
                        ? ((tokens.in + tokens.out) / p.quotaLimit) * 100
                        : null;
                    return (
                      <div
                        key={model}
                        style={{ display: "flex", alignItems: "center", gap: 18, padding: "5px 4px 5px 18px" }}
                      >
                        <div style={{ width: 218, flexShrink: 0, minWidth: 0 }}>
                          <b
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              color: "var(--color-text-sub)",
                              fontFamily: "var(--font-mono)",
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {model}
                          </b>
                        </div>
                        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                          {share != null ? <Bar pct={share} thin /> : <div style={{ flex: 1 }} />}
                          <span style={{ ...pctStyle, fontSize: 11, color: "var(--color-text-muted)" }}>
                            {fmtK(tokens.in + tokens.out)} tok
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── not connected ── */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)" }}>Not connected</div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 1 }}>
            Greyed out until a key is added — the router never counts on what can&apos;t serve.
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
            {offVisible.map((p, index) => (
              <div key={p.id} style={{ ...rowStyle, borderTop: index === 0 ? "none" : rowStyle.borderTop }}>
                <div style={whoStyle}>
                  <b style={{ display: "block", fontSize: 13.5, fontWeight: 500, color: "var(--color-text-muted)" }}>
                    {PROVIDER_METADATA[p.id]?.name ?? p.name}
                    {RECOMMENDED[p.id] ? (
                      <span style={chipStyle("var(--color-purple-bright)", "var(--color-purple-faint)")}>
                        Recommended
                      </span>
                    ) : null}
                  </b>
                  <span style={subStyle}>
                    {RECOMMENDED[p.id] ?? PROVIDER_METADATA[p.id]?.description ?? ""}
                  </span>
                </div>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 99, background: "var(--color-elevated)" }} />
                  <span style={{ ...pctStyle, color: "var(--color-text-muted)" }}>No key</span>
                </div>
                <Link
                  href="/models"
                  className="ghostbtn"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    height: 28,
                    padding: "0 12px",
                    textDecoration: "none",
                    flexShrink: 0,
                  }}
                >
                  Add key
                </Link>
              </div>
            ))}
          </div>
          {!showAllOff && offSorted.length > OFF_ROWS_COLLAPSED ? (
            <button
              type="button"
              className="app-icon-btn"
              onClick={() => setShowAllOff(true)}
              style={{
                padding: "8px 4px",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--color-text-sub)",
                cursor: "pointer",
                border: "none",
              }}
            >
              Show {offSorted.length - OFF_ROWS_COLLAPSED} more providers…
            </button>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--color-text-muted)" }}>
          <span>
            Last updated:{" "}
            {refreshedAt
              ? refreshedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
              : "…"}
          </span>
          <button
            type="button"
            className="app-icon-btn"
            aria-label="Refresh"
            title="Refresh from gateway"
            onClick={() => void refresh()}
            style={{ border: "none", color: "var(--color-text-sub)", cursor: "pointer", padding: "2px 6px" }}
          >
            ⟳
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--color-text-muted)", lineHeight: 1.6, maxWidth: "64ch", margin: 0 }}>
          Bars show real ledger numbers from your local gateway; a provider with no published limit
          says <span style={{ fontFamily: "var(--font-mono)" }}>limit unknown</span> instead of a
          made-up percentage. Dollar values on your-own-key turns are estimates, never a bill.
          Nothing here leaves this machine.
        </p>
      </div>
    </div>
  );
}
